// Unit tests for the schema layer itself — the "모르는 키 거부" guarantee
// (design §5.0/D3) and the tiered-value state rules (json-spec §3) are the
// structural backbone every render/migrate fixture relies on, so they get
// direct coverage independent of those fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas, validateDocument } from "../src/envelope.mjs";
import { validate } from "../src/validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "schemas"));

function minimalDbSchemaDoc() {
  return {
    schema: "db-schema/v1",
    id: "t.x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: "X",
      catalog: {
        columns: [{ name: "A", type: "VARCHAR2(1)", nullable: false }],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

test("additionalProperties:false rejects an unknown key at envelope level", () => {
  const doc = { ...minimalDbSchemaDoc(), extra: true };
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes('unknown key "extra"')));
});

test("additionalProperties:false rejects an unknown key inside body", () => {
  const doc = minimalDbSchemaDoc();
  doc.body.notARealField = 1;
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("notARealField")));
});

test("additionalProperties:false rejects an unknown key inside a tiered value", () => {
  const doc = minimalDbSchemaDoc();
  doc.body.purpose.confidence = 0.9;
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("tiered-value: scaffold requires text === null", () => {
  const tv = { text: "not null", tier: "scaffold" };
  const errors = validate(refs["common/tiered-value.v1"], tv, refs);
  assert.ok(errors.length > 0);
});

test("tiered-value: inferred with no evidence is rejected", () => {
  const tv = { text: "센서 ID", tier: "inferred", evidence: [] };
  const errors = validate(refs["common/tiered-value.v1"], tv, refs);
  assert.ok(errors.some((e) => e.includes("evidence")));
});

test("tiered-value: inferred with evidence passes", () => {
  const tv = { text: "센서 ID", tier: "inferred", evidence: ["a.ts:1"] };
  assert.deepEqual(validate(refs["common/tiered-value.v1"], tv, refs), []);
});

test("tiered-value: confirmed with no evidence is rejected", () => {
  const tv = { text: "센서 ID", tier: "confirmed" };
  const errors = validate(refs["common/tiered-value.v1"], tv, refs);
  assert.ok(errors.some((e) => e.includes("evidence")));
});

test("db-schema: columnDescs key not present in catalog.columns is rejected", () => {
  const doc = minimalDbSchemaDoc();
  doc.body.columnDescs.GHOST = { text: null, tier: "scaffold" };
  const errors = validateDocument(doc, refs);
  assert.ok(
    errors.some((e) => e.includes("GHOST") && e.includes("no such column")),
  );
});

test("db-schema: a DEPRECATED columnDescs entry not in catalog.columns is allowed (orphan slot, §3.1)", () => {
  const doc = minimalDbSchemaDoc();
  doc.body.columnDescs.GHOST = {
    text: "예전 컬럼",
    tier: "deprecated",
    evidence: ["x:1"],
  };
  assert.deepEqual(validateDocument(doc, refs), []);
});

test("db-schema: id must be lower(owner.table)", () => {
  const doc = minimalDbSchemaDoc();
  doc.id = "wrong.id";
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes('expected "t.x"')));
});

test("msg-format: id must be kebab(command)", () => {
  const doc = {
    schema: "msg-format/v1",
    id: "wrong-id",
    keywords: [{ kw: "cmd_x", inject: "full" }],
    status: "active",
    body: {
      command: "CMD_X",
      direction: "host->equipment",
      purpose: { text: null, tier: "scaffold" },
      fields: [
        {
          seq: 1,
          name: "A",
          type: "string",
          required: true,
          desc: { text: null, tier: "scaffold" },
        },
      ],
    },
  };
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes('expected "cmd-x"')));
});

test("msg-format: output.exampleLabel requires example and vice versa", () => {
  const schema = refs["msg-format/v1"];
  const base = {
    command: "CMD_X",
    direction: "host->equipment",
    purpose: { text: null, tier: "scaffold" },
    fields: [
      {
        seq: 1,
        name: "A",
        type: "string",
        required: true,
        desc: { text: null, tier: "scaffold" },
      },
    ],
  };
  assert.ok(validate(schema, base, refs).length === 0);
});

test("domain-skill: exampleLabel without example is rejected (dependentRequired)", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "x",
    argumentHint: "{id}",
    description: "설명.",
    steps: [{ title: "s1", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t", exampleLabel: "예시" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("dependentRequired")));
});

test("domain-skill: h1Title key is rejected (akg dropped it, json-spec §4.4)", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "x",
    argumentHint: "{id}",
    description: "설명.",
    h1Title: "안 됨",
    steps: [{ title: "s1", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("h1Title")));
});

test("domain-skill: description firstLine must end with '.'", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "x",
    argumentHint: "{id}",
    description: "마침표 없음\n다음 줄.",
    steps: [{ title: "s1", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("$.description")));
});

test("domain-skill: name must be kebab-case", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "Not_Kebab",
    argumentHint: "{id}",
    description: "설명.",
    steps: [{ title: "s1", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("$.name")));
});

test("domain-skill: steps and valueRules require at least one item", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "x",
    argumentHint: "{id}",
    description: "설명.",
    steps: [],
    valueRules: [],
    output: { lead: "l", template: "t" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("$.steps")));
  assert.ok(errors.some((e) => e.includes("$.valueRules")));
});

test("whitespace-only strings are rejected by the \\S pattern", () => {
  const schema = refs["domain-skill/v1"];
  const body = {
    name: "x",
    argumentHint: "  ",
    description: "설명.",
    steps: [{ title: "s1", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t" },
  };
  const errors = validate(schema, body, refs);
  assert.ok(errors.some((e) => e.includes("argumentHint")));
});

test("unclassified/v1: valid sidecar meta (no body key) passes", () => {
  const doc = {
    schema: "unclassified/v1",
    id: "deploy-guide",
    keywords: [{ kw: "deploy", inject: "pointer" }],
    status: "active",
  };
  assert.deepEqual(validateDocument(doc, refs), []);
});

test("unclassified/v1: a body key is rejected (only 4 envelope keys apply here)", () => {
  const doc = {
    schema: "unclassified/v1",
    id: "deploy-guide",
    keywords: [{ kw: "deploy", inject: "pointer" }],
    status: "active",
    body: { text: "should not exist here" },
  };
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("body")));
});
