// Ties Phase 0's schemas/render (src/) to the git store (server/store.mjs):
// given a fully-resolved doc, write store/<type>/<id>.json + the derived
// rendered/ artifacts in one commit (json-spec §1.1 — truth and derivative
// always move together).
import { renderDbSchemaMd } from "../src/render/db-schema.mjs";
import { renderMsgFormatMd } from "../src/render/msg-format.mjs";
import { renderDomainSkillMd } from "../src/render/domain-skill.mjs";
import { commitFiles, listIds, readJson } from "./store.mjs";

// domain-skill renders to rendered/domain-skill/<name>/SKILL.md (json-spec
// §4.4) and is distributed via `akg sync --skills`, not the keyword-docs
// injection index — it deliberately has no index.json entry.
const RENDERERS = {
  "db-schema/v1": renderDbSchemaMd,
  "msg-format/v1": renderMsgFormatMd,
};
const INDEXED_TYPES = new Set(["db-schema", "msg-format"]);

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
    if (full.length) entries.push({ keywords: full, path });
    if (pointer.length)
      entries.push({ keywords: pointer, path, precision: 0.5 });
  }
  return entries;
}

function docMdPath(type, doc) {
  if (type === "domain-skill")
    return `rendered/domain-skill/${doc.body.name}/SKILL.md`;
  return `rendered/${type}/docs/${doc.id}.md`;
}

/**
 * The file writes one doc's persistence needs: store/<type>/<id>.json + its
 * rendered md + (if indexed) a freshly recompiled rendered/<type>/index.json.
 * Split from persistDoc so callers that need to combine a doc write with
 * OTHER writes in the same commit (proposals adopt/reject move a file too —
 * S8 atomicity) can merge write-lists before calling store.commitFiles once.
 */
export function docWrites(storeDir, type, doc) {
  const writes = [
    { relpath: `${type}/${doc.id}.json`, content: stableJson(doc) },
  ];

  const renderFn = RENDERERS[doc.schema];
  if (renderFn) {
    writes.push({ relpath: docMdPath(type, doc), content: renderFn(doc) });
  } else if (type === "domain-skill") {
    writes.push({
      relpath: docMdPath(type, doc),
      content: renderDomainSkillMd(doc),
    });
  }

  if (INDEXED_TYPES.has(type)) {
    const allDocs = listIds(storeDir, type)
      .map((id) =>
        id === doc.id ? doc : readJson(storeDir, `${type}/${id}.json`),
      )
      .filter(Boolean);
    if (!allDocs.some((d) => d.id === doc.id)) allDocs.push(doc);
    writes.push({
      relpath: `rendered/${type}/index.json`,
      content: stableJson(compileIndex(allDocs)),
    });
  }
  return writes;
}

/**
 * Persist one doc: store/<type>/<id>.json + its rendered md + (if indexed)
 * a freshly recompiled rendered/<type>/index.json — all in one commit.
 * Caller is responsible for schema validation and any If-Match / conflict
 * checks BEFORE calling this (this function just writes what it's given).
 */
export function persistDoc(storeDir, type, doc, { author, message }) {
  return commitFiles(storeDir, {
    author,
    message,
    writes: docWrites(storeDir, type, doc),
  });
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
