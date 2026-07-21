// The type → renderer dispatch (json-spec §1.1: `render(json) === md`).
// It lives in src/ rather than server/ because rendering is pure and both
// sides need it: the server to persist rendered/ artifacts, and `akg push
// --dry-run` to show the caller what a document will look like before any
// write happens.
import { renderDbSchemaMd } from "./db-schema.mjs";
import { renderMsgFormatMd } from "./msg-format.mjs";
import { renderDomainSkillMd } from "./domain-skill.mjs";

// domain-skill renders to rendered/domain-skill/<name>/SKILL.md (json-spec
// §4.4) and is distributed via `akg sync --skills`, not the keyword-docs
// injection index — it deliberately has no index.json entry, which is why it
// is dispatched by type rather than sitting in this map.
const RENDERERS = {
  "db-schema/v1": renderDbSchemaMd,
  "msg-format/v1": renderMsgFormatMd,
};

function rendererFor(type, doc) {
  return (
    RENDERERS[doc.schema] ??
    (type === "domain-skill" ? renderDomainSkillMd : null)
  );
}

/**
 * The md for a doc, computed rather than read. Null for types with no
 * renderer (unclassified, whose truth is already md).
 */
export function renderDocMd(type, doc) {
  return rendererFor(type, doc)?.(doc) ?? null;
}

/** Where a rendered doc lands under rendered/ — the skill tree, or docs/<id>.md. */
export function docMdPath(type, doc) {
  if (type === "domain-skill")
    return `rendered/domain-skill/${doc.body.name}/SKILL.md`;
  return `rendered/${type}/docs/${doc.id}.md`;
}
