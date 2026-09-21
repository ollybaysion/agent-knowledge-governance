// Unit tests for the schema layer itself — the "모르는 키 거부" guarantee
// (design §5.0/D3) and the tiered-value state rules (json-spec §3) are the
// structural backbone every render/migrate fixture relies on, so they get
// direct coverage independent of those fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas, validateDocument } from "../src/envelope.mjs";
import { validate } from "../src/validate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "schemas"));

function minimalDbSchemaDoc() {
  return {
    schema: "db-schema/v1",
    id: "x",
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

// `owner` is optional — the id is the bare table name either way.
test("db-schema: owner may be omitted, and then id is lower(table)", () => {
  const doc = minimalDbSchemaDoc();
  delete doc.body.owner;
  doc.id = "x";
  assert.deepEqual(validateDocument(doc, refs), []);
});

test("db-schema: without owner, an owner-qualified id is rejected", () => {
  const doc = minimalDbSchemaDoc();
  delete doc.body.owner;
  doc.id = "t.x"; // id carries a schema prefix the id rule never uses
  const errors = validateDocument(doc, refs);
  assert.ok(
    errors.some((e) => e.includes('expected "x" (lower(table))')),
    `expected an id mismatch, got: ${JSON.stringify(errors)}`,
  );
});

test("db-schema: with owner, id is still lower(table) — an owner-qualified id is rejected", () => {
  const doc = minimalDbSchemaDoc();
  doc.id = "t.x"; // owner is a plain attribute; it never qualifies the id
  const errors = validateDocument(doc, refs);
  assert.ok(
    errors.some((e) => e.includes('expected "x" (lower(table))')),
  );
});

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

test("db-schema: id must be lower(table)", () => {
  const doc = minimalDbSchemaDoc();
  doc.id = "wrong.id";
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes('expected "x"')));
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

// domain-skill — the body is the author's md verbatim (user decision
// 2026-09-21): { name, markdown }. The heading structure inside the text is the
// consumer's schema; akg only refuses a `##` section it does not know.
const SKILL_MD = (mark = "T-1 의 현재 상태.") => `# x

## 한 줄 설명

${mark}

## 언제 호출되는가?

T-1 지금 어때? 같은 질문에.

## 도메인 지식

### T

- STATE: 현재 상태 코드.

## 데이터

### id — 조회 키

\`\`\`ask
어느 설비인가요?
\`\`\`

### row — 상태 행

\`\`\`sql
SELECT state FROM t WHERE id = :id
\`\`\`
`;

const MD_BODY = () => ({ name: "x", markdown: SKILL_MD() });

const skillDoc = (body = MD_BODY()) => ({
  schema: "domain-skill/v1",
  id: "x",
  keywords: [{ kw: "x", inject: "full" }],
  status: "active",
  body,
});

test("domain-skill: the md body shape is valid", () => {
  assert.deepEqual(validate(refs["domain-skill/v1"], MD_BODY(), refs), []);
  assert.deepEqual(validateDocument(skillDoc(), refs), []);
});

// The four-cell JSON shape this replaced must fail loudly rather than be stored
// as dead weight the consumer would then reject as "unknown key".
test("domain-skill: the old four-cell keys are rejected (questions, rephrasing, inputs, needs, queries, output)", () => {
  const schema = refs["domain-skill/v1"];
  for (const key of ["questions", "rephrasing", "inputs", "dependencies", "needs", "queries", "output", "argumentHint"]) {
    const body = { ...MD_BODY(), [key]: [] };
    const errors = validate(schema, body, refs);
    assert.ok(errors.some((e) => e.includes(key)), `${key} should be rejected: ${errors}`);
  }
});

test("domain-skill: name must be kebab-case and markdown must be present", () => {
  const schema = refs["domain-skill/v1"];
  assert.ok(validate(schema, { ...MD_BODY(), name: "Not_Kebab" }, refs).some((e) => e.includes("name")));
  assert.ok(validate(schema, { name: "x" }, refs).some((e) => e.includes("markdown")));
  assert.ok(validate(schema, { name: "x", markdown: "  \n" }, refs).some((e) => e.includes("markdown")));
});

test("domain-skill: id must equal body.name", () => {
  const errors = validateDocument({ ...skillDoc(), id: "y" }, refs);
  assert.ok(errors.some((e) => e.includes('expected "x" (== body.name)')));
});

test("domain-skill semantic: a `##` section the consumer does not read is rejected, with the allowed list", () => {
  const doc = skillDoc({ name: "x", markdown: SKILL_MD().replace("## 데이터", "## 데이타") });
  const errors = validateDocument(doc, refs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\$\.body\.markdown: 모르는 절입니다 — "## 데이타"/);
  assert.match(errors[0], /## 한 줄 설명 · ## 언제 호출되는가 · ## 도메인 지식 · ## 데이터/);
});

test("domain-skill semantic: a trailing ? or : on a section title is noise, and `##` inside a fence is not a section", () => {
  const md = SKILL_MD().replace("## 데이터", "## 데이터:") + "\n```sql\n## not a heading\nSELECT 1 FROM dual\n```\n";
  assert.deepEqual(validateDocument(skillDoc({ name: "x", markdown: md }), refs), []);
});

test("domain-skill semantic: deeper headings (###, ####) are the author's — only `##` is judged", () => {
  const md = SKILL_MD() + "\n### 아무 이름 — 제목\n\n#### 더 깊은 것\n\n산문.\n";
  assert.deepEqual(validateDocument(skillDoc({ name: "x", markdown: md }), refs), []);
});

test("whitespace-only strings are rejected by the \\S pattern", () => {
  const schema = refs["domain-skill/v1"];
  const errors = validate(schema, { name: "x", markdown: "  " }, refs);
  assert.ok(errors.some((e) => e.includes("markdown")));
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

// fab-line — reference data a consumer turns into a closed choice. One doc per
// line, so the id carries the code and a lister knows the codes without
// fetching every body.
function fabLineDoc() {
  return {
    schema: "fab-line/v1",
    id: "l1",
    keywords: [{ kw: "l1", inject: "pointer" }],
    status: "active",
    body: { code: "L1", name: "1라인 — 8인치 전공정" },
  };
}

test("fab-line: a minimal doc is valid and the id is lower(code)", () => {
  assert.deepEqual(validateDocument(fabLineDoc(), refs), []);
});

test("fab-line: an id that is not lower(code) is rejected", () => {
  const doc = fabLineDoc();
  doc.id = "line-1";
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("lower(code)")));
});

test("fab-line: code is uppercase — lowercase is rejected", () => {
  // 같은 라인이 표기만 달라 두 문서로 갈라지는 것을 스키마에서 막는다.
  const errors = validate(refs["fab-line/v1"], { code: "l1" }, refs);
  assert.ok(errors.length > 0);
});

test("fab-line: unknown keys are rejected", () => {
  const errors = validate(
    refs["fab-line/v1"],
    { code: "L1", fab: "P3" },
    refs,
  );
  assert.ok(errors.some((e) => e.includes("fab")));
});

// screen-map — the closed list a capture classifier answers from (issue #48,
// consumer fdc-agent-be#63). Like fab-line it is reference data with no tiered
// slots; unlike fab-line the id is carried in the body, because it is also the
// value a confirmed classification hands downstream.
function screenMapDoc() {
  return {
    schema: "screen-map/v1",
    id: "fdc-monitor-history",
    keywords: [{ kw: "fdc-monitor-history", inject: "pointer" }],
    status: "active",
    body: {
      id: "fdc-monitor-history",
      name: "센서값 이력 조회",
      program: "FDC Monitor",
      menuPath: ["이력조회"],
      hints: ["시각별 측정값을 행으로 나열한 표가 화면의 대부분을 차지한다"],
      expectedColumns: {
        required: ["설비ID", "측정시각", "측정값"],
        optional: ["단위"],
      },
    },
  };
}

test("screen-map: a full doc is valid", () => {
  assert.deepEqual(validateDocument(screenMapDoc(), refs), []);
});

test("screen-map: id and name alone are enough", () => {
  // 저작자가 program·hints 를 안 채워도 문서는 선다 — 소비자(BE)가 빠진 필드를
  // null 로 느슨하게 받는 것과 같은 관용.
  const doc = screenMapDoc();
  doc.body = { id: "spc-control-chart", name: "관리도 조회" };
  doc.id = "spc-control-chart";
  doc.keywords = [{ kw: "spc-control-chart", inject: "pointer" }];
  assert.deepEqual(validateDocument(doc, refs), []);
});

test("screen-map: a document id that drifts from body.id is rejected", () => {
  // 목록의 id 와 본문의 id 가 갈리면 소비자가 어느 쪽을 확정값으로 쓸지 모른다.
  const doc = screenMapDoc();
  doc.id = "fdc-monitor-hist";
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("== body.id")));
});

test("screen-map: id and name are required", () => {
  assert.ok(
    validate(refs["screen-map/v1"], { name: "이름만" }, refs).length > 0,
  );
  assert.ok(
    validate(refs["screen-map/v1"], { id: "only-id" }, refs).length > 0,
  );
});

test("screen-map: a blank name is rejected", () => {
  // BE 가 후보 행에 그대로 찍는 값이라 공백이면 이름 없는 선택지가 된다.
  const errors = validate(
    refs["screen-map/v1"],
    { id: "x", name: "   " },
    refs,
  );
  assert.ok(errors.length > 0);
});

test("screen-map: an uppercase id is rejected", () => {
  const errors = validate(
    refs["screen-map/v1"],
    { id: "FDC-Monitor", name: "이력조회" },
    refs,
  );
  assert.ok(errors.length > 0);
});

test("screen-map: a column in both required and optional is rejected", () => {
  const doc = screenMapDoc();
  doc.body.expectedColumns = {
    required: ["측정시각", "측정값"],
    optional: ["측정값"],
  };
  const errors = validateDocument(doc, refs);
  assert.ok(errors.some((e) => e.includes("already in required")));
});

test("screen-map: unknown keys are rejected", () => {
  const errors = validate(
    refs["screen-map/v1"],
    { id: "x", name: "이력조회", route: "/fdc/history" },
    refs,
  );
  assert.ok(errors.some((e) => e.includes("route")));
});

test("screen-map: the shipped example validates", () => {
  // 이 문서는 BE 번들(src/main/resources/screen-maps/)의 같은 화면과 짝이다 —
  // 예제가 깨지면 사내 저작자가 베낄 견본이 없다.
  const doc = JSON.parse(
    readFileSync(
      new URL("../examples/screen-map/fdc-monitor-history.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(validateDocument(doc, refs), []);
});
