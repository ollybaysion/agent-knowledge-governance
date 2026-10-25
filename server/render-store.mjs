// Ties Phase 0's schemas/render (src/) to the git store (server/store.mjs):
// given a fully-resolved doc, write store/<type>/<id>.json + the derived
// rendered/ artifacts in one commit (json-spec §1.1 — truth and derivative
// always move together).
import { docMdPath, renderDocMd, rendersToMd } from "../src/render/index.mjs";
import { commitFiles, listIds, readJson } from "./store.mjs";
import { isMdType } from "./types.mjs";

const INDEXED_TYPES = new Set(["db-schema", "msg-format", "manual"]);

const stableJson = (obj) => JSON.stringify(obj, null, 2) + "\n";

/** rendered/<type>/index.json entries (json-spec §5.1) — envelope-only, never opens body. */
export function compileIndex(docs) {
  const entries = [];
  for (const doc of docs) {
    if (doc.status !== "active") continue;
    const full = doc.keywords
      .filter((k) => k.inject === "full")
      .map((k) => k.kw);
    const pointer = doc.keywords
      .filter((k) => k.inject === "pointer")
      .map((k) => k.kw);
    const path = `docs/${doc.id}.md`;
    const links = doc.links?.length ? { links: doc.links } : {};
    if (full.length) entries.push({ keywords: full, path, ...links });
    if (pointer.length)
      entries.push({ keywords: pointer, path, precision: 0.5, ...links });
  }
  return entries;
}

// Re-exported for server callers: an inactive doc has no file in rendered/ by
// design (see docWrites), but the dashboard still has to show it — being
// readable while staying out of the injection path is the entire point of the
// state. Safe because rendering is pure (json-spec §1.1), so this returns what
// the file would hold.
export { renderDocMd };

/**
 * The file writes one doc's persistence needs: store/<type>/<id>.json + its
 * rendered md + (if indexed) a freshly recompiled rendered/<type>/index.json.
 * Split from persistDoc so callers that need to combine a doc write with
 * OTHER writes in the same commit (proposals adopt/reject move a file too —
 * S8 atomicity) can merge write-lists before calling store.commitFiles once.
 *
 * Only an active doc gets a rendered md. Anything else — inactive (issue #7)
 * or archived — has its md REMOVED rather than skipped, because /api/bundle
 * tars rendered/ wholesale (routes/misc.mjs): a stale file left behind there
 * ships to every mirror, which is exactly what the inactive state exists to
 * prevent. Dropping it from the index is not enough.
 *
 * @returns {{writes: {relpath:string, content:string}[], removes: string[]}}
 */
export function docWrites(storeDir, type, doc) {
  return docsWrites(storeDir, type, [doc]);
}

/**
 * docWrites for several docs of one type in one commit: the index is compiled
 * once, from the store with every one of `docs` in place of its stored copy.
 * `drop` = the id of a doc the same commit deletes: the index leaves it out.
 */
export function docsWrites(storeDir, type, docs, { drop = null } = {}) {
  const md = isMdType(storeDir, type);
  const writes = [];
  const removes = [];
  for (const doc of docs) {
    writes.push({ relpath: `${type}/${doc.id}.json`, content: stableJson(doc) });
    // Only an active doc gets a rendered md; inactive (a draft being built up,
    // or #7 bulk-loaded) or archived has its md REMOVED instead — a stale file
    // left in rendered/ would ship to every mirror via /api/bundle. A draft
    // body can be incomplete and unrenderable, so a non-active doc is NEVER
    // rendered: we only drop the file its id/name would map to. `rendersToMd`
    // answers "does this type render at all" without touching the body, which
    // renderDocMd would throw on.
    if (rendersToMd(type, doc, { md })) {
      if (doc.status === "active") {
        writes.push({ relpath: docMdPath(type, doc, { md }), content: renderDocMd(type, doc, { md }) });
      } else {
        removes.push(docMdPath(type, doc, { md }));
      }
    }
  }

  if (INDEXED_TYPES.has(type)) {
    const changed = new Map(docs.map((d) => [d.id, d]));
    const allDocs = listIds(storeDir, type)
      .filter((id) => id !== drop)
      .map((id) => changed.get(id) ?? readJson(storeDir, `${type}/${id}.json`))
      .filter(Boolean);
    for (const d of docs) if (!allDocs.includes(d)) allDocs.push(d);
    writes.push({
      relpath: `rendered/${type}/index.json`,
      content: stableJson(compileIndex(allDocs)),
    });
  }
  return { writes, removes };
}

/**
 * Persist one doc: store/<type>/<id>.json + its rendered md + (if indexed)
 * a freshly recompiled rendered/<type>/index.json — all in one commit.
 * Caller is responsible for schema validation and any If-Match / conflict
 * checks BEFORE calling this (this function just writes what it's given).
 */
export function persistDoc(storeDir, type, doc, { author, message }) {
  const { writes, removes } = docWrites(storeDir, type, doc);
  return commitFiles(storeDir, { author, message, writes, removes });
}

/** Archive (soft-delete): drop from the compiled index without touching the JSON's history. */
export function archiveDoc(storeDir, type, doc, { author, message }) {
  return persistDoc(
    storeDir,
    type,
    { ...doc, status: "archived" },
    { author, message },
  );
}
