import { promises as dnsPromises } from "dns";
import https from "https";

/**
 * DigitalOcean App Platform sometimes marks an app `ACTIVE` and returns its
 * `live_url` a few seconds before the public DNS record is propagated. If the
 * user's iframe loads the URL during that window, the local resolver caches
 * NXDOMAIN — and macOS / many ISPs cache that negative answer for 5 minutes,
 * so the page stays "unreachable" long after DNS is actually fine.
 *
 * To avoid that race, after pollUntilLive we resolve the hostname through
 * **public DNS** (Google / Cloudflare) and HEAD the URL until it answers 2xx
 * or 3xx. Once that succeeds we know the authoritative side is good; the
 * user's first lookup (via their local resolver) will hit upstream and cache
 * the positive answer, not NXDOMAIN.
 */

const PUBLIC_DNS = ["8.8.8.8", "1.1.1.1"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolve a hostname using a fresh public resolver, bypassing the OS cache.
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
async function resolveViaPublicDns(hostname) {
  const r = new dnsPromises.Resolver();
  r.setServers(PUBLIC_DNS);
  return r.resolve4(hostname);
}

/**
 * HEAD request to a specific IP with explicit Host header + SNI so we can
 * verify the upstream server is actually serving the hostname without going
 * through the OS resolver. Resolves to `true` on 200–399.
 *
 * @param {string} hostname
 * @param {string} ip
 * @param {number} port
 * @param {string} path
 */
function httpsHeadViaIp(hostname, ip, port, path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = https.request(
      {
        host: ip,
        port,
        method: "HEAD",
        path,
        headers: { Host: hostname },
        servername: hostname,
        timeout: 8000,
      },
      (res) => {
        const code = res.statusCode || 0;
        res.resume();
        done(code >= 200 && code < 400);
      }
    );
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });
}

/**
 * Polls until the public URL is genuinely reachable (or `timeoutMs` elapses).
 *
 * @param {string} url
 * @param {{ timeoutMs?: number, onProgress?: (msg: string) => void }} [opts]
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function waitUntilReachable(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const u = new URL(url);
  const port = u.port ? Number(u.port) : 443;
  const path = u.pathname || "/";
  const deadline = Date.now() + timeoutMs;
  let lastErr = "no attempt";

  while (Date.now() < deadline) {
    try {
      const addrs = await resolveViaPublicDns(u.hostname);
      if (!addrs?.length) {
        lastErr = "no A records yet";
        opts.onProgress?.(lastErr);
        await sleep(3000);
        continue;
      }
      const ok = await httpsHeadViaIp(u.hostname, addrs[0], port, path);
      if (ok) {
        opts.onProgress?.("Reachable");
        return { ok: true };
      }
      lastErr = "HTTP not ready";
    } catch (e) {
      lastErr = e?.code || e?.message || String(e);
    }
    opts.onProgress?.(lastErr);
    await sleep(3000);
  }
  return { ok: false, error: lastErr };
}
