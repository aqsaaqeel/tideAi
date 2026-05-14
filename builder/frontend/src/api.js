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
 * Submit a new build. The server parks the build at `awaiting_approval` once codegen
 * finishes and surfaces the blueprint + cost via SSE. The caller approves/cancels
 * with {@link postApprove}/{@link postCancel}.
 *
 * @param {{ prompt: string }} body
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
 * Approve a parked build. Server moves it from `awaiting_approval` to `provisioning`
 * and the SSE stream continues to surface progress.
 */
export async function postApprove(buildId) {
  const res = await fetch(
    `${apiBase()}/api/build/${encodeURIComponent(buildId)}/approve`,
    { method: "POST" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Approve failed (${res.status})`);
  }
  return data;
}

/**
 * Cancel a parked build before provisioning starts. Once provisioning has begun this
 * endpoint returns 409 — the caller should treat that as "too late to cancel" and let
 * the build continue.
 */
export async function postCancel(buildId) {
  const res = await fetch(
    `${apiBase()}/api/build/${encodeURIComponent(buildId)}/cancel`,
    { method: "POST" }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Cancel failed (${res.status})`);
  }
  return data;
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
