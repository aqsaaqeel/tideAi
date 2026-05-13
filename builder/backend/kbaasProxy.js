import https from "https";
import { URL } from "url";

const UPSTREAM = "kbaas.do-ai.run";

/**
 * @param {string} originalUrl `req.originalUrl`
 */
function canonicalKbaasOriginalUrl(originalUrl) {
  const q = originalUrl.indexOf("?");
  const pathOnly = q === -1 ? originalUrl : originalUrl.slice(0, q);
  const qs = q === -1 ? "" : originalUrl.slice(q);
  const m = pathOnly.match(/^\/preview\/[^/]+(\/api\/kbaas(?:\/|$).*)$/);
  if (m) return m[1] + qs;
  return originalUrl;
}

/**
 * Same-origin proxy for DigitalOcean Knowledge Base retrieval (`kbaas.do-ai.run`)
 * so browser apps avoid CORS on preflight (same pattern as Serverless Inference).
 */
export function createKbaasProxy() {
  return (req, res, next) => {
    const canonical = canonicalKbaasOriginalUrl(req.originalUrl);
    const pathname = canonical.split("?")[0];
    if (!pathname.startsWith("/api/kbaas")) {
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
          "authorization, content-type, accept"
      );
      res.setHeader("Access-Control-Max-Age", "86400");
      res.status(204).end();
      return;
    }

    const u = new URL(
      canonical,
      `http://127.0.0.1:${req.socket?.localPort || 80}`
    );
    const tail = u.pathname.slice("/api/kbaas".length) + u.search;
    const pathOnUpstream = tail.startsWith("/") ? tail : `/${tail}`;

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
          error: "kbaas_proxy_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });

    req.pipe(upstreamReq);
  };
}
