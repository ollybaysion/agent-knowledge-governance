// Picture store — a manual's captures and every document's assets[]:
// GET /api/assets/:sha256 (user · agent), POST /api/assets (admin · agent,
// the CLI's asset-push). The bytes are content-addressed, so a stored
// asset never changes — which is what lets GET hand out an immutable cache.
import { createHash } from "node:crypto";
import { imageHead } from "../../src/image-head.mjs";
import {
  assetPaths,
  commitFiles,
  hasAsset,
  isSha256,
  readAssetBytes,
  readJson,
} from "../store.mjs";
import { priorityOf } from "./docs.mjs";

export const ASSET_LIMIT = 2 * 1024 * 1024;
const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function registerAssetsRoutes(app) {
  const { storeDir, queue } = app.akg;

  // The raw bytes are the body. Fastify answers 415 to any other
  // Content-Type before a handler runs.
  app.addContentTypeParser(MEDIA_TYPES, { parseAs: "buffer" }, (request, body, done) =>
    done(null, body),
  );

  app.get(
    "/api/assets/:sha256",
    { config: { roles: ["user", "agent"] } },
    async (request, reply) => {
      const { sha256 } = request.params;
      if (!isSha256(sha256))
        return reply.code(400).send({ error: "invalid_sha256" });
      const meta = readJson(storeDir, assetPaths(sha256).meta);
      const bytes = meta && readAssetBytes(storeDir, sha256);
      if (!bytes) return reply.code(404).send({ error: "not_found" });

      const etag = `"${sha256}"`;
      reply.header("cache-control", "public, max-age=31536000, immutable");
      reply.header("etag", etag);
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      reply.type(meta.mediaType);
      return reply.send(bytes);
    },
  );

  app.post(
    "/api/assets",
    { bodyLimit: ASSET_LIMIT, config: { roles: ["admin", "agent"] } },
    async (request, reply) => {
      const bytes = request.body;
      const claimed = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const head = Buffer.isBuffer(bytes) ? imageHead(bytes) : null;
      if (!head) return reply.code(400).send({ error: "unreadable_image" });
      if (head.mediaType !== claimed)
        return reply.code(400).send({
          error: "media_type_mismatch",
          claimed,
          detected: head.mediaType,
        });

      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const { mediaType, width, height } = head;
      const result = await queue.enqueue(
        async () => {
          // Same bytes, same name: the store already holds exactly this.
          if (hasAsset(storeDir, sha256)) {
            const meta = readJson(storeDir, assetPaths(sha256).meta);
            return {
              status: 200,
              body: { sha256, mediaType: meta.mediaType, width: meta.width, height: meta.height, existed: true },
            };
          }
          const paths = assetPaths(sha256);
          const meta = {
            mediaType,
            bytes: bytes.length,
            width,
            height,
            uploadedBy: request.user.id,
            uploadedAt: new Date().toISOString(),
          };
          await commitFiles(storeDir, {
            author: request.user.id,
            message: `asset ${sha256.slice(0, 12)} (${mediaType} ${width}x${height})`,
            writes: [
              { relpath: paths.bytes, content: bytes },
              { relpath: paths.meta, content: JSON.stringify(meta, null, 2) + "\n" },
            ],
          });
          return {
            status: 201,
            body: { sha256, mediaType, width, height, existed: false },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}
