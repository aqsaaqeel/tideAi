const DO_API = "https://api.digitalocean.com";

/**
 * @param {string} token
 * @param {string} path path starting with /v2/...
 * @param {{ method?: string, body?: unknown }} [opts]
 */
async function doDigitalOceanApi(token, path, opts = {}) {
  const method = opts.method || "GET";
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  let bodyStr;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(opts.body);
  }
  const r = await fetch(`${DO_API}${path}`, {
    method,
    headers,
    body: bodyStr,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* leave null */
  }
  return { ok: r.ok, status: r.status, json, text };
}

/**
 * Normalize DigitalOcean `GET /v2/gen-ai/knowledge_bases` JSON into `{ uuid, name }[]`.
 * @param {unknown} json
 * @returns {{ uuid: string, name: string }[]}
 */
export function normalizeKnowledgeBaseList(json) {
  if (!json || typeof json !== "object") return [];
  const o = /** @type {Record<string, unknown>} */ (json);
  const candidates = [
    o.knowledge_bases,
    o.knowledgeBases,
    o.items,
    o.results,
    o.data,
  ];
  let arr = null;
  for (const c of candidates) {
    if (Array.isArray(c)) {
      arr = c;
      break;
    }
  }
  if (!arr && Array.isArray(json)) arr = json;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (x);
    const uuid = String(
      r.uuid ?? r.knowledge_base_uuid ?? r.knowledge_base_id ?? r.id ?? ""
    ).trim();
    if (!uuid) continue;
    const name = String(r.name ?? r.title ?? r.display_name ?? uuid).trim();
    out.push({ uuid, name: name || uuid });
  }
  return out;
}

/**
 * @param {string} token
 * @param {string | undefined} explicitProjectId
 */
async function resolveProjectId(token, explicitProjectId) {
  const ex = String(explicitProjectId || "").trim();
  if (ex) return ex;
  const { ok, status, json, text } = await doDigitalOceanApi(token, "/v2/projects");
  if (!ok || !json || typeof json !== "object") {
    const msg =
      (json && typeof json === "object" && typeof json.message === "string"
        ? json.message
        : null) || text.slice(0, 400);
    throw new Error(msg || `Could not list projects (HTTP ${status})`);
  }
  const projects = /** @type {unknown[]} */ (
    /** @type {Record<string, unknown>} */ (json).projects || []
  );
  const def = projects.find(
    (p) => p && typeof p === "object" && /** @type {any} */ (p).is_default === true
  );
  const first = projects[0];
  const pick = def || first;
  const id =
    pick && typeof pick === "object"
      ? String(
          /** @type {Record<string, unknown>} */ (pick).id ??
            /** @type {Record<string, unknown>} */ (pick).uuid ??
            ""
        ).trim()
      : "";
  if (!id) {
    throw new Error(
      "No DigitalOcean project found. Create a project in the control panel, or pass project_id in the create request."
    );
  }
  return id;
}

/**
 * @param {string} token
 * @param {string | undefined} explicitModelUuid
 */
