import https from "https";
import { URL } from "url";

const UPSTREAM = "inference.do-ai.run";
const MAX_SHIM_BODY_BYTES = 25 * 1024 * 1024;
const ASYNC_POLL_MS = 1500;
const ASYNC_DEADLINE_MS = 120_000;

/**
 * Remember the bearer used to start an async-invoke job so we can re-attach it on the
 * polling GETs (`/v1/async-invoke/<id>` and `/v1/async-invoke/<id>/status`) when generated
 * apps forget the Authorization header on subsequent fetches. Without this, DO returns
 * 401 "Unable to authenticate you" on every status poll.
 */
const ASYNC_AUTH_TTL_MS = 30 * 60 * 1000;
const ASYNC_AUTH_MAX_ENTRIES = 1000;
/** @type {Map<string, { authorization: string; expiresAt: number }>} */
const asyncInvokeAuthCache = new Map();

function pruneAsyncAuthCache() {
  const now = Date.now();
  for (const [k, v] of asyncInvokeAuthCache) {
    if (v.expiresAt <= now) asyncInvokeAuthCache.delete(k);
  }
  while (asyncInvokeAuthCache.size > ASYNC_AUTH_MAX_ENTRIES) {
    const oldest = asyncInvokeAuthCache.keys().next().value;
    if (!oldest) break;
    asyncInvokeAuthCache.delete(oldest);
  }
}

function rememberAsyncInvokeAuth(requestId, authorization) {
  if (!requestId || !authorization) return;
  asyncInvokeAuthCache.set(requestId, {
    authorization,
    expiresAt: Date.now() + ASYNC_AUTH_TTL_MS,
  });
  pruneAsyncAuthCache();
}

function recallAsyncInvokeAuth(requestId) {
  const e = asyncInvokeAuthCache.get(requestId);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) {
    asyncInvokeAuthCache.delete(requestId);
    return null;
  }
  return e.authorization;
}

/**
 * Local previews use Vite `base` `/preview/<buildId>/`. If generated code prefixes
 * `fetch` with `import.meta.env.BASE_URL`, the browser calls
 * `/preview/<id>/api/inference/...` instead of `/api/inference/...`, missing this
 * middleware and often hitting `express.static` → **405** on POST.
 *
 * @param {string} originalUrl `req.originalUrl`
 */
function canonicalInferenceOriginalUrl(originalUrl) {
  const q = originalUrl.indexOf("?");
  const pathOnly = q === -1 ? originalUrl : originalUrl.slice(0, q);
  const qs = q === -1 ? "" : originalUrl.slice(q);
  const m = pathOnly.match(/^\/preview\/[^/]+(\/api\/inference(?:\/|$).*)$/);
  if (m) return m[1] + qs;
  return originalUrl;
}

/**
 * @param {import("http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function collectRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {{ method: string; path: string; authorization?: string; bodyObj?: unknown }}
 */
function httpsInferenceJson({ method, path: pathStr, authorization, bodyObj }) {
  const bodyStr =
    bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined;
  /** @type {Record<string, string | number>} */
  const h = { host: UPSTREAM };
  if (authorization) h.authorization = authorization;
  if (bodyStr !== undefined) {
    h["content-type"] = "application/json";
    h["content-length"] = Buffer.byteLength(bodyStr, "utf8");
  }
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: UPSTREAM,
        port: 443,
        method,
        path: pathStr,
        headers: h,
      },
      (up) => {
        const chunks = [];
        up.on("data", (c) => chunks.push(c));
        up.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            /* leave null */
          }
          resolve({
            statusCode: up.statusCode || 0,
            headers: up.headers,
            raw,
            json,
          });
        });
      }
    );
    r.on("error", reject);
    if (bodyStr !== undefined) r.write(bodyStr, "utf8");
    r.end();
  });
}

/**
 * Codegen often still emits `POST /v1/models/<id>/infer` + flat JSON; DO expects
 * `POST /v1/async-invoke` + poll. Bridge here so old generated apps work.
 *
 * @param {string} modelPathSegment from URL (may include slashes if decoded)
 * @param {Record<string, unknown>} parsed
 */
