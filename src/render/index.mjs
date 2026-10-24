// The type → renderer dispatch (json-spec §1.1: `render(json) === md`).
// It lives in src/ rather than server/ because rendering is pure; the server
// uses it to persist rendered/ artifacts.
import { renderDbSchemaMd } from "./db-schema.mjs";
import { renderMsgFormatMd } from "./msg-format.mjs";
import { renderDomainSkillMd } from "./domain-skill.mjs";
import { renderManualMd } from "./manual.mjs";
import { renderMdDoc } from "./md.mjs";

// domain-skill renders to rendered/domain-skill/<name>/SKILL.md (json-spec
// §4.4) and is distributed via `akg sync --skills`, not the keyword-docs
// injection index — it deliberately has no index.json entry, which is why it
// is dispatched by type rather than sitting in this map. An md type (voc,
// unclassified, a registered type) is named by the caller's `md` flag.
const RENDERERS = {
  "db-schema/v1": renderDbSchemaMd,
  "msg-format/v1": renderMsgFormatMd,
  "manual/v1": renderManualMd,
};

function rendererFor(type, doc, md) {
  if (md) return renderMdDoc;
  return (
    RENDERERS[doc.schema] ??
    (type === "domain-skill" ? renderDomainSkillMd : null)
  );
}

/**
 * The md for a doc, computed rather than read. Null for types with no
 * renderer (screen-map, fab-line).
 * @param {{md?: boolean}} [opts] md = the type is an md type
 */
export function renderDocMd(type, doc, { md = false } = {}) {
  return rendererFor(type, doc, md)?.(doc) ?? null;
}

/**
 * Whether this type renders to md at all. Answered WITHOUT touching the body,
 * so it is safe on an incomplete draft that renderDocMd itself would throw on.
 */
export function rendersToMd(type, doc, { md = false } = {}) {
  return rendererFor(type, doc, md) !== null;
}

/**
 * Where a rendered doc lands under rendered/ — the skill tree, voc's
 * <name>/VOC.md, an md type's <id>.md, or docs/<id>.md.
 */
export function docMdPath(type, doc, { md = false } = {}) {
  if (type === "domain-skill")
    return `rendered/domain-skill/${doc.body.name}/SKILL.md`;
  if (type === "voc") return `rendered/voc/${doc.body.name}/VOC.md`;
  if (md) return `rendered/${type}/${doc.id}.md`;
  return `rendered/${type}/docs/${doc.id}.md`;
}
