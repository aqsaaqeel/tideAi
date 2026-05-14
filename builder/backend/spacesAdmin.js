import crypto from "crypto";

/**
 * Minimal AWS SigV4 signer for DigitalOcean Spaces (S3-compatible).
 * https://docs.digitalocean.com/reference/api/spaces-api/
 *
 * We avoid the `aws-sdk` dependency to keep the backend tiny. Two surface APIs:
 *   - {@link createSpacesBucketForToken} — PUT a path-style bucket creation request.
 *   - {@link presignSpacesPutUrl} — generate a query-string-signed PUT URL the browser can use.
 */

const DEFAULT_REGION = "tor1";

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hmac(key, value) {
  return crypto.createHmac("sha256", key).update(value).digest();
}

/**
 * AWS-style URI encoding: RFC 3986 unreserved characters stay literal; everything else is %HH.
 * Note: the standard JavaScript `encodeURIComponent` already matches RFC 3986 for most chars but
 * leaves `!`, `'`, `(`, `)`, `*` unencoded — which is actually what S3 SigV4 wants.
 */
function awsUriEncode(str, encodeSlash = true) {
  let out = "";
  for (const ch of str) {
    if (
      (ch >= "A" && ch <= "Z") ||
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~"
    ) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += "/";
    } else {
      const bytes = Buffer.from(ch, "utf8");
      for (const b of bytes) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function isoDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac("AWS4" + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Build a presigned PUT URL valid for `expiresSeconds`. The browser then PUTs the file bytes
 * directly to this URL with `Content-Type: <contentType>`.
 *
 * @param {{
 *   key: string,
 *   bucket: string,
 *   region?: string,
 *   accessKey: string,
 *   secretKey: string,
 *   expiresSeconds?: number,
 *   contentType?: string,
 * }} opts
 * @returns {{ url: string, headers: Record<string, string>, expires_at: string }}
 */
export function presignSpacesPutUrl(opts) {
  const region = String(opts.region || DEFAULT_REGION);
  const bucket = String(opts.bucket || "").trim();
  const key = String(opts.key || "").replace(/^\/+/, "");
  if (!bucket) throw new Error("presignSpacesPutUrl: bucket is required");
  if (!key) throw new Error("presignSpacesPutUrl: key is required");
  if (!opts.accessKey || !opts.secretKey) {
    throw new Error(
      "presignSpacesPutUrl: DO_SPACES_KEY and DO_SPACES_SECRET must be set in the environment"
    );
  }

  const host = `${bucket}.${region}.digitaloceanspaces.com`;
  const now = new Date();
  const amzDate = isoDateTime(now);
  const dateStamp = amzDate.slice(0, 8);
  const expires = Math.max(60, Math.min(opts.expiresSeconds ?? 900, 3600));

  const credential = `${opts.accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const signedHeaders = "host";
  const algorithm = "AWS4-HMAC-SHA256";

  const queryParams = {
    "X-Amz-Algorithm": algorithm,
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const sortedKeys = Object.keys(queryParams).sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(queryParams[k])}`)
    .join("&");

  const canonicalUri = "/" + awsUriEncode(key, false);
  const canonicalHeaders = `host:${host}\n`;
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const sigKey = signingKey(opts.secretKey, dateStamp, region, "s3");
  const signature = crypto
    .createHmac("sha256", sigKey)
    .update(stringToSign)
    .digest("hex");

  const url = `https://${host}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  const headers = {};
  if (opts.contentType) headers["Content-Type"] = String(opts.contentType);
  const expires_at = new Date(now.getTime() + expires * 1000).toISOString();
  return { url, headers, expires_at };
}

/**
 * Sign a PUT request to create a bucket. Path-style (`<region>.digitaloceanspaces.com/<bucket>`).
 */
function signCreateBucket(opts) {
  const region = String(opts.region || DEFAULT_REGION);
  const bucket = String(opts.bucket || "").trim();
  if (!bucket) throw new Error("signCreateBucket: bucket is required");

  const host = `${region}.digitaloceanspaces.com`;
  const now = new Date();
  const amzDate = isoDateTime(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex("");
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalUri = "/" + awsUriEncode(bucket, false);
  const canonicalQueryString = "";
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const sigKey = signingKey(opts.secretKey, dateStamp, region, "s3");
  const signature = crypto
    .createHmac("sha256", sigKey)
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${opts.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      Host: host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    },
  };
}

/**
 * Sign a PUT request to `${host}/${bucket}?cors` with a CORS configuration XML body.
 *
 * SigV4 with `host;x-amz-content-sha256;x-amz-date` signed headers, region-scoped to `s3`.
 * The `?cors` query string is part of the canonical request (sorted query params).
 *
 * @param {{ bucket: string, region: string, accessKey: string, secretKey: string, xmlBody: string }} opts
 */
function signPutBucketCors(opts) {
  const region = String(opts.region || DEFAULT_REGION);
  const bucket = String(opts.bucket || "").trim();
  if (!bucket) throw new Error("signPutBucketCors: bucket is required");

  const host = `${region}.digitaloceanspaces.com`;
  const now = new Date();
  const amzDate = isoDateTime(now);
  const dateStamp = amzDate.slice(0, 8);
  /**
   * S3 requires the body's MD5 in `Content-MD5` and the body's SHA-256 in
   * `x-amz-content-sha256` for `PUT ?cors`. Without `Content-MD5` some
   * implementations reject the request with `MissingContentMD5`.
   */
  const bodyBuf = Buffer.from(opts.xmlBody, "utf8");
  const contentMd5 = crypto.createHash("md5").update(bodyBuf).digest("base64");
  const payloadHash = sha256Hex(bodyBuf);
  const signedHeaders = "content-md5;host;x-amz-content-sha256;x-amz-date";
  const canonicalUri = "/" + awsUriEncode(bucket, false);
  const canonicalQueryString = "cors=";
  const canonicalHeaders =
    `content-md5:${contentMd5}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    "PUT",
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const sigKey = signingKey(opts.secretKey, dateStamp, region, "s3");
  const signature = crypto
    .createHmac("sha256", sigKey)
    .update(stringToSign)
    .digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 ` +
    `Credential=${opts.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, ` +
    `Signature=${signature}`;

  return {
    url: `https://${host}${canonicalUri}?cors`,
    headers: {
      Host: host,
      "Content-MD5": contentMd5,
      "Content-Type": "application/xml",
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: authorization,
    },
    body: bodyBuf,
  };
}

/**
 * Build a permissive CORS XML configuration suitable for browser presigned PUT uploads.
 *
 * Without this, the browser's preflight `OPTIONS` for `PUT` requests with
 * non-safelisted `Content-Type` (e.g. `application/pdf`) fails — the bucket
 * returns no `Access-Control-Allow-*` headers and the PUT never fires, which
 * is why Tier B InfoBot apps appear "stuck on uploading" indefinitely.
 *
 * Origins is `*` because each generated app gets its own (unpredictable) App
 * Platform / preview URL; we trust the presigned URL's signature as the
 * capability check.
 */
function defaultSpacesCorsXml() {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
    `<CORSRule>` +
    `<AllowedOrigin>*</AllowedOrigin>` +
    `<AllowedMethod>PUT</AllowedMethod>` +
    `<AllowedMethod>POST</AllowedMethod>` +
    `<AllowedMethod>GET</AllowedMethod>` +
    `<AllowedMethod>HEAD</AllowedMethod>` +
    `<AllowedMethod>DELETE</AllowedMethod>` +
    `<AllowedHeader>*</AllowedHeader>` +
    `<ExposeHeader>ETag</ExposeHeader>` +
    `<ExposeHeader>x-amz-request-id</ExposeHeader>` +
    `<MaxAgeSeconds>3600</MaxAgeSeconds>` +
    `</CORSRule>` +
    `</CORSConfiguration>`
  );
}

/**
 * Apply a permissive CORS rule to an existing Spaces bucket. Best-effort:
 * resolves on success and rejects on hard HTTP failures, but the caller in
 * {@link createSpacesBucket} swallows the rejection because a failed CORS
 * apply should not abort bucket provisioning (the bucket is still usable
 * for the server-side `presignSpacesPutUrl` path; only browser uploads will
 * be blocked).
 *
 * @param {{ bucket: string, region?: string, accessKey?: string, secretKey?: string }} opts
 */
export async function applySpacesBucketCors(opts = {}) {
  const accessKey =
    String(opts.accessKey || process.env.DO_SPACES_KEY || "").trim();
  const secretKey =
    String(opts.secretKey || process.env.DO_SPACES_SECRET || "").trim();
  if (!accessKey || !secretKey) {
    throw new Error(
      "applySpacesBucketCors: DO_SPACES_KEY and DO_SPACES_SECRET must be set"
    );
  }
  const region =
    String(opts.region || "").trim() ||
    String(process.env.DO_SPACES_REGION || "").trim() ||
    DEFAULT_REGION;
  const bucket = String(opts.bucket || "").trim().toLowerCase();
  if (!bucket) throw new Error("applySpacesBucketCors: bucket is required");

  const xml = defaultSpacesCorsXml();
  const { url, headers, body } = signPutBucketCors({
    bucket,
    region,
    accessKey,
    secretKey,
    xmlBody: xml,
  });
  const r = await fetch(url, { method: "PUT", headers, body });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(
      `Spaces putBucketCors failed (${r.status}): ${text.slice(0, 400) || "no response body"}`
    );
  }
  return { bucket, region, applied: true };
}

