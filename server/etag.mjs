// Entity tags for answers a browser revalidates (cache-control: no-cache).
import { createHash } from "node:crypto";

/** A quoted tag from `text`: sha1 hex, its first 16 characters. */
export const etagOf = (text) => `"${createHash("sha1").update(text).digest("hex").slice(0, 16)}"`;

/** Whether an If-None-Match value names `etag` (weak or strong, or `*`). */
export function noneMatchHits(header, etag) {
  if (typeof header !== "string" || !etag) return false;
  return header.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}
