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

// The table a step's SQL selects from, when there is exactly one to name
// (issue #44). A join, a set operator or a subquery has no sole FROM, so this
// returns null and the caller steps aside instead of guessing — the same
// discipline as leaving a binds-less step alone. Quoted literals are stripped
// first for the same reason binds does it: a keyword inside a string is not
// syntax.
function soleFromTable(sql) {
  const text = String(sql ?? "").replace(/'[^']*'/g, "''");
  if (/\bjoin\b/i.test(text)) return null;
  const froms = [...text.matchAll(/\bfrom\b/gi)];
  if (froms.length !== 1) return null;
  const clause = text
    .slice(froms[0].index + 4)
    .split(
      /\b(?:where|group|order|having|fetch|offset|start|connect|union|minus|intersect|pivot)\b/i,
    )[0];
  // A comma is an implicit join and a paren is an inline view — neither has a
  // single source table either.
  if (clause.includes(",") || clause.includes("(")) return null;
  return clause.trim().split(/\s+/)[0] || null; // the alias, if any, drops off
}

// Case and owner prefix are noise for this comparison: the db-schema document
// this points at is keyed by lower(table) with `owner` a plain body attribute
// (deriveId above), so `TESTUSER.FDC_SENSOR` and `fdc_sensor` name one doc.
const normalizeTable = (name) =>
  String(name).replace(/"/g, "").split(".").pop().trim().toLowerCase();

// The column names a SELECT hands back, lowercased — what `filledBy.column`
// and a `from:"query"` bind are allowed to name (issue #46). Null means "do not
// judge": a `*`, or a select-list item with no trailing identifier to read as a
// column name (an unaliased `COUNT(*)`), leaves nothing to compare against, and
// guessing would reject valid specs. Same discipline as soleFromTable.
function selectColumns(sql) {
  const text = String(sql ?? "").replace(/'[^']*'/g, "''");
  const select = /\bselect\b/i.exec(text);
  if (!select) return null;
  const start = select.index + select[0].length;
  // The FROM that closes this select list is the first one at paren depth 0 —
  // a subquery's FROM sits deeper and must not end the scan.
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /^from\b/i.test(text.slice(i)) && !/[A-Za-z0-9_$#]/.test(text[i - 1] ?? " ")) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const items = [];
  let item = "";
  depth = 0;
  for (const ch of text.slice(start, end)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(item);
      item = "";
    } else item += ch;
  }
  items.push(item);
  const columns = new Set();
  for (const raw of items) {
    const one = raw.replace(/"/g, "").trim();
    if (!one || one === "*" || one.endsWith(".*")) return null;
    const named = /(?:\bas\s+)?([A-Za-z_][A-Za-z0-9_$#]*)\s*$/i.exec(one);
    if (!named) return null;
    columns.add(named[1].toLowerCase());
  }
  return columns.size ? columns : null;
}

// The identifiers a `when` expression names, minus the operator words — the
// candidates for "which need does this condition read". Values are conventionally
// uppercase (`= PHYSICAL`) and need ids are lowercase by schema pattern, so the
// lowercase-only match already keeps literals out of the way.
const WHEN_OPERATORS = new Set(["and", "or", "not", "is", "in", "null", "like", "between"]);
const whenRefs = (when) =>
  [...String(when ?? "").matchAll(/\b[a-z][a-z0-9_]*\b/g)]
    .map((m) => m[0])
    .filter((word) => !WHEN_OPERATORS.has(word));

/**
 * The first cycle in a directed graph, as the node path that closes it.
 * `edges` is a Map of node -> iterable of nodes. Null when acyclic.
 */
function findCycle(edges) {
  const state = new Map(); // 1 = on the current path, 2 = done
  const path = [];
  let found = null;
  const walk = (node) => {
    if (found) return;
    if (state.get(node) === 1) {
      found = [...path.slice(path.indexOf(node)), node];
      return;
    }
    if (state.get(node) === 2) return;
    state.set(node, 1);
    path.push(node);
    for (const next of edges.get(node) ?? []) walk(next);
    path.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) walk(node);
  return found;
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
  // spec v3 (issue #46): needs are first class and queries are the means of
  // filling them, so what the schema cannot see is now mostly ONE question —
  // does this pointer point at anything. Every check below is that question
  // asked of a different arrow: filledBy → query.column, when → need,
  // binds → input / query.column. The reference graphs must also stay acyclic,
  // because both of them are read as "resolve that first".
  "domain-skill/v1"(doc, errors) {
    checkDerivedId(doc, errors);
    const needs = Array.isArray(doc.body.needs) ? doc.body.needs : [];
    const queries = Array.isArray(doc.body.queries) ? doc.body.queries : [];
    const inputNames = new Set(
      (Array.isArray(doc.body.inputs) ? doc.body.inputs : [])
        .map((inp) => inp?.name)
        .filter(Boolean),
    );

    // Ids address things now (the catalog dropped its order), so a duplicate is
    // not a style problem: it makes every reference to that id ambiguous.
    const queryById = new Map();
    queries.forEach((query, i) => {
      const id = query?.id;
      if (typeof id !== "string") return;
      if (queryById.has(id))
        fail(errors, `$.body.queries[${i}].id: 중복된 쿼리 id "${id}"`);
      else queryById.set(id, query);
    });
    const needIds = new Set();
    needs.forEach((need, i) => {
      const id = need?.id;
      if (typeof id !== "string") return;
      if (needIds.has(id))
        fail(errors, `$.body.needs[${i}].id: 중복된 needs id "${id}"`);
      else needIds.add(id);
    });

    const columnsCache = new Map();
    const columnsOf = (query) => {
      if (!columnsCache.has(query))
        columnsCache.set(query, selectColumns(query?.sql));
      return columnsCache.get(query);
    };
    // A column that the query does not select can never be filled, and the
    // deterministic 채워짐 판정 would read that as "the data is missing" rather
    // than "the spec is wrong" — the failure the column pin exists to prevent.
    const checkColumn = (path, queryId, column) => {
      const target = queryById.get(queryId);
      if (!target) {
        fail(errors, `${path}: id "${queryId}" 인 쿼리가 없습니다`);
        return;
      }
      const columns = columnsOf(target);
      if (columns && !columns.has(String(column).toLowerCase()))
        fail(
          errors,
          `${path}: 쿼리 "${queryId}" 의 SELECT 목록에 "${column}" 이 없습니다`,
        );
    };

    needs.forEach((need, i) => {
      (Array.isArray(need?.filledBy) ? need.filledBy : []).forEach((src, j) => {
        checkColumn(
          `$.body.needs[${i}].filledBy[${j}]`,
          src?.query,
          src?.column,
        );
      });
    });

    // `when` reads another need's value, so it has to name one. Every lowercase
    // identifier in the expression is a candidate; if none of them is a need,
    // the condition can never be evaluated and the need would hang inactive
    // forever (or, worse, be treated as active).
    const whenEdges = new Map();
    needs.forEach((need, i) => {
      if (typeof need?.id === "string" && !whenEdges.has(need.id))
        whenEdges.set(need.id, []);
      if (typeof need?.when !== "string") return;
      const refs = whenRefs(need.when).filter((word) => needIds.has(word));
      if (refs.length === 0) {
        fail(
          errors,
          `$.body.needs[${i}].when: "${need.when}" 이 참조하는 needs 가 없습니다`,
        );
        return;
      }
      if (typeof need.id === "string") whenEdges.get(need.id).push(...refs);
    });
    const whenCycle = findCycle(whenEdges);
    if (whenCycle)
      fail(errors, `$.body.needs: when 조건이 순환합니다 — ${whenCycle.join(" → ")}`);

    const bindEdges = new Map();
    queries.forEach((query, i) => {
      if (typeof query?.id === "string" && !bindEdges.has(query.id))
        bindEdges.set(query.id, []);
      // queries[].table coherence (issue #44). The declared table is what the
      // prompt synthesizer heads the data block with and what the db-schema
      // excerpt is looked up by, so a table that disagrees with the FROM beside
      // it aims both at the wrong document — silently, since the SQL still
      // runs. The SQL is where that truth is already written, so it is the
      // reference; only a single-table SELECT can be judged.
      const table = query?.table;
      if (typeof table === "string" && table.trim()) {
        const from = soleFromTable(query?.sql);
        if (from && normalizeTable(from) !== normalizeTable(table)) {
          fail(
            errors,
            `$.body.queries[${i}].table: "${table}" but the sql selects from "${from}"`,
          );
        }
      }
      const binds = query?.binds;
      if (binds === undefined || binds === null || typeof binds !== "object")
        return;
      for (const [name, src] of Object.entries(binds)) {
        if (src?.from === "arg" && !inputNames.has(src.arg)) {
          fail(
            errors,
            `$.body.queries[${i}].binds.${name}: no input named "${src.arg}"`,
          );
        }
        if (src?.from === "query") {
          checkColumn(
            `$.body.queries[${i}].binds.${name}`,
            src.query,
            src.column,
          );
          if (typeof query.id === "string" && typeof src.query === "string")
            bindEdges.get(query.id).push(src.query);
        }
      }
      // The SQL's :vars and the declared binds must match exactly — a missing
      // bind is an unexecutable query, an extra one is a claim about SQL that
      // does not use it. Quoted literals are stripped first so a ':' inside a
      // string (date masks etc.) is not read as a bind.
      const sqlVars = new Set(
        [
          ...String(query.sql ?? "")
            .replace(/'[^']*'/g, "''")
            .matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g),
        ].map((m) => m[1]),
      );
      for (const v of sqlVars) {
        if (!(v in binds)) {
          fail(
            errors,
            `$.body.queries[${i}].binds: sql uses :${v} but it is not declared`,
          );
        }
      }
      for (const name of Object.keys(binds)) {
        if (!sqlVars.has(name)) {
          fail(
            errors,
            `$.body.queries[${i}].binds.${name}: declared but sql has no :${name}`,
          );
        }
      }
    });
    // Order stopped being the thing that made a step reachable, so nothing
    // structural rules out "a needs b, b needs a" any more — this check is what
    // took over that job from `step < i`.
    const bindCycle = findCycle(bindEdges);
    if (bindCycle)
      fail(errors, `$.body.queries: binds 가 순환합니다 — ${bindCycle.join(" → ")}`);
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