/**
 * Create a DigitalOcean Spaces bucket. Idempotent: existing bucket owned by the same key
 * returns `{ bucket, region, alreadyExists: true }` instead of throwing.
 *
 * @param {{ name?: string, region?: string }} opts
 * @returns {Promise<{ bucket: string, region: string, endpoint: string, alreadyExists: boolean }>}
 */
export async function createSpacesBucket(opts = {}) {
  const accessKey = String(process.env.DO_SPACES_KEY || "").trim();
  const secretKey = String(process.env.DO_SPACES_SECRET || "").trim();
  if (!accessKey || !secretKey) {
    throw new Error(
      "DO_SPACES_KEY and DO_SPACES_SECRET must be set in the backend .env to provision a Spaces bucket."
    );
  }
  const region =
    String(opts.region || "").trim() ||
    String(process.env.DO_SPACES_REGION || "").trim() ||
    DEFAULT_REGION;
  const bucket = String(opts.name || "").trim().toLowerCase();
  if (!bucket) {
    throw new Error("createSpacesBucket: name is required");
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error(
      `createSpacesBucket: invalid bucket name "${bucket}" (must be 3–63 lowercase alphanumeric + dashes, not starting/ending with a dash)`
    );
  }

  const { url, headers } = signCreateBucket({
    bucket,
    region,
    accessKey,
    secretKey,
  });

  const r = await fetch(url, {
    method: "PUT",
    headers,
    body: "",
  });
  const text = await r.text();
  /**
   * S3 error semantics:
   *   200/204 — created.
   *   409 BucketAlreadyOwnedByYou — bucket already exists for this key; treat as success.
   *   409 BucketAlreadyExists — someone else owns this name; surface as a hard error so the caller can retry with a different name.
   */
  let alreadyExists = false;
  if (r.ok) {
    alreadyExists = false;
  } else if (r.status === 409 && /BucketAlreadyOwnedByYou/i.test(text)) {
    alreadyExists = true;
  } else {
    throw new Error(
      `Spaces createBucket failed (${r.status}): ${text.slice(0, 400) || "no response body"}`
    );
  }

  /**
   * Apply a permissive CORS rule on every provision (idempotent — repeating the
   * same XML is a no-op). Without this, the browser's preflight for `PUT` with
   * `Content-Type: application/pdf` (or any non-safelist type) is rejected by
   * Spaces, and the generated Tier B InfoBot apps stall on "Uploading…"
   * indefinitely. CORS is bucket-level config, not per-object, so we only
   * have to set it once.
   *
   * Treated as best-effort: if it fails we still return success because the
   * bucket itself is created and the failure mode (browser uploads blocked)
   * is recoverable by re-applying CORS later via `applySpacesBucketCors`.
   */
  try {
    await applySpacesBucketCors({ bucket, region, accessKey, secretKey });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[spacesAdmin] CORS apply failed for bucket "${bucket}" (${region}): ${msg}. ` +
        `Browser PUT uploads from generated apps may be blocked by CORS preflight ` +
        `until CORS is configured manually (DigitalOcean Control Panel → Spaces → Settings → CORS).`
    );
  }

  return {
    bucket,
    region,
    endpoint: `https://${bucket}.${region}.digitaloceanspaces.com`,
    alreadyExists,
  };
}

/**
 * @param {object} parsed codegen output
 * @returns {boolean}
 */
export function parsedRequestsSpaces(parsed) {
  const raw = parsed && parsed.do_services;
  if (!Array.isArray(raw)) return false;
  return raw.some((x) => {
    if (typeof x !== "string") return false;
    return x.trim().toLowerCase().includes("space");
  });
}

export function tideaiAutoSpacesDisabled() {
  const v = String(process.env.TIDEAI_DISABLE_AUTO_SPACES || "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
