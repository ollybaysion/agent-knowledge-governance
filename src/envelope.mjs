// The common envelope (json-spec §2) isn't its own schema FILE in the
// documented tree (schemas/ only lists common/tiered-value + one file per
// type) — it's shared shape validated in code, while each type schema file
// validates just `body`. Every md type (voc, unclassified, each registered
// type) has the one body shape md/v1.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, validateNode } from "./validate.mjs";
import {
  isSkillSection,
  normalizeHeading,
  SKILL_SECTIONS,
  skillSections,
} from "./skill-sections.mjs";
import { skillDataIds } from "./skill-data-ids.mjs";
import { checkVerifySet, VERIFY_SECTION } from "./verify-set.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, "..", "schemas");

const SCHEMA_FILES = {
  "common/tiered-value.v1": "common/tiered-value.v1.schema.json",
  "common/link.v1": "common/link.v1.schema.json",
  "db-schema/v1": "db-schema/v1.schema.json",
  "msg-format/v1": "msg-format/v1.schema.json",
  "domain-skill/v1": "domain-skill/v1.schema.json",
  "domain/v1": "domain/v1.schema.json",
  "fab-line/v1": "fab-line/v1.schema.json",
  "screen-map/v1": "screen-map/v1.schema.json",
  "manual/v1": "manual/v1.schema.json",
  "voc/v1": "voc/v1.schema.json",
  "unclassified/v1": "unclassified/v1.schema.json",
  "md/v1": "md/v1.schema.json",
};

// md types the repo ships; a registered type is md too, named by the caller.
const BUILTIN_MD_SCHEMAS = new Set(["voc/v1", "unclassified/v1", "md/v1"]);

// A domain-skill and a domain document share the body, the section rule and
// the data ids.
const SKILL_SCHEMAS = new Set(["domain-skill/v1", "domain/v1"]);

// Contracts that are not document types: what the store hands out and takes
// in besides documents. Kept out of loadSchemas so no document route accepts
// them as a type.
const CONTRACT_FILES = {
  "verification-set/v1": "verification-set/v1.schema.json",
  "score-record/v1": "score-record/v1.schema.json",
};

/** The contract schemas, { "<name>/v<N>": schema }. */
export function loadContractSchemas(dir = SCHEMAS_DIR) {
  const out = {};
  for (const [id, rel] of Object.entries(CONTRACT_FILES)) {
    out[id] = JSON.parse(readFileSync(join(dir, rel), "utf8"));
  }
  return out;
}

/** Load every schemas/*.schema.json into a { "<type>/v<N>": schema } map. */
export function loadSchemas(dir = SCHEMAS_DIR) {
  const refs = {};
  for (const [id, rel] of Object.entries(SCHEMA_FILES)) {
    refs[id] = JSON.parse(readFileSync(join(dir, rel), "utf8"));
  }
  return refs;
}

const KEYWORD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kw", "inject"],
  properties: {
    // ASCII lowercase/digits/underscore/dot (qualified identifiers like
    // "testuser.fdc_sensor") /hyphen (kebab-case skill names) plus spaces
    // for phrase-style keywords, plus Hangul syllables (the shipped fab-line
    // example's "라인"). Upper-case Latin stays refused.
    kw: { type: "string", pattern: "^[a-z0-9_. 가-힣-]+$" },
    inject: { type: "string", enum: ["full", "pointer"] },
  },
};

// json-spec §2 — the keys fixed for every type. `links`, `role` and `origin`
// are the optional keys.
const ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "id", "keywords", "status", "body"],
  properties: {
    schema: { type: "string", pattern: "^[a-z][a-z0-9-]*/v[0-9]+$" },
    id: { type: "string", pattern: "^[a-z0-9._-]+$" },
    keywords: { type: "array", minItems: 1, items: KEYWORD_SCHEMA },
    // "inactive": exists and is readable through the API, but is kept out of
    // every derivative — no rendered md, no index entry, so it never reaches a
    // mirror or an injection slot. Bulk imports land here (issue #7).
    status: { type: "string", enum: ["active", "inactive", "archived"] },
    body: { type: "object" },
    // Forward edges to other stored documents. Whether each target exists is
    // a store question, so the write routes check it (server/links.mjs).
    links: { type: "array", items: { $ref: "common/link.v1" } },
    // domain-skill only: a main skill is one an agent can be; a sub is
    // knowledge a main points at. Absent reads as main.
    role: { type: "string", enum: ["main", "sub"] },
    // Where the document came from, for a reader to open the original.
    origin: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", pattern: "^https?://[^\\s/?#]+([/?#]\\S*)?$" },
        title: { type: "string", pattern: "\\S" },
      },
    },
  },
};