async function resolveEmbeddingModelUuid(token, explicitModelUuid) {
  const ex = String(explicitModelUuid || "").trim();
  if (ex) return ex;
  const envId = String(process.env.TIDEAI_EMBEDDING_MODEL_UUID || "").trim();
  if (envId) return envId;

  const { ok, json, text } = await doDigitalOceanApi(
    token,
    "/v2/gen-ai/models?per_page=100"
  );
  if (!ok) {
    const msg =
      (json && typeof json === "object" && typeof json.message === "string"
        ? json.message
        : null) || text.slice(0, 400);
    throw new Error(msg || "Could not list Gen-AI models");
  }
  const arr = Array.isArray(
    /** @type {Record<string, unknown>} */ (json)?.models
  )
    ? /** @type {unknown[]} */ (
        /** @type {Record<string, unknown>} */ (json).models
      )
    : [];

  /**
   * DigitalOcean's GenAI models API now exposes embedding models via
   * `type: "embedding"` + `capabilities: ["vectorization"]`. The old field
   * name was `usecases: ["KNOWLEDGEBASE"]` — both schemas are checked here so
   * the code keeps working if either is present.
   */
  function isEmbeddingModel(model, row) {
    const type = String(model.type || row?.type || "").toLowerCase();
    if (type === "embedding") return true;
    const caps = Array.isArray(model.capabilities)
      ? model.capabilities
      : Array.isArray(row?.capabilities)
        ? row.capabilities
        : [];
    if (caps.some((c) => String(c).toLowerCase().includes("vector"))) return true;
    const usecases = Array.isArray(model.usecases)
      ? model.usecases
      : Array.isArray(row?.usecases)
        ? row.usecases
        : [];
    if (usecases.some((u) => String(u).toUpperCase().includes("KNOWLEDGEBASE"))) return true;
    return false;
  }

  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (row);
    const model = /** @type {Record<string, unknown>} */ (o.model || o);
    if (!isEmbeddingModel(model, o)) continue;
    const uuid = String(model.uuid || "").trim();
    if (uuid) return uuid;
  }
  throw new Error(
    "No suitable embedding model found in DO catalog (looked for type=embedding or capabilities including 'vector'). Set TIDEAI_EMBEDDING_MODEL_UUID on the server or pass embedding_model_uuid when creating a KB."
  );
}

/**
 * @param {string} token DigitalOcean API token
 * @returns {Promise<{ knowledge_bases: { uuid: string, name: string }[] }>}
 */
export async function listKnowledgeBasesForToken(token) {
  const { ok, json, text } = await doDigitalOceanApi(token, "/v2/gen-ai/knowledge_bases");
  if (!ok) {
    const msg =
      (json && typeof json === "object" && typeof json.message === "string"
        ? json.message
        : null) || text.slice(0, 600);
    throw new Error(msg || "Could not list knowledge bases");
  }
  return { knowledge_bases: normalizeKnowledgeBaseList(json) };
}

/**
 * Create an empty Knowledge Base (no data sources yet). Caller can add PDFs via Gen-AI APIs.
 *
 * @param {string} token
 * @param {{
 *   name?: string;
 *   region?: string;
 *   project_id?: string;
 *   embedding_model_uuid?: string;
 *   vpc_uuid?: string;
 * }} opts
 */
export async function createKnowledgeBaseForToken(token, opts = {}) {
  const name =
    String(opts.name || "").trim() ||
    `tideai-kb-${Date.now().toString(36)}`;
  const region =
    String(opts.region || "").trim() ||
    String(process.env.TIDEAI_KB_REGION || "").trim() ||
    "tor1";

  const project_id = await resolveProjectId(token, opts.project_id);
  const embedding_model_uuid = await resolveEmbeddingModelUuid(
    token,
    opts.embedding_model_uuid
  );

  /** @type {Record<string, unknown>} */
  const body = {
    name,
    project_id,
    embedding_model_uuid,
    region,
  };
  const vpc =
    String(opts.vpc_uuid || "").trim() ||
    String(process.env.TIDEAI_KB_VPC_UUID || "").trim();
  if (vpc) body.vpc_uuid = vpc;

  const { ok, json, text } = await doDigitalOceanApi(
    token,
    "/v2/gen-ai/knowledge_bases",
    { method: "POST", body }
  );
  if (!ok) {
    const msg =
      (json && typeof json === "object" && typeof json.message === "string"
        ? json.message
        : null) || text.slice(0, 800);
    throw new Error(msg || `Create knowledge base failed (HTTP)`);
  }

  const root = json && typeof json === "object" ? json : {};
  const kb =
    /** @type {Record<string, unknown>} */ (root).knowledge_base ||
    /** @type {Record<string, unknown>} */ (root).knowledgeBase ||
    root;
  const kbObj = kb && typeof kb === "object" ? /** @type {Record<string, unknown>} */ (kb) : {};
  const uuid = String(kbObj.uuid || kbObj.id || "").trim();
  if (!uuid) {
    throw new Error(
      "Knowledge base create response did not include a uuid (check token GenAI scopes)."
    );
  }
  const displayName = String(kbObj.name || name).trim();
  return { uuid, name: displayName || name };
}
