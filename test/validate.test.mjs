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

const V2_BODY = () => ({
  name: "x",
  argumentHint: "{id}",
  scope: { 단위: "센서", 카디널리티: "단일", 의도: "상태" },
  focus: "현재 상태",
  intro: "도메인 주의사항.",
  inputs: [{ name: "id", required: true, description: "조회 키" }],
  dependencies: [{ mcp: "agent-db-plugin" }],
  steps: [{ title: "s1", produces: "현재 상태", sql: "SELECT 1" }],
  output: {
    avoid: [
      "없는 사유를 추측한다 — 사유 컬럼은 데이터에 없다",
      "측정값을 지어낸다 — 이 스킬 범위 밖이다",
      "코드를 구체화한다 — 라벨 이상은 모른다",
    ],
    examples: [
      { ask: "전체 설명", answer: "넓은 답이다." },
      { ask: "좁은 질문", answer: "좁은 답이다." },
    ],
  },
});

test("domain-skill: the v2 body shape is valid", () => {
  assert.deepEqual(validate(refs["domain-skill/v1"], V2_BODY(), refs), []);
});

// spec v2 removed these three; an old body must fail loudly rather than lose
// its rules to additionalProperties.
test("domain-skill: removed v1 keys are rejected (description, valueRules, h1Title)", () => {
  const schema = refs["domain-skill/v1"];
  for (const [key, value] of [
    ["description", "설명."],
    ["valueRules", [{ target: "A", rule: "B", basis: "scaffold" }]],
    ["h1Title", "안 됨"],
    ["output.template", "t"],
  ]) {
    const body = V2_BODY();
    if (key === "output.template") body.output.template = value;
    else body[key] = value;
    const errors = validate(schema, body, refs);
    assert.ok(
      errors.some((e) => e.includes(key.split(".").pop())),
      `${key} 는 거부돼야 함: ${JSON.stringify(errors)}`,
    );
  }
});

test("domain-skill: name must be kebab-case", () => {
  const body = { ...V2_BODY(), name: "Not_Kebab" };
  const errors = validate(refs["domain-skill/v1"], body, refs);
  assert.ok(errors.some((e) => e.includes("$.name")));
});

test("domain-skill: scope axes are closed enums", () => {
  const body = V2_BODY();
  body.scope.의도 = "이상 분석"; // v2 격자 밖 — 확장은 akg 발행
  const errors = validate(refs["domain-skill/v1"], body, refs);
  assert.ok(errors.some((e) => e.includes("$.scope.의도")));
});

test("domain-skill: steps require at least one item and one produces", () => {
  const empty = { ...V2_BODY(), steps: [] };
  assert.ok(
    validate(refs["domain-skill/v1"], empty, refs).some((e) =>
      e.includes("$.steps"),
    ),
  );

  // produces 가 하나도 없으면 답의 완결성 바닥(반드시 포함)이 비게 된다. JSON
  // Schema 의 contains 는 이 검증기가 구현하지 않아 시맨틱 체크(문서 층)가 본다.
  const noProduces = {
    schema: "domain-skill/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: V2_BODY(),
  };
  delete noProduces.body.steps[0].produces;
  assert.ok(
    validateDocument(noProduces, refs).some((e) =>
      e.includes("no step declares produces"),
    ),
  );
});

// The old gate was a count; a restatement of the universal discipline passed
// it with zero domain content.
test("domain-skill: avoid enforces the shape contract, not just the count", () => {
  const schema = refs["domain-skill/v1"];

  const tooFew = V2_BODY();
  tooFew.output.avoid = tooFew.output.avoid.slice(0, 2);
  assert.ok(
    validate(schema, tooFew, refs).some((e) => e.includes("$.output.avoid")),
  );

  const noSeparator = V2_BODY();
  noSeparator.output.avoid[0] = "부정확한 설명을 한다";
  assert.ok(
    validate(schema, noSeparator, refs).some((e) =>
      e.includes("$.output.avoid[0]"),
    ),
  );
});

test("domain-skill: examples require a contrasting pair, ask stays inline", () => {
  const schema = refs["domain-skill/v1"];

  const single = V2_BODY();
  single.output.examples = [single.output.examples[0]];
  assert.ok(
    validate(schema, single, refs).some((e) => e.includes("$.output.examples")),
  );

  const multiline = V2_BODY();
  multiline.output.examples[0].ask = "전체를\n설명해줘";
  assert.ok(
    validate(schema, multiline, refs).some((e) =>
      e.includes("$.output.examples[0].ask"),
    ),
  );
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
