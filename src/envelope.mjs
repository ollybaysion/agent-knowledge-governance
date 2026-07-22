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
    default:
      return null;
  }
}

/** How deriveId got its answer, for error messages that name the source field. */
const ID_SOURCE = {
  "db-schema/v1": () => "lower(table)",
  "msg-format/v1": () => "kebab(command)",
  "domain-skill/v1": () => "== body.name",
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
  "domain-skill/v1"(doc, errors) {
    checkDerivedId(doc, errors);
    // The answer's content floor (the 반드시 포함 line) is composed from
    // steps[].produces, so a spec where no step declares one renders that
    // line empty and the free-form output has nothing holding it to the data
    // it fetched. JSON Schema `contains` would say this, but the validator
    // here doesn't implement it.
    if (
      Array.isArray(doc.body.steps) &&
      doc.body.steps.length > 0 &&
      !doc.body.steps.some((s) => s?.produces)
    ) {
      fail(
        errors,
        "$.body.steps: no step declares produces — 답의 완결성 바닥(반드시 포함)이 비게 됩니다",
      );
    }
    // steps[].binds coherence (issue #32). The schema sees one bind source at
    // a time; whether it points at anything is a sibling-node question. A
    // step that declares binds gets three checks — a step without binds is
    // left alone, so pre-binds specs and prose-only consumers stay valid.
    const inputNames = new Set(
      (Array.isArray(doc.body.inputs) ? doc.body.inputs : [])
        .map((inp) => inp?.name)
        .filter(Boolean),
    );
    (Array.isArray(doc.body.steps) ? doc.body.steps : []).forEach((step, i) => {
      const binds = step?.binds;
      if (binds === undefined || binds === null || typeof binds !== "object")
        return;
      for (const [name, src] of Object.entries(binds)) {
        if (src?.from === "arg" && !inputNames.has(src.arg)) {
          fail(
            errors,
            `$.body.steps[${i}].binds.${name}: no input named "${src.arg}"`,
          );
        }
        if (
          src?.from === "step" &&
          !(Number.isInteger(src.step) && src.step >= 0 && src.step < i)
        ) {
          fail(
            errors,
            `$.body.steps[${i}].binds.${name}: step ${src.step} is not an earlier step`,
          );
        }
      }
      // The SQL's :vars and the declared binds must match exactly — a
      // missing bind is an unexecutable step, an extra one is a claim about
      // SQL that does not use it. Quoted literals are stripped first so a
      // ':' inside a string (date masks etc.) is not read as a bind.
      const sqlVars = new Set(
        [
          ...String(step.sql ?? "")
            .replace(/'[^']*'/g, "''")
            .matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g),
        ].map((m) => m[1]),
      );
      for (const v of sqlVars) {
        if (!(v in binds)) {
          fail(
            errors,
            `$.body.steps[${i}].binds: sql uses :${v} but it is not declared`,
          );
        }
      }
      for (const name of Object.keys(binds)) {
        if (!sqlVars.has(name)) {
          fail(
            errors,
            `$.body.steps[${i}].binds.${name}: declared but sql has no :${name}`,
          );
        }
      }
    });
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
    if (k === "required" || k === "minItems") continue;
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
