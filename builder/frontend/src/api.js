const base = () => {
  const raw = import.meta.env.VITE_API_URL;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    return String(raw).replace(/\/$/, "");
  }
  if (import.meta.env.DEV) {
    return "http://localhost:3001".replace(/\/$/, "");
  }
  return "";
};

/**
 * @returns {Promise<{ default_do_token_configured: boolean }>}
 */
export async function fetchConfig() {
  const res = await fetch(`${base()}/api/config`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Config request failed (${res.status})`);
  }
  return {
    default_do_token_configured: Boolean(data.default_do_token_configured),
  };
}

/**
 * @param {{ prompt: string, do_token?: string, github_token?: string, deploy_mode?: string }} body
 * @returns {Promise<{ build_id: string, deploy_mode: string }>}
 */
export async function postBuild(body) {
  const res = await fetch(`${base()}/api/build`, {
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
 * @param {string} buildId
 * @param {(state: object) => void} onEvent
 * @returns {() => void} cleanup — closes EventSource
 */
export function subscribeBuild(buildId, onEvent) {
  const url = `${base()}/api/build/${encodeURIComponent(buildId)}`;
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
