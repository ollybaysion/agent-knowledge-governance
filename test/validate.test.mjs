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

// domain-skill spec v3 (issue #46) — the four cells: question → rephrasing →
// needs → queries. `needs` is the first-class one; a query only exists to fill
// one, which is why most of the semantic checks below are "does this pointer
// point at anything".
const V3_BODY = () => ({
  name: "x",
  argumentHint: "{id}",
  questions: ["T-1 지금 어때?", "T-1 상태 어떻지?"],
  rephrasing: "T-1 의 현재 상태.",
  inputs: [{ name: "id", required: true, description: "조회 키" }],
  dependencies: [{ mcp: "agent-db-plugin" }],
  needs: [
    {
      id: "state",
      what: "현재 상태",
      filledBy: [{ query: "row", column: "STATE" }],
    },
  ],
  queries: [
    {
      id: "row",
      kind: "sql",
      sql: "SELECT state FROM t WHERE id = :id",
      binds: { id: { from: "arg", arg: "id" } },
    },
  ],
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

const skillDoc = (body = V3_BODY()) => ({
  schema: "domain-skill/v1",
  id: "x",
  keywords: [{ kw: "x", inject: "full" }],
  status: "active",
  body,
});

test("domain-skill: the v3 body shape is valid", () => {
  assert.deepEqual(validate(refs["domain-skill/v1"], V3_BODY(), refs), []);
  assert.deepEqual(validateDocument(skillDoc(), refs), []);
});

// v3 removed these; an old body must fail loudly rather than lose its rules to
// additionalProperties. (v2 removed description/valueRules/h1Title before it —
// those stay rejected too.)
test("domain-skill: removed keys are rejected (scope, focus, intro, steps, description, valueRules)", () => {
  const schema = refs["domain-skill/v1"];
  for (const [key, value] of [
    ["scope", { 단위: "센서", 카디널리티: "단일", 의도: "상태" }],
    ["focus", "현재 상태"],
    ["intro", "도메인 주의사항."],
    ["steps", [{ title: "s1", produces: "현재 상태", sql: "SELECT 1" }]],
    ["description", "설명."],
    ["valueRules", [{ target: "A", rule: "B", basis: "scaffold" }]],
    ["h1Title", "안 됨"],
  ]) {
    const body = V3_BODY();
    body[key] = value;
    const errors = validate(schema, body, refs);
    assert.ok(
      errors.some((e) => e.includes(key)),
      `${key} 는 거부돼야 함: ${JSON.stringify(errors)}`,
    );
  }
  // produces lived on a step; on a query it is just an unknown key.
  const withProduces = V3_BODY();
  withProduces.queries[0].produces = "현재 상태";
  assert.ok(
    validate(schema, withProduces, refs).some((e) => e.includes("produces")),
  );
});

test("domain-skill: name must be kebab-case", () => {
  const body = { ...V3_BODY(), name: "Not_Kebab" };
  const errors = validate(refs["domain-skill/v1"], body, refs);
  assert.ok(errors.some((e) => e.includes("$.name")));
});

test("domain-skill: questions are the routing signal and each stays on one line", () => {
  const schema = refs["domain-skill/v1"];

  const missing = V3_BODY();
  delete missing.questions;
  assert.ok(validate(schema, missing, refs).some((e) => e.includes("questions")));

  // 같은 질문의 다른 말투를 여러 줄로 — 하나로는 사람들이 묻는 방식을 못 덮는다.
  const none = { ...V3_BODY(), questions: [] };
  assert.ok(validate(schema, none, refs).some((e) => e.includes("$.questions")));

  const multiline = { ...V3_BODY(), questions: ["T-1 지금 어때?", "T-1\n상태는?"] };
  assert.ok(
    validate(schema, multiline, refs).some((e) => e.includes("$.questions[1]")),
  );
});

test("domain-skill: queries[].kind is a closed enum", () => {
  const body = V3_BODY();
  body.queries[0].kind = "http"; // 확장은 akg 가 발행한다
  assert.ok(
    validate(refs["domain-skill/v1"], body, refs).some((e) =>
      e.includes("$.queries[0].kind"),
    ),
  );
});

// inputs[].type (issue #49) — input-widget signal for consumers. Optional and
// closed: omitted means free text, and anything outside the enum is a typo
// that must fail loudly, not silently render as a text box.
test("domain-skill: inputs[].type is optional and a closed enum", () => {
  const schema = refs["domain-skill/v1"];

  for (const t of ["datetime", "date"]) {
    const body = V3_BODY();
    body.inputs[0].type = t;
    assert.deepEqual(validate(schema, body, refs), []);
  }

  const bad = V3_BODY();
  bad.inputs[0].type = "time";
  assert.ok(
    validate(schema, bad, refs).some((e) => e.includes("$.inputs[0].type")),
  );
});

test("domain-skill: needs require at least one item, and an empty filledBy is allowed", () => {
  const schema = refs["domain-skill/v1"];

  const none = { ...V3_BODY(), needs: [] };
  assert.ok(validate(schema, none, refs).some((e) => e.includes("$.needs")));

  // 빈 filledBy 는 흠이 아니라 선언이다 — "이 스킬로는 못 얻는다"(답불가).
  const unfillable = V3_BODY();
  unfillable.needs.push({ id: "operator", what: "작업자", filledBy: [] });
  assert.deepEqual(validate(schema, unfillable, refs), []);
  assert.deepEqual(validateDocument(skillDoc(unfillable), refs), []);
});

test("domain-skill: needs semantic — filledBy must name a real query and a selected column", () => {
  const noQuery = skillDoc();
  noQuery.body.needs[0].filledBy[0].query = "nope";
  assert.ok(
    validateDocument(noQuery, refs).some((e) =>
      e.includes('id "nope" 인 쿼리가 없습니다'),
    ),
  );

  // 컬럼을 못 박은 이유가 이 케이스다 — 쿼리는 도착하는데 그 컬럼이 없으면
  // 결정론 판정이 "데이터가 없다"로 읽는다.
  const noColumn = skillDoc();
  noColumn.body.needs[0].filledBy[0].column = "GHOST";
  assert.ok(
    validateDocument(noColumn, refs).some((e) =>
      e.includes('SELECT 목록에 "GHOST" 이 없습니다'),
    ),
  );
});

test("domain-skill: needs semantic — a select list it cannot read is not judged", () => {
  // `*` 는 컬럼 목록이 아니고, 별칭 없는 식은 이름이 없다. 추측하느니 비켜선다
  // (table 의 단일 FROM 규율과 같다).
  for (const sql of [
    "SELECT * FROM t WHERE id = :id",
    "SELECT t.* FROM t WHERE id = :id",
    "SELECT COUNT(*) FROM t WHERE id = :id",
  ]) {
    const doc = skillDoc();
    doc.body.queries[0].sql = sql;
    assert.deepEqual(validateDocument(doc, refs), [], sql);
  }

  // 별칭은 읽는다 — TO_CHAR(...) AS d 는 컬럼 d 다.
  const aliased = skillDoc();
  aliased.body.queries[0].sql =
    "SELECT TO_CHAR(ts, 'YYYY-MM-DD') AS d FROM t WHERE id = :id";
  aliased.body.needs[0].filledBy[0].column = "D";
  assert.deepEqual(validateDocument(aliased, refs), []);
});

test("domain-skill: needs semantic — when must name another need, and cannot cycle", () => {
  const dangling = skillDoc();
  dangling.body.needs.push({
    id: "stop_reason",
    what: "멈춘 사유",
    when: "nope = STOP",
    filledBy: [{ query: "row", column: "STATE" }],
  });
  assert.ok(
    validateDocument(dangling, refs).some((e) =>
      e.includes("참조하는 needs 가 없습니다"),
    ),
  );

  const cyclic = skillDoc();
  cyclic.body.needs = [
    {
      id: "a",
      what: "가",
      when: "b = 1",
      filledBy: [{ query: "row", column: "STATE" }],
    },
    {
      id: "b",
      what: "나",
      when: "a = 1",
      filledBy: [{ query: "row", column: "STATE" }],
    },
  ];
  assert.ok(
    validateDocument(cyclic, refs).some((e) =>
      e.includes("when 조건이 순환합니다"),
    ),
  );
});

test("domain-skill: ids address things now, so duplicates are rejected", () => {
  const dupQuery = skillDoc();
  dupQuery.body.queries.push({
    id: "row",
    kind: "sql",
    sql: "SELECT state FROM u",
  });
  assert.ok(
    validateDocument(dupQuery, refs).some((e) =>
      e.includes('중복된 쿼리 id "row"'),
    ),
  );

  const dupNeed = skillDoc();
  dupNeed.body.needs.push({
    id: "state",
    what: "또 현재 상태",
    filledBy: [{ query: "row", column: "STATE" }],
  });
  assert.ok(
    validateDocument(dupNeed, refs).some((e) =>
      e.includes('중복된 needs id "state"'),
    ),
  );
});

// queries[].binds (issue #32, re-pointed by #46) — executor wiring. The schema
// shapes each source; the envelope semantic check sees the spec around it
// (inputs, the other queries, the SQL itself). `from: "step"` (an index into an
// ordered list) became `from: "query"` (an id) when the order went away.
const BOUND_BODY = () => {
  const body = V3_BODY();
  body.queries = [
    {
      id: "sensor_row",
      kind: "sql",
      sql: "SELECT eqp_id, state FROM t WHERE x = :x",
      binds: { x: { from: "arg", arg: "id" } },
    },
    {
      id: "equipment_row",
      kind: "sql",
      sql: "SELECT name FROM u WHERE e = :e",
      binds: { e: { from: "query", query: "sensor_row", column: "EQP_ID" } },
    },
  ];
  body.needs = [
    {
      id: "state",
      what: "현재 상태",
      filledBy: [{ query: "sensor_row", column: "STATE" }],
    },
    {
      id: "owner",
      what: "소속 설비",
      filledBy: [{ query: "equipment_row", column: "NAME" }],
    },
  ];
  return body;
};

const boundDoc = () => skillDoc(BOUND_BODY());

test("domain-skill: binds — both source shapes are valid", () => {
  assert.deepEqual(validate(refs["domain-skill/v1"], BOUND_BODY(), refs), []);
  assert.deepEqual(validateDocument(boundDoc(), refs), []);
});

test("domain-skill: binds — cross-shape and unknown keys are rejected", () => {
  const schema = refs["domain-skill/v1"];

  // arg 형이 query 형의 키를 가짐 — then 분기의 additionalProperties 가 잡는다.
  const argWithColumn = BOUND_BODY();
  argWithColumn.queries[0].binds.x.column = "EQP_ID";
  assert.ok(
    validate(schema, argWithColumn, refs).some((e) => e.includes("column")),
  );

  const typo = BOUND_BODY();
  typo.queries[1].binds.e.colunm = "EQP_ID";
  assert.ok(validate(schema, typo, refs).some((e) => e.includes("colunm")));

  // 인덱스는 더 이상 주소가 아니다 — query 는 id 문자열이어야 한다.
  const index = BOUND_BODY();
  index.queries[1].binds.e.query = 0;
  assert.ok(validate(schema, index, refs).some((e) => e.includes("query")));
});

test("domain-skill: binds semantic — arg must name a real input", () => {
  const doc = boundDoc();
  doc.body.queries[0].binds.x.arg = "nope";
  assert.ok(
    validateDocument(doc, refs).some((e) =>
      e.includes('no input named "nope"'),
    ),
  );
});

test("domain-skill: binds semantic — a query reference must exist, and cannot cycle", () => {
  const dangling = boundDoc();
  dangling.body.queries[1].binds.e.query = "nope";
  assert.ok(
    validateDocument(dangling, refs).some((e) =>
      e.includes('id "nope" 인 쿼리가 없습니다'),
    ),
  );

  const missingColumn = boundDoc();
  missingColumn.body.queries[1].binds.e.column = "GHOST";
  assert.ok(
    validateDocument(missingColumn, refs).some((e) =>
      e.includes('SELECT 목록에 "GHOST" 이 없습니다'),
    ),
  );

  // 순서가 사라지면서 `step < i` 가 막아 주던 것이 여기로 왔다 — 자기 참조도
  // 길이 1 의 순환이다.
  const self = boundDoc();
  self.body.queries[1].binds.e.query = "equipment_row";
  self.body.queries[1].sql = "SELECT name, e FROM u WHERE e = :e";
  self.body.queries[1].binds.e.column = "E";
  assert.ok(
    validateDocument(self, refs).some((e) =>
      e.includes("binds 가 순환합니다 — equipment_row → equipment_row"),
    ),
  );

  const cyclic = boundDoc();
  cyclic.body.queries[0].sql = "SELECT eqp_id, state FROM t WHERE x = :x";
  cyclic.body.queries[0].binds = {
    x: { from: "query", query: "equipment_row", column: "NAME" },
  };
  assert.ok(
    validateDocument(cyclic, refs).some((e) =>
      e.includes("binds 가 순환합니다"),
    ),
  );
});

test("domain-skill: binds semantic — sql :vars and binds keys match exactly", () => {
  // 빠짐: SQL 이 :x 를 쓰는데 binds 가 선언 안 함 → 실행 불가 쿼리.
  const missing = boundDoc();
  missing.body.queries[0].binds = {};
  assert.ok(
    validateDocument(missing, refs).some((e) =>
      e.includes("sql uses :x but it is not declared"),
    ),
  );

  // 남음: binds 가 SQL 에 없는 :y 를 주장함.
  const extra = boundDoc();
  extra.body.queries[0].sql = "SELECT eqp_id, state FROM t WHERE x = :x AND y = :y";
  extra.body.queries[0].binds.y = { from: "arg", arg: "id" };
  assert.deepEqual(validateDocument(extra, refs), []);
  delete extra.body.queries[0].binds.y;
  assert.ok(
    validateDocument(extra, refs).some((e) =>
      e.includes("sql uses :y but it is not declared"),
    ),
  );

  const unused = boundDoc();
  unused.body.queries[1].binds.ghost = {
    from: "query",
    query: "sensor_row",
    column: "STATE",
  };
  assert.ok(
    validateDocument(unused, refs).some((e) =>
      e.includes("declared but sql has no :ghost"),
    ),
  );

  // 따옴표 리터럴 속 ':' 는 bind 가 아니다 — 날짜 마스크가 오탐되면 안 된다.
  const mask = boundDoc();
  mask.body.queries[0].sql =
    "SELECT TO_CHAR(t, 'HH24:MI') AS eqp_id, state FROM d WHERE x = :x";
  assert.deepEqual(validateDocument(mask, refs), []);
});

test("domain-skill: a spec without binds stays valid (prose-only consumers)", () => {
  const doc = boundDoc();
  delete doc.body.queries[0].binds;
  delete doc.body.queries[1].binds;
  doc.body.queries[0].sql = "SELECT eqp_id, state FROM t";
  doc.body.queries[1].sql = "SELECT name FROM u";
  assert.deepEqual(validateDocument(doc, refs), []);
});

// queries[].table (issue #44) — the query's source table, named for the prompt
// synthesizer's data-block heading and the db-schema excerpt lookup. The schema
// only says "a non-empty string"; whether it agrees with the SQL beside it is
// the envelope semantic check.
const TABLED_BODY = () => {
  const body = V3_BODY();
  body.queries = [
    {
      id: "row",
      kind: "sql",
      table: "fdc_sensor",
      sql: "SELECT state FROM fdc_sensor WHERE snsr_id = :x",
      binds: { x: { from: "arg", arg: "id" } },
    },
  ];
  return body;
};

const tabledDoc = () => skillDoc(TABLED_BODY());

test("domain-skill: table — a query naming the table it selects from is valid", () => {
  assert.deepEqual(validate(refs["domain-skill/v1"], TABLED_BODY(), refs), []);
  assert.deepEqual(validateDocument(tabledDoc(), refs), []);
});

test("domain-skill: table — must be a non-empty string", () => {
  const schema = refs["domain-skill/v1"];

  const blank = TABLED_BODY();
  blank.queries[0].table = "   ";
  assert.ok(validate(schema, blank, refs).some((e) => e.includes("table")));

  const list = TABLED_BODY();
  list.queries[0].table = ["fdc_sensor"]; // 스킬 레벨 목록은 기각됐다 — 쿼리당 하나
  assert.ok(validate(schema, list, refs).some((e) => e.includes("table")));
});

test("domain-skill: table semantic — disagreeing with the sql FROM is rejected", () => {
  const doc = tabledDoc();
  doc.body.queries[0].table = "fdc_equipment"; // SQL 은 fdc_sensor 를 읽는다
  assert.ok(
    validateDocument(doc, refs).some((e) =>
      e.includes('"fdc_equipment" but the sql selects from "fdc_sensor"'),
    ),
  );
});

test("domain-skill: table semantic — case and owner prefix are noise", () => {
  // db-schema 문서 id 는 lower(table) 이고 owner 는 body 속성일 뿐이라
  // TESTUSER.FDC_SENSOR 와 fdc_sensor 는 같은 문서를 가리킨다.
  const doc = tabledDoc();
  doc.body.queries[0].table = "TESTUSER.FDC_SENSOR";
  assert.deepEqual(validateDocument(doc, refs), []);

  const quoted = tabledDoc();
  quoted.body.queries[0].sql =
    'SELECT s.state FROM "FDC_SENSOR" s WHERE s.snsr_id = :x';
  assert.deepEqual(validateDocument(quoted, refs), []);
});

test("domain-skill: table semantic — a query with no sole FROM is not judged", () => {
  // 조인·집합연산·인라인뷰는 대조할 단일 FROM 이 없다. 추측하느니 비켜선다
  // (binds 없는 쿼리를 안 건드리는 것과 같은 규율).
  for (const sql of [
    "SELECT s.state FROM fdc_sensor s JOIN fdc_equipment e ON e.eqp_id = s.eqp_id WHERE s.snsr_id = :x",
    "SELECT state FROM fdc_sensor, fdc_equipment WHERE snsr_id = :x",
    "SELECT state FROM (SELECT state FROM fdc_sensor WHERE snsr_id = :x)",
  ]) {
    const doc = tabledDoc();
    doc.body.queries[0].sql = sql;
    doc.body.queries[0].table = "fdc_equipment";
    assert.deepEqual(validateDocument(doc, refs), [], sql);
  }

  // 따옴표 속 FROM 은 구문이 아니다 — 리터럴을 벗기고 세므로 여전히 단일 FROM.
  const literal = tabledDoc();
  literal.body.queries[0].sql =
    "SELECT 'FROM me' AS note, state FROM fdc_sensor WHERE snsr_id = :x";
  literal.body.queries[0].table = "fdc_equipment";
  assert.ok(
    validateDocument(literal, refs).some((e) =>
      e.includes('the sql selects from "fdc_sensor"'),
    ),
  );
});

test("domain-skill: a spec without table stays valid (기존 spec 무회귀)", () => {
  const doc = tabledDoc();
  delete doc.body.queries[0].table;
  assert.deepEqual(validateDocument(doc, refs), []);
});

test("whitespace-only strings are rejected by the \\S pattern", () => {
  const schema = refs["domain-skill/v1"];
  const body = { ...V3_BODY(), argumentHint: "  " };
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