function buildAsyncInvokeBody(modelPathSegment, parsed) {
  const modelId = decodeURIComponent(modelPathSegment);
  if (parsed && typeof parsed === "object" && parsed.input != null) {
    return {
      model_id:
        typeof parsed.model_id === "string" && parsed.model_id.trim()
          ? parsed.model_id
          : modelId,
      input: parsed.input,
      ...(Array.isArray(parsed.tags) ? { tags: parsed.tags } : {}),
    };
  }
  const flat =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  delete flat.model_id;
  delete flat.input;
  delete flat.tags;
  return { model_id: modelId, input: flat };
}

/**
 * @param {unknown} node
 * @param {string[]} acc
 * @param {number} depth
 */
function collectImageLikeUrls(node, acc, depth) {
  if (depth > 14 || node == null) return;
  if (Array.isArray(node)) {
    for (const x of node) collectImageLikeUrls(x, acc, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = /** @type {Record<string, unknown>} */ (node);
  if (typeof o.url === "string" && /^https:\/\//i.test(o.url)) {
    const u = o.url;
    const ct = typeof o.content_type === "string" ? o.content_type : "";
    if (
      ct.startsWith("image/") ||
      /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(u)
    ) {
      acc.push(u);
    }
  }
  for (const v of Object.values(o)) collectImageLikeUrls(v, acc, depth + 1);
}

/**
 * DO nests media under `output`; LLM-generated UIs often expect OpenAI-like `data[].url`
 * or a flat `image_url`. Docs sometimes say COMPLETE vs COMPLETED — accept both.
 *
 * @param {unknown} body async-invoke GET payload
 */
function enrichLegacyInferResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const b = /** @type {Record<string, unknown>} */ (body);
  const urls = [];

  const pushUrl = (u) => {
    if (typeof u === "string" && /^https?:\/\//i.test(u)) urls.push(u);
  };

  const outObj = b.output;
  if (outObj && typeof outObj === "object" && !Array.isArray(outObj)) {
    const o = /** @type {Record<string, unknown>} */ (outObj);
    if (Array.isArray(o.images)) {
      for (const im of o.images) {
        if (im && typeof im === "object" && typeof im.url === "string") pushUrl(im.url);
      }
    }
    const img = o.image;
    if (img && typeof img === "object" && typeof img.url === "string") pushUrl(img.url);
    if (typeof o.url === "string") pushUrl(o.url);
  }
  if (Array.isArray(outObj)) {
    collectImageLikeUrls(outObj, urls, 0);
  }
  if (Array.isArray(b.images)) {
    for (const im of b.images) {
      if (im && typeof im === "object" && typeof im.url === "string") pushUrl(im.url);
    }
  }

  if (urls.length === 0 && outObj && typeof outObj === "object") {
    collectImageLikeUrls(outObj, urls, 0);
  }

  if (urls.length === 0) return body;

  const unique = [...new Set(urls)];
  return {
    ...b,
    image_url: unique[0],
    image_urls: unique,
    data: unique.map((url) => ({ url })),
  };
}

/**
 * @param {string | undefined} authorization
 * @param {string} requestId
 */
async function pollUntilAsyncInvokeDone(authorization, requestId) {
  const id = encodeURIComponent(requestId);
  const deadline = Date.now() + ASYNC_DEADLINE_MS;
  while (Date.now() < deadline) {
    const st = await httpsInferenceJson({
      method: "GET",
      path: `/v1/async-invoke/${id}/status`,
      authorization,
    });
    const raw =
      st.json && typeof st.json === "object" && typeof st.json.status === "string"
        ? st.json.status
        : "";
    const status = raw.toUpperCase();
    if (status === "FAILED") {
      return { ok: false, statusCode: st.statusCode, body: st.json ?? { raw: st.raw } };
    }
    if (status === "COMPLETED" || status === "COMPLETE") {
      const fin = await httpsInferenceJson({
        method: "GET",
        path: `/v1/async-invoke/${id}`,
        authorization,
      });
      return {
        ok: fin.statusCode >= 200 && fin.statusCode < 300,
        statusCode: fin.statusCode,
        body: fin.json ?? { raw: fin.raw },
      };
    }
    await new Promise((r) => setTimeout(r, ASYNC_POLL_MS));
  }
  return {
    ok: false,
    statusCode: 504,
    body: {
      error: "inference_proxy_timeout",
      message: `async-invoke exceeded ${ASYNC_DEADLINE_MS}ms`,
    },
  };
}

/**
 * @param {import("express").Response} res
 * @param {import("express").Request} req
 * @param {number} statusCode
 * @param {unknown} body
 */
function sendInferenceJson(res, req, statusCode, body) {
  const origin = req.headers.origin || "*";
  res.status(statusCode);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.send(JSON.stringify(body));
}

/**
 * Same-origin proxy for DigitalOcean Serverless Inference so browser apps avoid CORS
 * (OPTIONS to inference.do-ai.run returns 401 without a usable preflight).
 *
 * Also bridges legacy `POST /v1/models/.../infer` (still emitted by LLMs) to
 * `/v1/async-invoke` + server-side polling so the browser gets a final JSON payload.
 */
export function createInferenceProxy() {
  return (req, res, next) => {
    const canonical = canonicalInferenceOriginalUrl(req.originalUrl);
    const pathname = canonical.split("?")[0];
    if (!pathname.startsWith("/api/inference")) {
      next();
      return;
    }

    if (req.method === "OPTIONS") {
      const origin = req.headers.origin || "*";
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        req.headers["access-control-request-headers"] ||
          "authorization, content-type"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
      res.status(204).end();
      return;
    }

    const u = new URL(
      canonical,
      `http://127.0.0.1:${req.socket?.localPort || 80}`
    );
    const tail = u.pathname.slice("/api/inference".length) + u.search;
    const pathOnUpstream = tail.startsWith("/") ? tail : `/${tail}`;
    const upstreamPathOnly = pathOnUpstream.split("?")[0];
    const legacyInfer = upstreamPathOnly.match(/^\/v1\/models\/(.+)\/infer$/);
    const asyncInvokeStart =
      req.method === "POST" &&
      (upstreamPathOnly === "/v1/async-invoke" ||
        upstreamPathOnly === "/v1/async-invoke/");
    const asyncInvokeDetailMatch = upstreamPathOnly.match(
      /^\/v1\/async-invoke\/([^/]+)(?:\/status)?$/
    );

    /**
     * Generated apps sometimes call `fetch(.../v1/async-invoke/<id>/status)` without
     * `Authorization`. If we remember the bearer the same browser used to start the job,
     * re-attach it here so DO does not 401 the polls.
     */
    if (
      req.method === "GET" &&
      asyncInvokeDetailMatch &&
      !req.headers.authorization
    ) {
      const id = decodeURIComponent(asyncInvokeDetailMatch[1] || "");
      const remembered = recallAsyncInvokeAuth(id);
      if (remembered) req.headers.authorization = remembered;
    }

    if (legacyInfer && req.method === "POST") {
      const authorization = req.headers.authorization;
      if (!authorization) {
        sendInferenceJson(res, req, 401, {
          error: "unauthorized",
          message: "Authorization: Bearer <DO token> is required",
        });
        return;
      }

      void (async () => {
        try {
          const buf = await collectRequestBody(req, MAX_SHIM_BODY_BYTES);
          let parsed = {};
          if (buf.length) {
            try {
              parsed = JSON.parse(buf.toString("utf8"));
            } catch {
              sendInferenceJson(res, req, 400, {
                error: "invalid_json",
                message: "Request body must be JSON for /v1/models/.../infer",
              });
              return;
            }
          }
          if (!parsed || typeof parsed !== "object") parsed = {};

          const invokeBody = buildAsyncInvokeBody(legacyInfer[1], parsed);
          const start = await httpsInferenceJson({
            method: "POST",
            path: "/v1/async-invoke",
            authorization,
            bodyObj: invokeBody,
          });

          if (!start.json || start.statusCode < 200 || start.statusCode >= 300) {
            sendInferenceJson(
              res,
              req,
              start.statusCode || 502,
              start.json ?? { raw: start.raw }
            );
            return;
          }

          const requestId = start.json.request_id;
          if (typeof requestId !== "string" || !requestId) {
            sendInferenceJson(res, req, 502, {
              error: "inference_proxy_bad_response",
              message: "async-invoke response missing request_id",
              upstream: start.json,
            });
            return;
          }

          const done = await pollUntilAsyncInvokeDone(authorization, requestId);
          const payload =
            done.ok && done.body != null
              ? enrichLegacyInferResponse(done.body)
              : done.body;
          sendInferenceJson(
            res,
            req,
            done.ok ? (done.statusCode || 200) : done.statusCode || 502,
            payload
          );
        } catch (e) {
          if (!res.headersSent) {
            const msg = e instanceof Error ? e.message : String(e);
            const code =
              msg === "request body too large" ? 413 : 502;
            sendInferenceJson(res, req, code, {
              error: "inference_proxy_failed",
              message: msg,
            });
          }
        }
      })();
      return;
    }

    /** @type {Record<string, string | string[]>} */
    const fwd = { host: UPSTREAM };
    const pass = [
      "authorization",
      "content-type",
      "accept",
      "content-length",
    ];
    for (const k of pass) {
      const v = req.headers[k];
      if (v) fwd[k] = v;
    }

    const upstreamReq = https.request(
      {
        hostname: UPSTREAM,
        port: 443,
        method: req.method,
        path: pathOnUpstream || "/",
        headers: fwd,
      },
      (upstreamRes) => {
        const origin = req.headers.origin || "*";

        /**
         * For POST `/v1/async-invoke`, buffer the (small JSON) response so we can
         * extract `request_id` and remember the caller's bearer for the polling GETs.
         * Other paths are streamed straight through as before.
         */
        if (asyncInvokeStart) {
          const chunks = [];
          upstreamRes.on("data", (c) => chunks.push(c));
          upstreamRes.on("end", () => {
            const buf = Buffer.concat(chunks);
            const upstreamAuth = req.headers.authorization;
            const status = upstreamRes.statusCode || 0;
            if (
              status >= 200 &&
              status < 300 &&
              typeof upstreamAuth === "string" &&
              upstreamAuth.trim()
            ) {
              try {
                const j = JSON.parse(buf.toString("utf8"));
                const rid =
                  typeof j?.request_id === "string"
                    ? j.request_id
                    : typeof j?.id === "string"
                      ? j.id
                      : "";
                if (rid) rememberAsyncInvokeAuth(rid, upstreamAuth);
              } catch {
                /* non-JSON upstream response — nothing to remember */
              }
            }
            res.statusCode = status || 502;
            for (const [k, v] of Object.entries(upstreamRes.headers)) {
              if (!k) continue;
              const lk = k.toLowerCase();
              if (lk === "transfer-encoding" || lk === "content-length") continue;
              if (Array.isArray(v)) {
                for (const item of v) res.append(k, item);
              } else if (v !== undefined) {
                res.setHeader(k, v);
              }
            }
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Credentials", "true");
            res.setHeader("Content-Length", String(buf.length));
            res.end(buf);
          });
          return;
        }

        res.statusCode = upstreamRes.statusCode || 502;
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (!k || k.toLowerCase() === "transfer-encoding") continue;
          if (Array.isArray(v)) {
            for (const item of v) res.append(k, item);
          } else if (v !== undefined) {
            res.setHeader(k, v);
          }
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on("error", (e) => {
      if (!res.headersSent) {
        res.status(502).type("application/json").json({
          error: "inference_proxy_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });

    req.pipe(upstreamReq);
  };
}
