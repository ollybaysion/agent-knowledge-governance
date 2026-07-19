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
    status: { type: "string", enum: ["active", "archived"] },
    body: { type: "object" },
  },
};

function fail(errors, msg) {
  errors.push(msg);
}

// Cross-field checks the JSON-Schema layer can't express (sibling-node
// comparisons) — one function per type, kept intentionally small.
const SEMANTIC_CHECKS = {
  "db-schema/v1"(doc, errors) {
    const { owner, table, catalog, columnDescs } = doc.body;
    if (owner && table) {
      const wantId = `${owner}.${table}`.toLowerCase();
      if (doc.id !== wantId)
        fail(
          errors,
          `$.id: expected "${wantId}" (lower(owner.table)), got "${doc.id}"`,
        );
    }
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
    const { command } = doc.body;
    if (command) {
      const wantId = command.toLowerCase().replace(/_/g, "-");
      if (doc.id !== wantId)
        fail(
          errors,
          `$.id: expected "${wantId}" (kebab(command)), got "${doc.id}"`,
        );
    }
  },
  "domain-skill/v1"(doc, errors) {
    if (doc.body.name && doc.id !== doc.body.name) {
      fail(
        errors,
        `$.id: expected "${doc.body.name}" (== body.name), got "${doc.id}"`,
      );
    }
  },
};

/**
 * Validate a full document (envelope + body, or unclassified's flat meta).
 * @param {object} doc
 * @param {object} refs from loadSchemas()
 * @returns {string[]} empty when valid
 */
export function validateDocument(doc, refs) {
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
    validateNode(typeSchema, doc.body, "$.body", refs, errors);
  }
  if (errors.length === 0) {
    SEMANTIC_CHECKS[doc.schema]?.(doc, errors);
  }
  return errors;
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
