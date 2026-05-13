import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { getBuild, setBuild, patchBuild } from "./builds.js";
import { runInference } from "./inference.js";
import { parseCodegenOutput } from "./codegen.js";
import { createRepo, pushFiles } from "./github.js";
import {
  createApp,
  createAppFromDocrImage,
  pollUntilLive,
} from "./deploy.js";
import { buildViteProject } from "./buildProject.js";
import {
  getRegistryNameOrThrow,
  pushBusyboxStaticImage,
} from "./docr.js";
import { createInferenceProxy } from "./inferenceProxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const PORT = Number(process.env.PORT) || 3001;
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(cors());
/** Same-origin proxy for generated previews — must run before express.json so bodies stream. */
app.use(createInferenceProxy());
app.use(express.json({ limit: "2mb" }));

/**
 * In-memory map for **local preview** deploy mode: buildId → on-disk dist/ folder.
 * The backend serves these folders at `/preview/<buildId>/...` so users can view the generated site
 * without pushing to DOCR / App Platform.
 * @type {Map<string, { dir: string, workRoot: string }>}
 */
const previews = new Map();

function log(buildId, message, detail) {
  const suffix = detail !== undefined && detail !== "" ? ` — ${detail}` : "";
  console.log(`[build ${buildId}] ${message}${suffix}`);
}

function upsertStep(buildId, stepName, status, detail = "") {
  const b = getBuild(buildId);
  if (!b) return;
  const steps = Array.isArray(b.steps) ? [...b.steps] : [];
  const idx = steps.findIndex((s) => s.step === stepName);
  const entry = { step: stepName, status, detail };
  if (idx === -1) steps.push(entry);
  else steps[idx] = entry;
  patchBuild(buildId, { steps });
}

/**
 * @param {object} parsed
 * @param {string} doToken
 * @param {string} githubToken
 * @param {{ omitInferenceProxy?: boolean }} [opts]
 * @returns {{ key: string, value: string }[]}
 */
function resolveBuildTimeEnvs(parsed, doToken, githubToken, opts = {}) {
  const raw = Array.isArray(parsed.env_vars) ? parsed.env_vars : [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e.key !== "string") continue;
    if (opts.omitInferenceProxy && e.key === "VITE_INFERENCE_PROXY") continue;
    let value = "";
    if (e.source === "user_do_token") value = doToken;
    else if (e.source === "user_github_token") value = githubToken;
    else if (typeof e.value === "string") value = e.value;
    out.push({ key: e.key, value });
  }
  if (!out.some((x) => x.key === "VITE_DO_TOKEN")) {
    out.push({ key: "VITE_DO_TOKEN", value: doToken });
  }
  return out;
}

function deployModeFromBody(body) {
  const m = body?.deploy_mode;
  if (m === "github") return "github";
  if (m === "local") return "local";
  return "docr";
}

/**
 * @param {object} body
 * @returns {string | null}
 */
function resolveGithubToken(body) {
  const inline = body?.github_token;
  if (typeof inline === "string" && inline.trim()) return inline.trim();
  const env = process.env.GITHUB_TOKEN || process.env.TIDEAI_GITHUB_TOKEN;
  if (typeof env === "string" && env.trim()) return env.trim();
  return null;
}

/**
 * Optional separate PAT for Container Registry (docker-credentials + image push).
 * Same DigitalOcean team as `do_token` is required so the registry name matches that account.
 * @param {string} userDoToken from POST body
 */
function resolveDocrToken(userDoToken) {
  const env = process.env.TIDEAI_DOCR_TOKEN;
  if (typeof env === "string" && env.trim()) return env.trim();
  return userDoToken;
}

/**
 * PAT for Inference, App Platform, etc. Body field overrides server default (local testing).
 * @param {unknown} bodyToken `req.body.do_token`
 */
function resolveDoToken(bodyToken) {
  if (typeof bodyToken === "string" && bodyToken.trim()) return bodyToken.trim();
  const fromEnv = process.env.TIDEAI_DEFAULT_DO_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return "";
}

/**
 * DOCR repository name (single path segment under your registry).
 * Starter tier allows **only one repository** per registry — each build must push new **tags** to the same repo.
 * @see https://docs.digitalocean.com/products/container-registry/details/pricing/
 */