function fail(errors, msg) {
  errors.push(msg);
}

// The id is derived from the body, never authored beside it — one place to get
// it wrong instead of two. SEMANTIC_CHECKS below turns each rule into a
// validation. Null when the body lacks the field the id comes from: the
// schema layer reports the missing field, and a second complaint about the id
// would only bury it.
export function deriveId(schema, body, { md = BUILTIN_MD_SCHEMAS.has(schema) } = {}) {
  if (!body || typeof body !== "object") return null;
  if (md) return body.name ?? null;
  switch (schema) {
    case "db-schema/v1": {
      // The id is the bare table name — `owner` is a plain attribute of the
      // body and never qualifies the id or the store filename (user decision
      // 2026-07-22; one DB, table names are unique enough).
      if (!body.table) return null;
      return body.table.toLowerCase();
    }
    case "msg-format/v1":
      return body.command
        ? body.command.toLowerCase().replace(/_/g, "-")
        : null;
    case "domain-skill/v1":
    case "domain/v1":
      return body.name ?? null;
    case "fab-line/v1":
      // Lowercased so the id keeps the store's one-case rule while the body
      // keeps the code as people write it (L1, not l1).
      return body.code ? body.code.toLowerCase() : null;
    case "screen-map/v1":
      // Already the value a classification carries downstream, so deriving it
      // is really a drift check: the id a lister sees and the id the consumer
      // pins a capture to must be the same string.
      return body.id ?? null;
    default:
      return null;
  }
}

// Types whose id is written into the envelope by the author rather than
// derived — the body has no identifier-shaped field to derive it from (a
// manual's title is prose). The envelope pattern is the only rule on the id.
const AUTHORED_ID = new Set(["manual/v1"]);

/** How deriveId got its answer, for error messages that name the source field. */
const ID_SOURCE = {
  "db-schema/v1": () => "lower(table)",
  "msg-format/v1": () => "kebab(command)",
  "domain-skill/v1": () => "== body.name",
  "domain/v1": () => "== body.name",
  "fab-line/v1": () => "lower(code)",
  "screen-map/v1": () => "== body.id",
};

const idSource = (schema, md) => (md ? "== body.name" : ID_SOURCE[schema]?.() ?? "derived from body");

// Cross-field checks the JSON-Schema layer can't express (sibling-node
// comparisons) — one function per type, kept intentionally small.
/** Shared by every type: the id must be what deriveId() says it is. */
function checkDerivedId(doc, errors, md = false) {
  const wantId = deriveId(doc.schema, doc.body, { md });
  if (wantId !== null && doc.id !== wantId) {
    fail(errors, `$.id: expected "${wantId}" (${idSource(doc.schema, md)}), got "${doc.id}"`);
  }
}

/** role belongs to domain-skill alone. */
function checkRole(doc, errors) {
  if (doc.role !== undefined && doc.schema !== "domain-skill/v1")
    fail(errors, `$.role: role 은 domain-skill 에만 있습니다 (${doc.schema})`);
}

/** A document may not point at itself, nor carry the same edge twice. */
function checkLinks(doc, errors) {
  if (!Array.isArray(doc.links)) return;
  const type = doc.schema.split("/")[0];
  const seen = new Set();
  doc.links.forEach((link, i) => {
    if (link.type === type && link.id === doc.id)
      fail(errors, `$.links[${i}]: 자기 자신을 가리킬 수 없습니다`);
    const key = `${link.type}/${link.id}#${link.rel}`;
    if (seen.has(key))
      fail(errors, `$.links[${i}]: 같은 연결이 두 번 있습니다 — ${key}`);
    seen.add(key);
  });
}

