/** Base URL for the tideAI backend API (no trailing slash). */
export function apiBase() {
  const raw = import.meta.env.VITE_API_URL;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw).replace(/\/$/, "");
  }
  if (import.meta.env.DEV) {
    return "http://localhost:3001".replace(/\/$/, "");
  }
  return "";
}

/**
 * @returns {Promise<{ default_do_token_configured: boolean }>}
 */
export async function fetchConfig() {
  const res = await fetch(`${apiBase()}/api/config`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Config request failed (${res.status})`);
  }
  return {
    default_do_token_configured: Boolean(data.default_do_token_configured),
  };
}

/**
 * @param {{ prompt: string, do_token?: string, knowledge_base_id?: string, github_token?: string, deploy_mode?: string }} body
 * @returns {Promise<{ build_id: string, deploy_mode: string }>}
 */
export async function postBuild(body) {
  const res = await fetch(`${apiBase()}/api/build`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Build request failed (${res.status})`);
  }
  if (!data.build_id) {
    throw new Error("Invalid response: missing build_id");
  }
  return { build_id: data.build_id, deploy_mode: data.deploy_mode || "docr" };
}

/**
 * List DigitalOcean Knowledge Bases for the given token (or server default token).
 *
 * @param {string | undefined} do_token optional; omit or empty to use server default when configured
 * @returns {Promise<{ knowledge_bases: { uuid: string, name: string }[] }>}
 */
export async function postKnowledgeBasesList(do_token) {
  const body =
    typeof do_token === "string" && do_token.trim()
      ? { do_token: do_token.trim() }
      : {};
  const res = await fetch(`${apiBase()}/api/knowledge-bases/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : `Knowledge bases list failed (${res.status})`
    );
  }
  const list = Array.isArray(data.knowledge_bases) ? data.knowledge_bases : [];
  return { knowledge_bases: list };
}

/**
 * Create a new DigitalOcean Knowledge Base (empty; add files via the generated app or DO console).
 *
 * @param {Record<string, unknown>} payload optional do_token, name, region, project_id, embedding_model_uuid, vpc_uuid
 * @returns {Promise<{ knowledge_base: { uuid: string, name: string } }>}
 */
export async function postKnowledgeBasesCreate(payload = {}) {
  const res = await fetch(`${apiBase()}/api/knowledge-bases/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : typeof data.message === "string"
          ? data.message
          : `Create knowledge base failed (${res.status})`
    );
  }
  const kb = data.knowledge_base;
  if (!kb || typeof kb.uuid !== "string") {
    throw new Error("Invalid response: missing knowledge_base.uuid");
  }
  return {
    knowledge_base: {
      uuid: kb.uuid,
      name: typeof kb.name === "string" ? kb.name : kb.uuid,
    },
  };
}

/**
 * @param {string} buildId
 * @param {(state: object) => void} onEvent
 * @returns {() => void} cleanup — closes EventSource
 */
export function subscribeBuild(buildId, onEvent) {
  const url = `${apiBase()}/api/build/${encodeURIComponent(buildId)}`;
  const es = new EventSource(url);

  es.onmessage = (ev) => {
    try {
      const state = JSON.parse(ev.data);
      onEvent(state);
    } catch {
      /* ignore malformed */
    }
  };

  es.onerror = () => {
    /* browser auto-reconnects; caller may still get updates */
  };

  return () => {
    es.close();
  };
}
