import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { execFileSync } from "child_process";
import { gzipSync } from "zlib";
import https from "https";

const DO_API = "https://api.digitalocean.com/v2";
const REGISTRY_HOST = "registry.digitalocean.com";

/**
 * Fetch-shaped wrapper around Node's `https` module. Forces HTTP/1.1 so
 * registry.digitalocean.com doesn't reject our rapid back-to-back blob/manifest
 * uploads with NGHTTP2_ENHANCE_YOUR_CALM. Native `fetch` (undici) negotiates
 * HTTP/2 by default and gets throttled on the same single multiplexed stream.
 * App Platform and the regular DO API still use Node's default fetch.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>|Headers, body?: Buffer|string }} [init]
 * @returns {Promise<Response>}
 */
function regHttp(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        for (const [k, v] of init.headers.entries()) headers[k] = v;
      } else {
        Object.assign(headers, init.headers);
      }
    }
    const body = init.body == null ? null : (Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body));
    if (body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = String(body.length);
    }
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: init.method || "GET",
      headers,
      /** Force HTTP/1.1 — Node's https module is HTTP/1.x only by default. */
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        /** Build a fetch-compatible Response so callers can keep using `.text()` / `.headers.get()` / `.status`. */
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((vv) => responseHeaders.append(k, vv));
          else if (v != null) responseHeaders.set(k, String(v));
        }
        resolve(new Response(buf, {
          status: res.statusCode || 0,
          statusText: res.statusMessage || "",
          headers: responseHeaders,
        }));
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const CADDY_TGZ_URL =
  process.env.TIDEAI_CADDY_URL ||
  "https://github.com/caddyserver/caddy/releases/download/v2.8.4/caddy_2.8.4_linux_amd64.tar.gz";

/** Serves Vite dist from /www and proxies /api/inference → inference.do-ai.run and /api/kbaas → kbaas.do-ai.run (avoids browser CORS on OPTIONS). */
const STATIC_SITE_CADDYFILE = `:8080 {
  encode gzip

  handle /api/inference* {
    @inf_options method OPTIONS
    handle @inf_options {
      header Access-Control-Allow-Origin {http.request.header.Origin}
      header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      header Access-Control-Allow-Headers "Authorization, Content-Type, Accept"
      header Access-Control-Max-Age "86400"
      header Vary Origin
      respond 204
    }
    uri strip_prefix /api/inference
    reverse_proxy https://inference.do-ai.run:443 {
      header_up Host inference.do-ai.run
    }
  }

  handle /api/kbaas* {
    @kb_options method OPTIONS
    handle @kb_options {
      header Access-Control-Allow-Origin {http.request.header.Origin}
      header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      header Access-Control-Allow-Headers "Authorization, Content-Type, Accept"
      header Access-Control-Max-Age "86400"
      header Vary Origin
      respond 204
    }
    uri strip_prefix /api/kbaas
    reverse_proxy https://kbaas.do-ai.run:443 {
      header_up Host kbaas.do-ai.run
    }
  }

  handle /api/gen-ai* {
    @ga_options method OPTIONS
    handle @ga_options {
      header Access-Control-Allow-Origin {http.request.header.Origin}
      header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
      header Access-Control-Allow-Headers "Authorization, Content-Type, Accept"
      header Access-Control-Max-Age "86400"
      header Vary Origin
      respond 204
    }
    uri replace /api/gen-ai /v2/gen-ai
    reverse_proxy https://api.digitalocean.com:443 {
      header_up Host api.digitalocean.com
    }
  }

  handle {
    root * /www
    try_files {path} /index.html
    file_server
  }
}
`;

function apiHeaders(doToken) {
  return {
    Authorization: `Bearer ${doToken}`,
    Accept: "application/json",
  };
}

/**
 * Create a new default registry (one per DO account on standard plans).
 * @param {string} doToken
 * @returns {Promise<string>} new registry name
 */