const DATA_ID = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A skill's data item ids: ascii identifiers, each once in the document. */
function checkSkillDataIds(doc, errors) {
  const markdown = doc.body?.markdown;
  if (typeof markdown !== "string") return;
  const lines = markdown.split(/\r?\n/);
  const seen = new Set();
  const repeated = new Set();
  for (const { id, line } of skillDataIds(markdown)) {
    if (!DATA_ID.test(id))
      fail(
        errors,
        `$.body.markdown: 데이터 항목 id 는 ascii 식별자([A-Za-z][A-Za-z0-9_]*)여야 합니다 — "${lines[line - 1].trim()}"`,
      );
    else if (seen.has(id)) repeated.add(id);
    else seen.add(id);
  }
  for (const id of repeated)
    fail(errors, `$.body.markdown: 데이터 항목 id 가 겹칩니다 — ${id}`);
}

/**
 * The data ids a skill shares with other stored skills where a query is on
 * either side — the consumer looks a query up by id across every skill, keeps
 * the first and silently drops the rest, so a write must not create one. A
 * question (an item without ```sql) is the skill's own: every skill that asks
 * `duration` or `param_index` carries its own item, and two of those never
 * conflict. Kept apart from validateDocument's errors: a conflict is a 409
 * (the store has the other side), not a 400 about this document alone.
 * @param {object} doc
 * @param {(selfId: string, selfType: string) => Map<string, {doc: string, query: boolean}>} [dataIdOwners]
 *   data id → the stored skill that has it and whether its item is a query,
 *   `selfType/selfId` and archived ones left out
 * @returns {{id: string, doc: string}[]}
 */
export function dataIdConflicts(doc, dataIdOwners) {
  if (!SKILL_SCHEMAS.has(doc?.schema) || !dataIdOwners) return [];
  const mine = new Map();
  for (const d of skillDataIds(doc.body?.markdown)) mine.set(d.id, mine.get(d.id) || d.query);
  if (mine.size === 0) return [];
  const owners = dataIdOwners(doc.id, doc.schema.split("/")[0]);
  return [...mine]
    .filter(([id, query]) => owners.has(id) && (query || owners.get(id).query))
    .map(([id]) => ({ id, doc: owners.get(id).doc }));
}

// The body is the author's md verbatim (user decision 2026-09-21); what the
// schema cannot see is only whether its `##` sections are ones the consumer
// reads — downstream an unknown one is not an error but a silently missing
// section (## 데이타 → no data items). Everything inside a section (items,
// fences, :vars) is the consumer's to judge — it is the one that turns the
// text into a skill. `knowledge` names a document that is knowledge a main
// reads (a sub or a domain document): 도메인 지식 is the one section it must
// have, and the verification set, which scores an agent, is not its own.
function checkSkillMarkdown(doc, errors, knowledge) {
  checkDerivedId(doc, errors);
  checkSkillDataIds(doc, errors);
  if (typeof doc.body?.markdown !== "string") return;
  const titles = skillSections(doc.body.markdown);
  if (knowledge && !titles.some((t) => normalizeHeading(t) === "도메인 지식"))
    fail(errors, `$.body.markdown: ${knowledge}에는 "## 도메인 지식" 절이 있어야 합니다`);
  if (knowledge && titles.some((t) => normalizeHeading(t) === VERIFY_SECTION))
    fail(errors, `$.body.markdown: "## ${VERIFY_SECTION}" 은 main 스킬에만 둡니다`);
  for (const e of checkVerifySet(doc.body.markdown).errors) fail(errors, `$.body.markdown: ${e}`);
  for (const title of titles) {
    if (!isSkillSection(title))
      fail(
        errors,
        `$.body.markdown: 모르는 절입니다 — "## ${title}" (허용: ${SKILL_SECTIONS.map((t) => `## ${t.key}`).join(" · ")})`,
      );
  }
}