function resolveDocrRepoName() {
  const raw = (process.env.TIDEAI_DOCR_REPO_NAME || "tideai-apps").trim().toLowerCase();
  const s = raw
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
  return s || "tideai-apps";
}

/**
 * @param {"docr" | "github"} deploy_mode
 * @param {string | null} githubToken
 */
async function runBuildPipeline(buildId, prompt, doToken, deploy_mode, githubToken) {
  try {
    patchBuild(buildId, { status: "inferring", error: null });
    upsertStep(buildId, "Understanding your prompt", "in_progress", "Calling Serverless Inference…");
    log(buildId, "Step: inference started");

    const rawLlm = await runInference(doToken, prompt);
    upsertStep(buildId, "Understanding your prompt", "done", "Prompt understood");
    log(buildId, "Step: inference done");

    patchBuild(buildId, { status: "generating" });
    upsertStep(buildId, "Generating code", "in_progress", "Parsing generated project…");
    log(buildId, "Step: codegen started");

    const parsed = parseCodegenOutput(rawLlm);
    upsertStep(buildId, "Generating code", "done", `${parsed.files.length} files`);
    log(buildId, "Step: codegen done", `${parsed.app_name}`);

    const appSlug =
      String(parsed.app_name)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 90) || `app-${buildId.slice(0, 8)}`;

    if (deploy_mode === "github") {
      patchBuild(buildId, { status: "publishing" });
      upsertStep(buildId, "Creating GitHub repo", "in_progress", `Name: ${appSlug}`);
      log(buildId, "Step: GitHub create repo");

      const { repoFullName, repoUrl } = await createRepo(githubToken, appSlug);
      upsertStep(buildId, "Creating GitHub repo", "done", repoFullName);
      patchBuild(buildId, { repo: repoUrl });
      log(buildId, "Step: GitHub repo created", repoFullName);

      upsertStep(buildId, "Pushing files", "in_progress", "Uploading via GitHub API…");
      log(buildId, "Step: push files started");

      await pushFiles(githubToken, repoFullName, parsed.files);
      upsertStep(buildId, "Pushing files", "done", "All files uploaded");
      log(buildId, "Step: push files done");

      patchBuild(buildId, { status: "deploying" });
      upsertStep(buildId, "Deploying to DigitalOcean", "in_progress", "Creating App Platform app…");
      log(buildId, "Step: DO createApp (GitHub static site)");

      const envVars = resolveBuildTimeEnvs(parsed, doToken, githubToken || "", {
        omitInferenceProxy: true,
      });
      const appId = await createApp(
        doToken,
        repoFullName,
        appSlug,
        envVars,
        parsed.files
      );
      upsertStep(buildId, "Deploying to DigitalOcean", "done", `App ID ${appId}`);
      log(buildId, "Step: DO app created", appId);

      upsertStep(buildId, "Going live...", "in_progress", "Waiting for deployment…");
      log(buildId, "Step: polling until live");

      const url = await pollUntilLive(doToken, appId, (phase) => {
        upsertStep(buildId, "Going live...", "in_progress", `Phase: ${phase}`);
        log(buildId, "DO deployment phase", phase);
      });

      upsertStep(buildId, "Going live...", "done", url);
      patchBuild(buildId, { status: "live", url });
      log(buildId, "Build complete", url);
      return;
    }

    if (deploy_mode === "local") {
      const workRoot = path.join(tmpdir(), "tideai-build", buildId);
      await mkdir(workRoot, { recursive: true });

      patchBuild(buildId, { status: "publishing" });
      upsertStep(buildId, "Building static site", "in_progress", "npm install && npm run build…");
      log(buildId, "Step: Vite build (local preview)");

      const previewPath = `/preview/${buildId}/`;
      const buildEnv = {
        ...process.env,
        VITE_DO_TOKEN: doToken,
        VITE_INFERENCE_PROXY: "/api/inference",
        NODE_ENV: "production",
      };
      /** Vite's `--base` so generated `index.html` references assets at `/preview/<buildId>/assets/...`. */
      const distDir = await buildViteProject(parsed.files, buildEnv, workRoot, {
        base: previewPath,
      });
      upsertStep(buildId, "Building static site", "done", "dist/ ready");
      log(buildId, "Step: Vite build done");

      previews.set(buildId, { dir: distDir, workRoot });
      const url = `http://localhost:${PORT}${previewPath}`;
      patchBuild(buildId, { status: "live", url, repo: previewPath });
      upsertStep(buildId, "Going live...", "done", url);
      log(buildId, "Step: local preview ready", url);
      return;
    }

    /* DOCR path — no GitHub */
    const workRoot = path.join(tmpdir(), "tideai-build", buildId);
    await mkdir(workRoot, { recursive: true });
    try {
      patchBuild(buildId, { status: "publishing" });
      upsertStep(buildId, "Building static site", "in_progress", "npm install && npm run build…");
      log(buildId, "Step: Vite build in temp dir");

      const buildEnv = {
        ...process.env,
        VITE_DO_TOKEN: doToken,
        VITE_INFERENCE_PROXY: "/api/inference",
        NODE_ENV: "production",
      };
      const distDir = await buildViteProject(parsed.files, buildEnv, workRoot);
      upsertStep(buildId, "Building static site", "done", "dist/ ready");
      log(buildId, "Step: Vite build done");

      upsertStep(buildId, "Pushing to DOCR", "in_progress", "Uploading image to Container Registry…");
      log(buildId, "Step: DOCR push started");

      const docrToken = resolveDocrToken(doToken);
      const registryName = await getRegistryNameOrThrow(docrToken);
      const repoName = resolveDocrRepoName();
      const imageTag = `b-${buildId.replace(/-/g, "")}`;

      const push = await pushBusyboxStaticImage({
        doToken: docrToken,
        registryName,
        repoName,
        tag: imageTag,
        distDir,
        log: (m) => log(buildId, "docr", m),
      });

      upsertStep(buildId, "Pushing to DOCR", "done", `${push.repository}:${push.tag}`);
      patchBuild(buildId, { repo: push.registryConsoleUrl });
      log(buildId, "Step: DOCR push done", `${push.repository}:${push.tag}`);

      const specName = `${appSlug.slice(0, 22)}-${buildId.slice(0, 6)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);

      patchBuild(buildId, { status: "deploying" });
      upsertStep(buildId, "Deploying to DigitalOcean", "in_progress", "Creating App Platform app…");
      log(buildId, "Step: DO createApp (DOCR image)");

      const appId = await createAppFromDocrImage(
        doToken,
        specName,
        push.repository,
        push.tag
      );
      upsertStep(buildId, "Deploying to DigitalOcean", "done", `App ID ${appId}`);
      log(buildId, "Step: DO app created", appId);

      upsertStep(buildId, "Going live...", "in_progress", "Waiting for deployment…");
      log(buildId, "Step: polling until live");

      const url = await pollUntilLive(doToken, appId, (phase) => {
        upsertStep(buildId, "Going live...", "in_progress", `Phase: ${phase}`);
        log(buildId, "DO deployment phase", phase);
      });

      upsertStep(buildId, "Going live...", "done", url);
      patchBuild(buildId, { status: "live", url });
      log(buildId, "Build complete", url);
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(buildId, "Build failed", message);
    patchBuild(buildId, {
      status: "failed",
      error: message,
    });
    const steps = getBuild(buildId)?.steps || [];
    const last = [...steps].reverse().find((s) => s.status === "in_progress");
    if (last) {
      upsertStep(buildId, last.step, "failed", message);
    } else {
      upsertStep(buildId, "Generating code", "failed", message);
    }
  }
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/**
 * Serve a local preview's `dist/` for the **local** deploy mode.
 * URL shape: `/preview/<buildId>/...`
 *
 * Express `/preview/:buildId` matches **both** `/preview/uuid` and `/preview/uuid/` when strict routing
 * is off, so a naive "always redirect to trailing slash" causes an **infinite 301** on the canonical URL.
 * We use explicit patterns: redirect only the no-slash form; serve everything else.
 */
function serveLocalPreview(req, res, buildId, rawPath) {
  const entry = previews.get(buildId);
  if (!entry) {
    res.status(404).type("text/plain").send("Preview not found or expired.");
    return;
  }
  let target = path.normalize(path.join(entry.dir, rawPath || ""));
  if (!target.startsWith(entry.dir)) {
    res.status(400).type("text/plain").send("Invalid path");
    return;
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(entry.dir, "index.html");
  }
  res.sendFile(
    target,
    {
      headers: {
        "Cache-Control": "no-store, must-revalidate",
      },
    },
    (err) => {
      if (err && !res.headersSent) {
        res.status(500).type("text/plain").send("Failed to serve preview asset.");
      }
    }
  );
}

/** `/preview/{id}/assets/...` */
app.get(/^\/preview\/([^/]+)\/(.+)$/, (req, res) => {
  const buildId = req.params[0];
  const rest = req.params[1];
  serveLocalPreview(req, res, buildId, rest);
});

/** `/preview/{id}/` → index.html */
app.get(/^\/preview\/([^/]+)\/$/, (req, res) => {
  const buildId = req.params[0];
  serveLocalPreview(req, res, buildId, "");
});

/** `/preview/{id}` → `/preview/{id}/` (only when there is no trailing slash) */
app.get(/^\/preview\/([^/]+)$/, (req, res) => {
  const buildId = req.params[0];
  res.redirect(301, `/preview/${buildId}/`);
});

/** Stop and clean a local preview (frees disk; URL stops working). */
app.post("/api/preview/:buildId/stop", async (req, res) => {
  const { buildId } = req.params;
  const entry = previews.get(buildId);
  if (!entry) {
    res.status(404).json({ error: "preview not found" });
    return;
  }
  previews.delete(buildId);
  try {
    await rm(entry.workRoot, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({
    default_do_token_configured: Boolean(
      String(process.env.TIDEAI_DEFAULT_DO_TOKEN || "").trim()
    ),
  });
});

app.post("/api/build", (req, res) => {
  const { prompt, do_token: do_token_body } = req.body || {};
  const deploy_mode = deployModeFromBody(req.body || {});
  const githubToken = resolveGithubToken(req.body || {});
  const do_token = resolveDoToken(do_token_body);

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!do_token) {
    return res.status(400).json({
      error:
        "do_token is required (paste in the form) unless the server sets TIDEAI_DEFAULT_DO_TOKEN for local testing. Inference (codegen) needs it even in local preview mode.",
    });
  }
  if (deploy_mode === "github" && !githubToken) {
    return res.status(503).json({
      error:
        "GitHub mode requires GITHUB_TOKEN on the server or github_token in the request body.",
    });
  }

  const buildId = randomUUID();
  setBuild(buildId, {
    status: "inferring",
    steps: [],
    url: null,
    repo: null,
    error: null,
    deploy_mode,
  });

  setImmediate(() => {
    runBuildPipeline(buildId, prompt.trim(), do_token, deploy_mode, githubToken);
  });

  res.json({ build_id: buildId, deploy_mode });
});

app.get("/api/build/:buildId", (req, res) => {
  const { buildId } = req.params;
  const build = getBuild(buildId);
  if (!build) {
    res.status(404).json({ error: "Unknown build_id" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (res.flushHeaders) res.flushHeaders();

  let timer;
  const send = () => {
    const b = getBuild(buildId);
    if (!b) {
      if (timer) clearInterval(timer);
      res.end();
      return;
    }
    const payload = {
      status: b.status,
      steps: b.steps,
      url: b.url,
      repo: b.repo,
      error: b.error,
      deploy_mode: b.deploy_mode ?? "docr",
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (b.status === "live" || b.status === "failed") {
      if (timer) clearInterval(timer);
      res.end();
    }
  };

  send();
  timer = setInterval(send, 1000);
  req.on("close", () => {
    if (timer) clearInterval(timer);
  });
});

if (fs.existsSync(publicDir)) {
  app.use(
    express.static(publicDir, {
      setHeaders(res, filePath) {
        if (path.basename(filePath) === "index.html") {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        }
      },
    })
  );
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`tideAI listening on http://0.0.0.0:${PORT}`);
});