async function tryCreateRegistry(doToken) {
  const tier =
    process.env.DO_REGISTRY_SUBSCRIPTION_TIER?.trim() || "starter";
  const prefix =
    (process.env.DO_REGISTRY_NAME_PREFIX || "tideai")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "tideai";

  const region = process.env.DO_REGISTRY_REGION?.trim();

  for (let i = 0; i < 8; i++) {
    const suffix = randomBytes(3).toString("hex");
    const name = `${prefix}-${suffix}`.slice(0, 63);
    const body = { name, subscription_tier_slug: tier };
    if (region) body.region = region;

    const res = await fetch(`${DO_API}/registry`, {
      method: "POST",
      headers: {
        ...apiHeaders(doToken),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (res.ok) {
      const n = json?.registry?.name;
      if (n && typeof n === "string") return n;
      throw new Error(
        "Registry create succeeded but response did not include registry.name"
      );
    }

    const msg = String(json?.message || text || "").toLowerCase();
    const taken =
      res.status === 422 && (msg.includes("in use") || msg.includes("taken"));
    if (taken && i < 7) continue;

    throw new Error(
      `Could not create Container Registry (${res.status}): ${(json?.message || text).slice(0, 500)}. Ensure your API token includes **registry:create** (or create a registry manually: https://cloud.digitalocean.com/registry/new ). Tier used: ${tier}.`
    );
  }

  throw new Error(
    "Could not create a Container Registry with a unique name after several attempts."
  );
}

/**
 * @param {string} doToken
 * @returns {Promise<string>} registry slug (first segment of image path)
 */
export async function getRegistryNameOrThrow(doToken) {
  const res = await fetch(`${DO_API}/registry`, { headers: apiHeaders(doToken) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (res.ok) {
    const name = json?.registry?.name;
    if (name && typeof name === "string") return name;
    throw new Error("Unexpected registry API response: missing registry.name");
  }

  if (res.status === 404) {
    if (process.env.TIDEAI_AUTO_CREATE_REGISTRY === "false") {
      throw new Error(
        "No DigitalOcean Container Registry on this account. Create one: https://cloud.digitalocean.com/registry/new (Starter is fine), then retry. To disable auto-create attempts, you already set TIDEAI_AUTO_CREATE_REGISTRY=false."
      );
    }
    return tryCreateRegistry(doToken);
  }

  throw new Error(
    `Could not read Container Registry (${res.status}): ${(json?.message || text).slice(0, 400)}`
  );
}

/**
 * DO API may return `name` as a slug or `registry/repo`; image path uses the last segment only.
 * @param {string} name
 */
function slugFromApiRepositoryField(name) {
  const s = name.trim();
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * Repository slugs already present in this registry (for Starter single-repo logic).
 *
 * @param {string} doToken
 * @param {string} registryName
 * @returns {Promise<string[]>}
 */
export async function listRegistryRepositorySlugs(doToken, registryName) {
  const encoded = encodeURIComponent(registryName);
  const bases = [
    `${DO_API}/registries/${encoded}/repositoriesV2`,
    `${DO_API}/registry/${encoded}/repositoriesV2`,
  ];

  for (const basePath of bases) {
    const slugs = [];
    let url = `${basePath}?per_page=200`;
    let firstRequest = true;
    for (let page = 0; page < 50; page++) {
      const res = await fetch(url, { headers: apiHeaders(doToken) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (res.status === 404) {
        if (firstRequest) break;
        throw new Error(
          `Could not list registry repositories (${res.status}): ${(json?.message || text).slice(0, 400)}`
        );
      }
      firstRequest = false;
      if (!res.ok) {
        throw new Error(
          `Could not list registry repositories (${res.status}): ${(json?.message || text).slice(0, 400)}`
        );
      }
      for (const r of json?.repositories || []) {
        const raw =
          typeof r?.name === "string"
            ? r.name
            : typeof r?.repository === "string"
              ? r.repository
              : "";
        const slug = slugFromApiRepositoryField(raw);
        if (slug) slugs.push(slug);
      }
      const next = json?.links?.pages?.next;
      if (typeof next === "string" && next.length > 0) {
        url = next.startsWith("http")
          ? next
          : `https://api.digitalocean.com${next.startsWith("/") ? "" : "/"}${next}`;
        continue;
      }
      return [...new Set(slugs)];
    }
  }
  throw new Error(
    `Could not list registry repositories (404): no list route matched for registry "${registryName}". Confirm the registry exists and your token has registry:read.`
  );
}

/**
 * Starter tier allows **one** repository per registry. If that slot is already used under
 * a different name than `desiredSlug`, reuse it (each tideAI build still gets a new **tag**).
 *
 * @param {{ doToken: string, registryName: string, desiredSlug: string, log?: (msg: string) => void }} opts
 * @returns {Promise<string>}
 */
export async function pickDocrRepositorySlug({
  doToken,
  registryName,
  desiredSlug,
  log,
}) {
  const trimmed = desiredSlug.trim();
  const want = trimmed.toLowerCase();
  const existing = await listRegistryRepositorySlugs(doToken, registryName);
  const byLower = new Map(existing.map((s) => [s.toLowerCase(), s]));
  if (byLower.has(want)) return byLower.get(want) || trimmed;
  if (existing.length === 0) return trimmed;
  if (existing.length === 1) {
    const only = existing[0];
    if (only.toLowerCase() !== want) {
      log?.(
        `Reusing existing DOCR repository "${only}" (registry already has 1 repository; Starter limit is 1). This build pushes tag only. Set TIDEAI_DOCR_REPO_NAME=${only} to silence.`
      );
      return only;
    }
  }
  return trimmed;
}

/**
 * Docker config.json `auth` value (base64 user:pass) for `Authorization: Basic …` against registry.digitalocean.com.
 * Uses `/v2/registries/{name}/docker-credentials` so pushes work when the account has **multiple** registries; the
 * legacy `/v2/registry/docker-credentials` route can return credentials that 401 on blob upload for a named registry.
 *
 * @param {string} doToken
 * @param {string} registryName registry slug (first path segment under registry.digitalocean.com)
 * @returns {Promise<string>}
 */
export async function getRegistryAuthToken(doToken, registryName) {
  const rw = "read_write=true";
  const namedUrl = `${DO_API}/registries/${encodeURIComponent(
    registryName
  )}/docker-credentials?${rw}`;
  const legacyUrl = `${DO_API}/registry/docker-credentials?${rw}`;

  async function tryFetch(url) {
    const res = await fetch(url, { headers: apiHeaders(doToken) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { res, text, json };
  }

  let { res, text, json } = await tryFetch(namedUrl);
  if (res.status === 404) {
    ({ res, text, json } = await tryFetch(legacyUrl));
  }
  if (!res.ok) {
    throw new Error(
      `Could not get registry docker-credentials (${res.status}): ${(json?.message || text).slice(0, 400)}`
    );
  }
  const auth = json?.auths?.[REGISTRY_HOST]?.auth;
  if (!auth || typeof auth !== "string") {
    throw new Error(
      "Registry credentials response missing auths['registry.digitalocean.com'].auth — ensure your DO token has registry scopes (e.g. registry:read and registry:update for docker-credentials)."
    );
  }
  return auth.trim();
}

function basicAuthHeader(b64UserPass) {
  return `Basic ${b64UserPass}`;
}

/**
 * Parse `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` (Docker distribution token spec).
 * @param {string | null} headerVal
 * @returns {{ realm: string, service: string, scope: string } | null}
 */
function parseBearerChallenge(headerVal) {
  if (!headerVal || typeof headerVal !== "string") return null;
  const t = headerVal.trim();
  if (!/^Bearer\s+/i.test(t)) return null;
  const realm =
    /(?:^|[,\s])realm="([^"]+)"/i.exec(t)?.[1] ||
    /(?:^|[,\s])realm=([^"\s,]+)/i.exec(t)?.[1] ||
    null;
  if (!realm) return null;
  const service =
    /(?:^|[,\s])service="([^"]+)"/i.exec(t)?.[1] ||
    /(?:^|[,\s])service=([^"\s,]+)/i.exec(t)?.[1] ||
    "";
  const scope =
    /(?:^|[,\s])scope="([^"]+)"/i.exec(t)?.[1] ||
    /(?:^|[,\s])scope=([^"\s,]+)/i.exec(t)?.[1] ||
    "";
  return { realm, service, scope };
}

/**
 * Exchange docker Basic credentials for a short-lived registry Bearer token (required by DOCR for blob/manifest API).
 * Falls back to `Authorization: Bearer <apiPat>` on the same token URL if Basic is rejected (some DO setups).
 * @param {string} wwwAuthenticate raw WWW-Authenticate header
 * @param {string} basicAuthB64 `auths[registry].auth` from docker-credentials
 * @param {string} [apiPat] DigitalOcean API PAT (same token used for docker-credentials)
 */
async function fetchRegistryBearerToken(
  wwwAuthenticate,
  basicAuthB64,
  apiPat,
  diag
) {
  const ch = parseBearerChallenge(wwwAuthenticate);
  if (!ch) {
    diag?.note(`No parsable Bearer challenge in: ${String(wwwAuthenticate).slice(0, 200)}`);
    return null;
  }
  diag?.note(`Challenge realm=${ch.realm} service=${ch.service} scope=${ch.scope}`);

  async function tryAuth(tokenUrlStr, authz, label) {
    const res = await regHttp(tokenUrlStr, {
      headers: {
        Authorization: authz,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    diag?.note(
      `Token exchange [${label}] ${res.status} ${tokenUrlStr.replace(/scope=[^&]+/, "scope=…")} body="${text.slice(0, 200)}"`
    );
    return { res, json };
  }

  async function exchangeAt(urlStr) {
    const { res: r1, json: j1 } = await tryAuth(urlStr, basicAuthHeader(basicAuthB64), "Basic");
    if (r1.ok) {
      const t =
        (typeof j1?.token === "string" && j1.token) ||
        (typeof j1?.access_token === "string" && j1.access_token);
      if (t) return t;
    }
    /**
     * Token issuer responses for DigitalOcean signal **registry-quota** failures (e.g. Starter limit) as
     * 403 DENIED on the token endpoint itself. Surface that as a typed error so callers can show the real
     * cause instead of a downstream 401.
     */
    if (
      r1.status === 403 ||
      String(j1?.errors?.[0]?.code || "").toUpperCase() === "DENIED"
    ) {
      const denyMsg = String(
        j1?.errors?.[0]?.message || j1?.message || "registry quota exceeded"
      );
      const e = new Error(`Token issuer DENIED: ${denyMsg}`);
      e.code = "DOCR_TOKEN_DENIED";
      e.docrMessage = denyMsg;
      throw e;
    }
    if (typeof apiPat === "string" && apiPat.trim()) {
      const pat = apiPat.trim();
      const patBasic = Buffer.from(`${pat}:${pat}`).toString("base64");
      const tries = [
        ["Bearer<PAT>", `Bearer ${pat}`],
        ["Basic<PAT:PAT>", `Basic ${patBasic}`],
      ];
      for (const [label, authz] of tries) {
        const { res, json } = await tryAuth(urlStr, authz, label);
        if (!res.ok) continue;
        const t =
          (typeof json?.token === "string" && json.token) ||
          (typeof json?.access_token === "string" && json.access_token);
        if (t) return t;
      }
    }
    return null;
  }

  const candidates = [];
  const u1 = new URL(ch.realm);
  if (ch.service) u1.searchParams.set("service", ch.service);
  if (ch.scope) u1.searchParams.set("scope", ch.scope);
  candidates.push(u1.toString());

  if (ch.scope && ch.scope.includes(",")) {
    const u2 = new URL(ch.realm);
    if (ch.service) u2.searchParams.set("service", ch.service);
    for (const p of ch.scope.split(",").map((s) => s.trim()).filter(Boolean)) {
      u2.searchParams.append("scope", p);
    }
    candidates.push(u2.toString());
  }

  for (const url of candidates) {
    try {
      const t = await exchangeAt(url);
      if (t) return t;
    } catch (e) {
      if (e && e.code === "DOCR_TOKEN_DENIED") throw e;
      throw e;
    }
  }
  return null;
}

const REGISTRY_V2_HEADERS = { "Docker-Distribution-API-Version": "registry/2.0" };

/**
 * Unauthenticated probe so DOCR returns the real WWW-Authenticate line (token realm/service/scope).
 * @param {string} repositoryPath `registryName/repoSegment`
 * @param {{note: (msg: string) => void}} [diag]
 */
async function discoverRegistryBearerChallenge(repositoryPath, diag) {
  const base = `https://${REGISTRY_HOST}/v2/${repositoryPath}`;
  const probes = [
    {
      label: "HEAD /manifests/<probe>",
      run: () =>
        regHttp(`${base}/manifests/tideai-probe-${Date.now()}`, {
          method: "HEAD",
          headers: REGISTRY_V2_HEADERS,
        }),
    },
    {
      label: "POST /blobs/uploads/",
      run: () =>
        regHttp(`${base}/blobs/uploads/`, {
          method: "POST",
          headers: { ...REGISTRY_V2_HEADERS, "Content-Length": "0" },
        }),
    },
  ];
  for (const p of probes) {
    const res = await p.run();
    const www =
      res.headers.get("www-authenticate") || res.headers.get("WWW-Authenticate");
    await res.arrayBuffer().catch(() => {});
    diag?.note(`Probe ${p.label} → ${res.status} www-authenticate="${www || ""}"`);
    if (res.status === 401 && www) return www;
  }
  return null;
}

/**
 * Obtain a Bearer token for all v2 calls for this repository (preferred over sending only Basic to the registry).
 * @param {string} basicAuthB64 docker-credentials `auth`
 * @param {string} apiPat PAT used for docker-credentials (token server Bearer fallback)
 * @param {string} repositoryPath `registryName/repoName`
 */
async function resolveRegistryBearer(basicAuthB64, apiPat, repositoryPath, diag) {
  const www = await discoverRegistryBearerChallenge(repositoryPath, diag);
  if (www) {
    const tok = await fetchRegistryBearerToken(www, basicAuthB64, apiPat, diag);
    if (tok) return tok;
  }
  const fallbacks = [
    `Bearer realm="https://${REGISTRY_HOST}/v2/auth",service="${REGISTRY_HOST}",scope="repository:${repositoryPath}:pull,push"`,
    `Bearer realm="https://${REGISTRY_HOST}/v2/auth",service=registry.digitalocean.com,scope="repository:${repositoryPath}:pull,push"`,
  ];
  for (const f of fallbacks) {
    const tok = await fetchRegistryBearerToken(f, basicAuthB64, apiPat, diag);
    if (tok) return tok;
  }
  return null;
}

/**
 * @param {string} registryName
 * @param {string} repoName single segment, e.g. tideai-myapp
 */
function repoPath(registryName, repoName) {
  return `${registryName}/${repoName}`;
}

/**
 * @param {string} body registry error JSON or text
 * @param {string} repoName current repo segment
 */
function registryQuotaHint(body, repoName) {
  const b = body.toLowerCase();
  if (
    b.includes("limit is 1") ||
    b.includes("repositories, limit") ||
    (b.includes("denied") && b.includes("repositor"))
  ) {
    return (
      ` DOCR Starter allows only **one repository** per registry. tideAI reuses **TIDEAI_DOCR_REPO_NAME** (default \`tideai-apps\`) with a new tag per build. Either delete other repos in the DO control panel so that name is free, or set **TIDEAI_DOCR_REPO_NAME** to your one existing repo (was pushing to \`${repoName}\`). Upgrade registry tier for more repositories.`
    );
  }
  return "";
}

/**
 * `registryName/repoName` from a registry API URL under /v2/…
 * @param {string} url
 */
function repositoryScopeFromUrl(url) {
  try {
    const p = new URL(url).pathname;
    const m = /^\/v2\/(.+)\/(?:blobs|manifests)\b/.exec(p);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Registry HTTP: Basic first, then on 401 exchange WWW-Authenticate for Bearer and retry.
 * @param {string} url
 * @param {RequestInit} init
 * @param {string} basicAuthB64 `auths[registry].auth`
 * @param {string} [apiPat] DO API token for token-endpoint Bearer fallback
 */
async function regFetchBasicThenBearer(url, init, basicAuthB64, apiPat, diag) {
  const headers = new Headers(init.headers);
  if (!headers.has("Docker-Distribution-API-Version")) {
    headers.set("Docker-Distribution-API-Version", "registry/2.0");
  }
  headers.set("Authorization", basicAuthHeader(basicAuthB64));

  const first = await regHttp(url, { ...init, headers });
  if (first.status !== 401) return first;

  const www =
    first.headers.get("www-authenticate") ||
    first.headers.get("WWW-Authenticate");
  diag?.note(`Basic→401 on ${init.method || "GET"} ${url} www-authenticate="${www || ""}"`);

  let bearer = await fetchRegistryBearerToken(www, basicAuthB64, apiPat, diag);
  if (!bearer) {
    const repoPathPart = repositoryScopeFromUrl(url);
    if (repoPathPart) {
      const synthetic = `Bearer realm="https://${REGISTRY_HOST}/v2/auth",service="${REGISTRY_HOST}",scope="repository:${repoPathPart}:pull,push"`;
      bearer = await fetchRegistryBearerToken(synthetic, basicAuthB64, apiPat, diag);
    }
  }
  if (!bearer) return first;

  await first.arrayBuffer().catch(() => {});

  const h2 = new Headers(init.headers);
  if (!h2.has("Docker-Distribution-API-Version")) {
    h2.set("Docker-Distribution-API-Version", "registry/2.0");
  }
  h2.set("Authorization", `Bearer ${bearer}`);
  return regHttp(url, { ...init, headers: h2 });
}

/**
 * Download official linux/amd64 Caddy tarball and place the binary at `destExecPath`.
 * @param {string} destExecPath e.g. .../bin/caddy
 */
async function downloadCaddy(destExecPath) {
  const dir = path.dirname(destExecPath);
  await fs.mkdir(dir, { recursive: true });
  const tgzPath = path.join(dir, `_caddy_${Date.now()}.tgz`);
  const res = await fetch(CADDY_TGZ_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download Caddy (${res.status}). Set TIDEAI_CADDY_URL to a linux/amd64 release .tar.gz URL.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(tgzPath, buf);
  try {
    execFileSync("tar", ["-xzf", tgzPath, "-C", dir, "caddy"], {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(
      `Could not extract Caddy (${e instanceof Error ? e.message : String(e)}). A tar binary with gzip support is required.`
    );
  }
  try {
    fsSync.chmodSync(destExecPath, 0o755);
  } catch {
    /* windows */
  }
  await fs.rm(tgzPath, { force: true }).catch(() => {});
}

/**
 * Build a single-layer OCI image (Caddy + static files + /api/inference proxy) and push to DOCR.
 * @param {object} opts
 * @param {string} opts.doToken
 * @param {string} opts.registryName
 * @param {string} opts.repoName
 * @param {string} opts.tag
 * @param {string} opts.distDir absolute path to Vite dist
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{ repository: string, tag: string, manifestDigest: string, registryConsoleUrl: string }>}
 */
export async function pushBusyboxStaticImage(opts) {
  const { doToken, registryName, repoName, tag, distDir, log } = opts;
  const authToken = await getRegistryAuthToken(doToken, registryName);
  const rp = repoPath(registryName, repoName);
  const base = `https://${REGISTRY_HOST}/v2/${rp}`;

  /** Diagnostic collector — last 30 entries surfaced in any final 401 error. */
  const diagBuf = [];
  const diag = {
    note(msg) {
      const m = `  ↪ ${msg}`;
      log?.(`auth-trace: ${msg}`);
      diagBuf.push(m);
      if (diagBuf.length > 30) diagBuf.shift();
    },
  };

  /** Prefer Bearer for all registry v2 calls (DOCR often ignores Basic on blob POST). */
  /** @type {string | null} */
  let registryBearer = null;
  try {
    registryBearer = await resolveRegistryBearer(authToken, doToken, rp, diag);
  } catch (e) {
    if (e && e.code === "DOCR_TOKEN_DENIED") {
      throw new Error(
        `DigitalOcean Container Registry **denied** the push token.\n` +
          `Reason from DigitalOcean: ${e.docrMessage}\n\n` +
          `Most likely cause: your **Starter** registry already has its **1 repository** slot used (often by a leftover ` +
          `from a previous failed/manual push, even if the dashboard does not show it). Fix with one of:\n` +
          `  1. List repos with: curl -H "Authorization: Bearer $TOKEN" "https://api.digitalocean.com/v2/registries/${registryName}/repositoriesV2?per_page=200"\n` +
          `     and DELETE the leftover repo via the DO control panel or:\n` +
          `       curl -X DELETE -H "Authorization: Bearer $TOKEN" "https://api.digitalocean.com/v2/registries/${registryName}/repositories/<name>"\n` +
          `  2. Then run **garbage collection** in the DO Container Registry UI to free the slot.\n` +
          `  3. Or set TIDEAI_DOCR_REPO_NAME=<existing repo> so tideAI reuses that slot with new tags.\n` +
          `  4. Or upgrade the registry tier (Basic/Professional) for more repositories.`
      );
    }
    throw e;
  }
  if (registryBearer) log?.("Registry auth: Bearer token obtained");
  else log?.("Registry auth: Bearer pre-flight failed; will try Basic→Bearer per request");

  async function regFetch(url, init) {
    const runBearer = async (b) => {
      if (!b) return null;
      const h = new Headers(init.headers);
      if (!h.has("Docker-Distribution-API-Version")) {
        h.set("Docker-Distribution-API-Version", "registry/2.0");
      }
      h.set("Authorization", `Bearer ${b}`);
      return regHttp(url, { ...init, headers: h });
    };
    if (registryBearer) {
      let r = await runBearer(registryBearer);
      if (r.status !== 401) return r;
      await r.arrayBuffer().catch(() => {});
      diag.note(`Cached Bearer rejected on ${init.method || "GET"} ${url}; refreshing`);
      registryBearer = await resolveRegistryBearer(authToken, doToken, rp, diag);
      if (registryBearer) {
        r = await runBearer(registryBearer);
        if (r.status !== 401) return r;
        await r.arrayBuffer().catch(() => {});
      }
    }
    return regFetchBasicThenBearer(url, init, authToken, doToken, diag);
  }

  const layerRoot = path.join(path.dirname(distDir), `_layer_${Date.now()}`);
  try {
  await fs.mkdir(path.join(layerRoot, "bin"), { recursive: true });
  await fs.mkdir(path.join(layerRoot, "etc", "caddy"), { recursive: true });
  await fs.mkdir(path.join(layerRoot, "www"), { recursive: true });

  const caddyDest = path.join(layerRoot, "bin", "caddy");
  await downloadCaddy(caddyDest);

  await fs.writeFile(
    path.join(layerRoot, "etc", "caddy", "Caddyfile"),
    STATIC_SITE_CADDYFILE,
    "utf8"
  );
  await fs.cp(distDir, path.join(layerRoot, "www"), { recursive: true });

  const uncTar = path.join(layerRoot, "layer.tar");
  try {
    execFileSync("tar", ["-cf", uncTar, "-C", layerRoot, "bin", "etc", "www"], {
      stdio: "pipe",
    });
  } catch (e) {
    throw new Error(
      `Could not run tar to pack the image layer (${e instanceof Error ? e.message : String(e)}). A POSIX tar binary is required on the server.`
    );
  }

  const uncBuf = await fs.readFile(uncTar);
  const diffId =
    "sha256:" + createHash("sha256").update(uncBuf).digest("hex");
  const gzBuf = gzipSync(uncBuf);
  const layerDigest =
    "sha256:" + createHash("sha256").update(gzBuf).digest("hex");

  const configObj = {
    architecture: "amd64",
    os: "linux",
    config: {
      ExposedPorts: { "8080/tcp": {} },
      Entrypoint: ["/bin/caddy", "run", "--config", "/etc/caddy/Caddyfile"],
    },
    rootfs: {
      type: "layers",
      diff_ids: [diffId],
    },
  };
  const configBuf = Buffer.from(JSON.stringify(configObj), "utf8");
  const configDigest =
    "sha256:" + createHash("sha256").update(configBuf).digest("hex");

  log?.(`Layer digest ${layerDigest.slice(0, 20)}…`);
  log?.(`Config digest ${configDigest.slice(0, 20)}…`);

  async function uploadBlob(digestFull, body, contentType) {
    const init = await regFetch(`${base}/blobs/uploads/`, {
      method: "POST",
      headers: {
        "Content-Length": "0",
      },
    });
    if (init.status !== 202) {
      const t = await init.text();
      let msg = `Registry POST blobs/uploads failed ${init.status}: ${t.slice(0, 400)}`;
      msg += registryQuotaHint(t, repoName);
      if (init.status === 401) {
        msg +=
          "\nAuth diagnostic trace (most recent first):\n" +
          diagBuf.slice().reverse().join("\n") +
          "\nHints: PAT must have registry:read + registry:update; if you set TIDEAI_DOCR_TOKEN it must belong to the same DO team as the registry; try a Full-Access token to confirm.";
      }
      throw new Error(msg);
    }
    const loc = init.headers.get("location");
    if (!loc) throw new Error("Registry did not return Location for blob upload");
    const uploadUrl = new URL(loc, `https://${REGISTRY_HOST}`);
    uploadUrl.searchParams.set("digest", digestFull);
    const put = await regFetch(uploadUrl.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
      },
      body,
    });
    if (!put.ok) {
      const t = await put.text();
      throw new Error(
        `Registry blob upload failed ${put.status}: ${t.slice(0, 400)}${registryQuotaHint(t, repoName)}`
      );
    }
  }

  await uploadBlob(
    layerDigest,
    gzBuf,
    "application/vnd.oci.image.layer.v1.tar+gzip"
  );
  await uploadBlob(
    configDigest,
    configBuf,
    "application/vnd.oci.image.config.v1+json"
  );

  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: configDigest,
      size: configBuf.length,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: layerDigest,
        size: gzBuf.length,
      },
    ],
  };

  const manifestBody = JSON.stringify(manifest);
  const manRes = await regFetch(`${base}/manifests/${encodeURIComponent(tag)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/vnd.oci.image.manifest.v1+json",
    },
    body: manifestBody,
  });
  if (!manRes.ok) {
    const t = await manRes.text();
    throw new Error(
      `Registry manifest upload failed ${manRes.status}: ${t.slice(0, 600)}${registryQuotaHint(t, repoName)}`
    );
  }

  /**
   * Prefer registry-issued `Docker-Content-Digest`; fall back to a local sha256 of the
   * exact bytes we PUT so App Platform can pin to digest (avoids tag-indexing lag → 404).
   */
  const digestHdr =
    manRes.headers.get("docker-content-digest") ||
    manRes.headers.get("Docker-Content-Digest");
  const computedManifestDigest =
    "sha256:" +
    createHash("sha256").update(manifestBody, "utf8").digest("hex");
  const manifestDigest =
    typeof digestHdr === "string" && digestHdr.trim()
      ? digestHdr.trim()
      : computedManifestDigest;

  const registryConsoleUrl = `https://cloud.digitalocean.com/registry/${encodeURIComponent(
    registryName
  )}/repositories/${encodeURIComponent(repoName)}`;

  return { repository: rp, tag, manifestDigest, registryConsoleUrl };
  } finally {
    await fs.rm(layerRoot, { recursive: true, force: true }).catch(() => {});
  }
}