const SEMANTIC_CHECKS = {
  "db-schema/v1"(doc, errors) {
    const { catalog, columnDescs } = doc.body;
    checkDerivedId(doc, errors);
    if (catalog?.columns && columnDescs) {
      const known = new Set(catalog.columns.map((c) => c.name));
      for (const name of Object.keys(columnDescs)) {
        // A column that vanished from catalog auto-transitions its slot to
        // deprecated (design D4/§3.1 "고아 슬롯") instead of being deleted —
        // that orphaned entry legitimately has no catalog.columns match.
        if (!known.has(name) && columnDescs[name]?.tier !== "deprecated")
          fail(
            errors,
            `$.body.columnDescs.${name}: no such column in catalog.columns`,
          );
      }
    }
  },
  "msg-format/v1"(doc, errors) {
    checkDerivedId(doc, errors);
  },
  "fab-line/v1"(doc, errors) {
    checkDerivedId(doc, errors);
  },
  "screen-map/v1"(doc, errors) {
    checkDerivedId(doc, errors);
    // A column named in both lists is a contradiction the schema cannot see:
    // the extraction step reads `required` as "reject the table without it" and
    // `optional` as "carry it if present", and it cannot do both.
    const expected = doc.body?.expectedColumns;
    if (Array.isArray(expected?.required) && Array.isArray(expected?.optional)) {
      const required = new Set(expected.required);
      for (const name of expected.optional) {
        if (required.has(name))
          fail(
            errors,
            `$.body.expectedColumns.optional: "${name}" is already in required`,
          );
      }
    }
  },
  // The screen a manual operates is its one rel:"screen" link, and a capture
  // the asset store lacks would reach the consumer as a broken image — so both
  // are activation conditions. Whether an asset exists is a store question:
  // the server passes `assetExists`, an offline caller (push --dry-run) does
  // not and skips that half.
  "manual/v1"(doc, errors, { assetExists } = {}) {
    const screens = (doc.links ?? []).filter((l) => l.rel === "screen");
    if (screens.length !== 1)
      fail(
        errors,
        `$.links: 매뉴얼은 rel "screen" 연결이 꼭 하나 있어야 합니다 (지금 ${screens.length}개)`,
      );
    else if (screens[0].type !== "screen-map")
      fail(errors, `$.links: rel "screen" 은 screen-map 문서를 가리켜야 합니다 (지금 ${screens[0].type})`);
    if (!assetExists) return;
    doc.body.steps.forEach((step, i) => {
      if (!assetExists(step.asset))
        fail(errors, `$.body.steps[${i}].asset: 캡처가 저장소에 없습니다 — ${step.asset}`);
    });
  },
  "domain-skill/v1"(doc, errors) {
    checkSkillMarkdown(doc, errors, doc.role === "sub" ? "sub 스킬" : null);
  },
  // What a sub domain-skill was: the sub rule, with no role key.
  "domain/v1"(doc, errors) {
    checkSkillMarkdown(doc, errors, "도메인 문서");
  },
};

// A draft — an inactive document being built up in the dashboard — is validated
// against a RELAXED copy of its type schema: `required` and `minItems` are
// dropped so a partial body validates, while every field that IS present still
// has to be well-typed and no unknown key is allowed. $ref'd schemas
// (tiered-value) are left strict — a scaffold slot already satisfies them and an
// absent slot is fine once `required` is gone. This is safe because injection
// never sees an inactive doc (render-store drops its md + index entry, #7), so
// an incomplete draft on disk can never reach a prompt; the full schema is
// enforced again the moment someone tries to activate it.
function relaxSchema(schema) {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(relaxSchema);
  if (schema.$ref) return { ...schema }; // leave referenced schemas strict
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    // Relax the constraints that make a field "complete": presence (required,
    // dependentRequired), count (minItems), and non-emptiness/shape of a value
    // that IS there (pattern, minLength). A half-typed column (a name but no
    // type yet) must save. `type`/`enum`/`additionalProperties` stay — a draft
    // still can't put a number where a string goes or invent unknown keys. The
    // full pattern is re-checked at activation.
    if (["required", "minItems", "pattern", "minLength", "dependentRequired"].includes(k))
      continue;
    if (k === "properties") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = relaxSchema(pv);
    } else if (["items", "additionalProperties", "if", "then", "else"].includes(k)) {
      out[k] = v && typeof v === "object" ? relaxSchema(v) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}
