// The common envelope (json-spec §2) isn't its own schema FILE in the
// documented tree (schemas/ only lists common/tiered-value + one file per
// type) — it's shared shape validated in code, while each type schema file
// validates just `body` (unclassified is the one exception: its schema file
// validates the whole sidecar meta document, §1.4).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate, validateNode } from "./validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, "..", "schemas");

const SCHEMA_FILES = {
  "common/tiered-value.v1": "common/tiered-value.v1.schema.json",
  "db-schema/v1": "db-schema/v1.schema.json",
  "msg-format/v1": "msg-format/v1.schema.json",
  "domain-skill/v1": "domain-skill/v1.schema.json",
  "fab-line/v1": "fab-line/v1.schema.json",
  "screen-map/v1": "screen-map/v1.schema.json",
  "unclassified/v1": "unclassified/v1.schema.json",
};

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
    // for phrase-style keywords.
    kw: { type: "string", pattern: "^[a-z0-9_. -]+$" },
    inject: { type: "string", enum: ["full", "pointer"] },
  },
};

// json-spec §2 — the 5 keys fixed for every type EXCEPT unclassified
// (§1.4: envelope with body dropped, validated by its own schema file).
const ENVELOPE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "id", "keywords", "status", "body"],
  properties: {
    schema: { type: "string", pattern: "^[a-z-]+/v[0-9]+$" },
    id: { type: "string", pattern: "^[a-z0-9._-]+$" },
    keywords: { type: "array", minItems: 1, items: KEYWORD_SCHEMA },
    // "inactive": exists and is readable through the API, but is kept out of
    // every derivative — no rendered md, no index entry, so it never reaches a
    // mirror or an injection slot. Bulk imports land here (issue #7).
    status: { type: "string", enum: ["active", "inactive", "archived"] },
    body: { type: "object" },
  },
};

function fail(errors, msg) {
  errors.push(msg);
}

// The id is derived from the body, never authored beside it — one place to get
// it wrong instead of two. SEMANTIC_CHECKS below turns each rule into a
// validation, and src/client/push.mjs uses the same rules to build an envelope
// around a bare body, so a pushed doc and a validated doc agree by
// construction. Null when the body lacks the field the id comes from: the
// schema layer reports the missing field, and a second complaint about the id
// would only bury it.
export function deriveId(schema, body) {
  if (!body || typeof body !== "object") return null;
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

/** How deriveId got its answer, for error messages that name the source field. */
const ID_SOURCE = {
  "db-schema/v1": () => "lower(table)",
  "msg-format/v1": () => "kebab(command)",
  "domain-skill/v1": () => "== body.name",
  "fab-line/v1": () => "lower(code)",
  "screen-map/v1": () => "== body.id",
};

// Cross-field checks the JSON-Schema layer can't express (sibling-node
// comparisons) — one function per type, kept intentionally small.
/** Shared by every type: the id must be what deriveId() says it is. */
function checkDerivedId(doc, errors) {
  const wantId = deriveId(doc.schema, doc.body);
  if (wantId !== null && doc.id !== wantId) {
    const how = ID_SOURCE[doc.schema]?.(doc.body) ?? "derived from body";
    fail(errors, `$.id: expected "${wantId}" (${how}), got "${doc.id}"`);
  }
}

// The `##` sections a skill md may have — the consumer's heading schema
// (fdc-agent-be-spring SkillMarkdownTool). akg does not parse the document any
// further; it only refuses a section it does not know, because downstream that
// typo would not be an error but a silently missing section (## 데이타 → no
// data items). A trailing `?`/`:` is noise, as it is for the consumer.
const SKILL_SECTIONS = new Set(["한 줄 설명", "언제 호출되는가", "도메인 지식", "데이터"]);
const normalizeHeading = (title) => title.trim().replace(/[?？:：\s]+$/u, "").trim();

/** The `##` headings of a markdown text, skipping fenced code blocks. */
export function skillSections(markdown) {
  const out = [];
  let fence = null;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence === null && f) fence = f[1];
    else if (fence !== null && line.trim().startsWith(fence)) fence = null;
    else if (fence === null) {
      const h = /^##\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) out.push(h[1]);
    }
  }
  return out;
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
  // The body is the author's md verbatim (user decision 2026-09-21); what the
  // schema cannot see is only whether its `##` sections are ones the consumer
  // reads. Everything inside a section (items, fences, :vars) is the consumer's
  // to judge — it is the one that turns the text into a skill.
  "domain-skill/v1"(doc, errors) {
    checkDerivedId(doc, errors);
    if (typeof doc.body?.markdown !== "string") return;
    for (const title of skillSections(doc.body.markdown)) {
      if (!SKILL_SECTIONS.has(normalizeHeading(title)))
        fail(
          errors,
          `$.body.markdown: 모르는 절입니다 — "## ${title}" (허용: ${[...SKILL_SECTIONS].map((t) => `## ${t}`).join(" · ")})`,
        );
    }
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
 * Validate a full document (envelope + body, or unclassified's flat meta).
 * @param {object} doc
 * @param {object} refs from loadSchemas()
 * @param {{draft?: boolean}} [opts] draft = relaxed body (inactive drafts, see relaxSchema)
 * @returns {string[]} empty when valid
 */
export function validateDocument(doc, refs, { draft = false } = {}) {
  const errors = [];
  if (!doc || typeof doc !== "object" || typeof doc.schema !== "string") {
    return ['$: missing or invalid "schema" field'];
  }
  const typeSchema = refs[doc.schema];
  if (!typeSchema) return [`$.schema: unknown schema version "${doc.schema}"`];

  if (doc.schema === "unclassified/v1") {
    validateNode(typeSchema, doc, "$", refs, errors);
    return errors;
  }

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
    if (draft) {
      // A draft skips the completeness/coherence checks a finished doc must
      // pass, but the id must still name the document — the store filename and
      // every later edit key off it. A body with no name has no id to save
      // under, so it is rejected here (the dashboard blocks 저장 for the same
      // reason).
      const want = deriveId(doc.schema, doc.body);
      if (want === null)
        fail(
          errors,
          "$.id: 이름이 없어 문서 id 를 만들 수 없습니다 (테이블/커맨드/스킬명 필요)",
        );
      else if (doc.id !== want)
        fail(
          errors,
          `$.id: expected "${want}" (${ID_SOURCE[doc.schema]?.(doc.body) ?? "derived from body"}), got "${doc.id}"`,
        );
    } else {
      SEMANTIC_CHECKS[doc.schema]?.(doc, errors);
    }
  }
  return errors;
}

// Validation strictness follows the RESULTING status: an inactive document is a
// draft (relaxed — build it up over time), an active one must be complete. This
// single rule is shared by every write route, and the activate route relies on
// it as the completeness gate — flipping a doc to active re-runs the full schema.
export function validateForStore(doc, refs) {
  return validateDocument(doc, refs, { draft: doc.status === "inactive" });
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
