import YAML from "yaml";

const DO_API = "https://api.digitalocean.com/v2";

function doHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/**
 * @param {{ path: string, content: string }[]} files
 * @returns {object | null} Parsed app.yaml root (may have `spec` key)
 */
function parseAppYamlFromFiles(files) {
  const doc = files.find((f) => f.path === ".do/app.yaml" || f.path.endsWith("/app.yaml"));
  if (!doc) return null;
  try {
    return YAML.parse(doc.content);
  } catch {
    return null;
  }
}

/**
 * @param {string} doToken
 * @param {string} repoFullName
 * @param {string} appName
 * @param {{ key: string, value: string }[]} envVars
 * @param {{ path: string, content: string }[]} files
 * @returns {Promise<string>} app id
 */
export async function createApp(doToken, repoFullName, appName, envVars, files = []) {
  const yamlRoot = parseAppYamlFromFiles(files);
  const specBlock = yamlRoot?.spec ?? yamlRoot;

  const buildCommand =
    specBlock?.static_sites?.[0]?.build_command ?? "npm install && npm run build";
  const outputDir = specBlock?.static_sites?.[0]?.output_dir ?? "dist";
  const sourceDir = specBlock?.static_sites?.[0]?.source_dir ?? "/";

  const body = {
    spec: {
      name: appName,
      static_sites: [
        {
          name: "frontend",
          github: {
            repo: repoFullName,
            branch: "main",
            deploy_on_push: true,
          },
          build_command: buildCommand,
          output_dir: outputDir,
          source_dir: sourceDir,
          envs: envVars.map((v) => ({
            key: v.key,
            value: v.value,
            scope: "BUILD_TIME",
          })),
        },
      ],
    },
  };

  const res = await fetch(`${DO_API}/apps`, {
    method: "POST",
    headers: doHeaders(doToken),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      `DO create app failed ${res.status}: ${(json?.message || text).slice(0, 600)}`
    );
  }

  const appId = json?.app?.id;
  if (!appId) {
    throw new Error("DO create app response missing app.id");
  }
  return String(appId);
}

/**
 * @param {string} doToken
 * @param {string} appId
 * @param {(phase: string) => void} onProgress
 * @returns {Promise<string>} live URL
 */
export async function pollUntilLive(doToken, appId, onProgress) {
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    const res = await fetch(`${DO_API}/apps/${appId}`, {
      headers: doHeaders(doToken),
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    if (!res.ok) {
      throw new Error(
        `DO poll app failed ${res.status}: ${(json?.message || text).slice(0, 400)}`
      );
    }

    const app = json?.app;
    const liveUrl = app?.live_url;
    const phase =
      app?.in_progress_deployment?.phase ||
      app?.active_deployment?.phase ||
      "";

    if (typeof onProgress === "function") {
      onProgress(phase || "UNKNOWN");
    }

    if (liveUrl) {
      return liveUrl;
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  throw new Error(
    "Timed out after 5 minutes waiting for DigitalOcean App Platform to go live"
  );
}

/**
 * @param {string} doToken
 * @param {string} specName App Platform app name (short, DNS-safe)
 * @param {string} repository e.g. "my-registry/tideai-abc" for DOCR
 * @param {string} tag image tag
 * @returns {Promise<string>} app id
 */
export async function createAppFromDocrImage(doToken, specName, repository, tag) {
  /** App spec `image.deploy_on_push` is an object `{ enabled }`, not a boolean (DO API 400 otherwise). */
  const image = {
    registry_type: "DOCR",
    repository,
    tag,
    deploy_on_push: { enabled: false },
  };

  const body = {
    spec: {
      name: specName,
      services: [
        {
          name: "web",
          image,
          instance_count: 1,
          instance_size_slug: "basic-xxs",
          http_port: 8080,
          health_check: {
            http_path: "/",
          },
        },
      ],
    },
  };

  const res = await fetch(`${DO_API}/apps`, {
    method: "POST",
    headers: doHeaders(doToken),
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  if (!res.ok) {
    throw new Error(
      `DO create app failed ${res.status}: ${(json?.message || text).slice(0, 600)}`
    );
  }

  const appId = json?.app?.id;
  if (!appId) {
    throw new Error("DO create app response missing app.id");
  }
  return String(appId);
}