const RELAXED = new WeakMap();
function relaxedOf(schema) {
  let r = RELAXED.get(schema);
  if (!r) {
    r = relaxSchema(schema);
    RELAXED.set(schema, r);
  }
  return r;
}

/**
 * Validate a full document (envelope + body).
 * @param {object} doc
 * @param {object} refs from loadSchemas()
 * @param {{draft?: boolean, assetExists?: (sha256: string) => boolean, mdTypes?: string[]}} [opts]
 *   draft = relaxed body (inactive drafts, see relaxSchema); assetExists = the
 *   store lookup the manual check needs (omitted offline); mdTypes = the md
 *   type ids, whose `<id>/v1` is checked against md/v1
 * @returns {string[]} empty when valid
 */
export function validateDocument(doc, refs, { draft = false, assetExists, mdTypes = [] } = {}) {
  const errors = [];
  if (!doc || typeof doc !== "object" || typeof doc.schema !== "string") {
    return ['$: missing or invalid "schema" field'];
  }
  const [type, version] = doc.schema.split("/");
  const registered = version === "v1" && mdTypes.includes(type);
  const typeSchema = refs[doc.schema] ?? (registered ? refs["md/v1"] : undefined);
  if (!typeSchema) return [`$.schema: unknown schema version "${doc.schema}"`];
  const md = registered || BUILTIN_MD_SCHEMAS.has(doc.schema);

  validateNode(ENVELOPE_SCHEMA, doc, "$", refs, errors);
  if (doc.body && typeof doc.body === "object") {
    validateNode(
      draft ? relaxedOf(typeSchema) : typeSchema,
      doc.body,
      "$.body",
      refs,
      errors,
    );
  }
  if (errors.length === 0) {
    checkLinks(doc, errors);
    checkRole(doc, errors);
    if (draft) {
      // A draft skips the completeness/coherence checks a finished doc must
      // pass, but the id must still name the document — the store filename and
      // every later edit key off it. A body with no name has no id to save
      // under, so it is rejected here (the dashboard blocks 저장 for the same
      // reason). An authored id has nothing to be compared against.
      const want = deriveId(doc.schema, doc.body, { md });
      // A data id is a key the moment the skill exists, draft or not.
      if (SKILL_SCHEMAS.has(doc.schema)) checkSkillDataIds(doc, errors);
      if (AUTHORED_ID.has(doc.schema)) return errors;
      if (want === null)
        fail(
          errors,
          "$.id: 이름이 없어 문서 id 를 만들 수 없습니다 (테이블/커맨드/스킬명 필요)",
        );
      else if (doc.id !== want)
        fail(errors, `$.id: expected "${want}" (${idSource(doc.schema, md)}), got "${doc.id}"`);
    } else if (md) {
      // An md document is free text: no section rule, only the id.
      checkDerivedId(doc, errors, true);
    } else {
      SEMANTIC_CHECKS[doc.schema]?.(doc, errors, { assetExists });
    }
  }
  return errors;
}

// Validation strictness follows the RESULTING status: an inactive document is a
// draft (relaxed — build it up over time), an active one must be complete. This
// single rule is shared by every write route, and the activate route relies on
// it as the completeness gate — flipping a doc to active re-runs the full schema.
export function validateForStore(doc, refs, { assetExists, mdTypes } = {}) {
  return validateDocument(doc, refs, {
    draft: doc.status === "inactive",
    assetExists,
    mdTypes,
  });
}

export function assertValidDocument(doc, refs, label = doc?.id ?? "document") {
  const errors = validateDocument(doc, refs);
  if (errors.length) {
    throw new Error(
      `${label} 검증 실패:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
  return doc;
}

// re-exported for callers that only need the raw body-vs-schema check
export { validate };
