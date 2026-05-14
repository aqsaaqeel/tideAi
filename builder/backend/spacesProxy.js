import express from "express";
import { presignSpacesPutUrl } from "./spacesAdmin.js";

/**
 * Same-origin endpoint that returns a presigned PUT URL for DigitalOcean Spaces.
 *
 * Mount AFTER `express.json` (this endpoint parses a JSON body).
 *
 * The presigned URL itself is signed with `DO_SPACES_KEY`/`DO_SPACES_SECRET` from the
 * tideAI backend's environment — the generated app never sees those credentials. The
 * generated app uploads PDFs by POSTing `{ key, content_type }` here, then PUTting the
 * file bytes to the returned `url`.
 *
 * Request body:  { key: string, content_type?: string, expires?: number }
 * Response body: { url, headers, expires_at, bucket, region }
 */
export function createSpacesProxy() {
  const router = express.Router();

  router.post("/api/spaces/presign-put", (req, res) => {
    /**
     * The generated app sends its own `VITE_DO_SPACES_BUCKET` (baked at build time) so
     * the backend can sign for the right bucket without keeping a per-build lookup.
     * For a true production deployment we would tie this to an auth'd session, but for
     * the hackathon demo the bucket name itself is the (weak) capability.
     */
    const bucket = String(req.body?.bucket || "").trim();
    const region =
      String(req.body?.region || "").trim() ||
      String(process.env.DO_SPACES_REGION || "").trim() ||
      "tor1";
    const key = String(req.body?.key || "").trim();
    const content_type = String(req.body?.content_type || "").trim() || "application/octet-stream";
    const expires = Number(req.body?.expires);
    if (!bucket) return res.status(400).json({ error: "bucket is required" });
    if (!key) return res.status(400).json({ error: "key is required" });

    try {
      const accessKey = String(process.env.DO_SPACES_KEY || "").trim();
      const secretKey = String(process.env.DO_SPACES_SECRET || "").trim();
      if (!accessKey || !secretKey) {
        return res.status(503).json({
          error: "DO_SPACES_KEY and DO_SPACES_SECRET must be set on the backend.",
        });
      }
      const signed = presignSpacesPutUrl({
        bucket,
        region,
        accessKey,
        secretKey,
        key,
        contentType: content_type,
        expiresSeconds: Number.isFinite(expires) ? expires : 900,
      });
      res.json({
        ...signed,
        bucket,
        region,
      });
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  return router;
}
