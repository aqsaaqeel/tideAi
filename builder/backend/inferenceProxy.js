import https from "https";
import { URL } from "url";

const UPSTREAM = "inference.do-ai.run";

/**
 * Same-origin proxy for DigitalOcean Serverless Inference so browser apps avoid CORS
 * (OPTIONS to inference.do-ai.run returns 401 without a usable preflight).
 *
 * Client: `fetch("/api/inference/v1/models/.../infer", { headers: { Authorization: "Bearer …" } })`
 * → `https://inference.do-ai.run/v1/models/.../infer`
 */
export function createInferenceProxy() {
  return (req, res, next) => {
    const pathname = req.originalUrl.split("?")[0];
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
      req.originalUrl,
      `http://127.0.0.1:${req.socket?.localPort || 80}`
    );
    const tail = u.pathname.slice("/api/inference".length) + u.search;
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
          error: "inference_proxy_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    });

    req.pipe(upstreamReq);
  };
}
