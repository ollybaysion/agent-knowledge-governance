// src/starter.mjs: a starter document's items · presets · kinds and the four
// save warnings, and the info-bind warning on an agent md's 조회.
import { test } from "node:test";
import assert from "node:assert/strict";

import { infoBinds, queryKind, queryWarnings, starterPresets, starterView } from "../src/starter.mjs";

const fence = (sql) => "```sql\n" + sql + "\n```";

// FDC_EQUIPMENT info, FDC_CHAMBER kind empty, FDC_SETUP_EVENT data; FDC_GHOST has no document.
const KINDS = new Map([
  ["FDC_EQUIPMENT", "info"],
  ["FDC_CHAMBER", undefined],
  ["FDC_SETUP_EVENT", "data"],
]);

const DOC = [
  "# 설비 바탕 데이터",
  "",
  "## 데이터",
  "",
  "### eqp_info — 설비 정보",
  "",
  fence("SELECT * FROM FDC_EQUIPMENT WHERE EQP_ID = :eqp_id AND LINE_ID = :LINE"),
  "",
  "### chamber_row — 챔버 하나",
  "",
  fence("SELECT * FROM FDC_CHAMBER WHERE EQP_ID = :eqp_id AND CHM_ID = :chm_id"),
  "",
  "### setup_events — 셋업 이력",
  "",
  fence("SELECT e.* FROM FDC_EQUIPMENT q JOIN FDC_SETUP_EVENT e ON e.EQP_ID = q.EQP_ID WHERE q.EQP_ID = :eqp AND e.EVT_TIME BETWEEN :start_time AND :end_time"),
  "",
  "### ghost_row — 문서 없는 표",
  "",
  fence("SELECT * FROM OWNER.FDC_GHOST WHERE EQP_ID = :equipment"),
  "",
  "### note_only — 펜스 없음",
  "",
  "글만 있다.",
  "",
  "## 프리셋",
  "",
  "- 기본 점검: eqp_info, chamber_row",
  "- 이력 보기 : setup_events , missing_one",
  "그냥 글 줄",
  "",
  "```text",
  "- 펜스 안: eqp_info",
  "```",
].join("\n");

test("starterPresets: the - name: id, id lines of ## 프리셋, fenced code skipped; no section, no presets", () => {
  assert.deepEqual(starterPresets(DOC), [
    { name: "기본 점검", items: ["eqp_info", "chamber_row"], line: 35 },
    { name: "이력 보기", items: ["setup_events", "missing_one"], line: 36 },
  ]);
  assert.deepEqual(starterPresets("# s\n\n## 데이터\n\n- 기본: a\n"), []);
});

test("queryKind: data when one table is data; info for info, an empty kind and a table without a document", () => {
  assert.equal(queryKind(["FDC_EQUIPMENT", "FDC_SETUP_EVENT"], KINDS), "data");
  assert.equal(queryKind(["FDC_EQUIPMENT"], KINDS), "info");
  assert.equal(queryKind(["FDC_CHAMBER"], KINDS), "info");
  assert.equal(queryKind(["FDC_GHOST"], KINDS), "info");
  assert.equal(queryKind([], KINDS), "info");
});

test("infoBinds: 설비 (eqp_id · equipment · eqp) and 라인 (line) binds, any case, are left out", () => {
  assert.deepEqual(infoBinds("SELECT 1 FROM T WHERE A = :EQP_ID AND B = :Equipment AND C = :eqp AND D = :Line AND E = :snsr_id AND F = ':no'"), ["snsr_id"]);
});

test("starterView: each item's tables · kind · binds · warnings in document order, then the presets", () => {
  const view = starterView(DOC, KINDS);
  assert.deepEqual(
    view.items.map(({ id, title, tables, kind, binds }) => ({ id, title, tables, kind, binds })),
    [
      { id: "eqp_info", title: "설비 정보", tables: ["FDC_EQUIPMENT"], kind: "info", binds: ["eqp_id", "LINE"] },
      { id: "chamber_row", title: "챔버 하나", tables: ["FDC_CHAMBER"], kind: "info", binds: ["eqp_id", "chm_id"] },
      { id: "setup_events", title: "셋업 이력", tables: ["FDC_EQUIPMENT", "FDC_SETUP_EVENT"], kind: "data", binds: ["eqp", "start_time", "end_time"] },
      { id: "ghost_row", title: "문서 없는 표", tables: ["FDC_GHOST"], kind: "info", binds: ["equipment"] },
      { id: "note_only", title: "펜스 없음", tables: [], kind: null, binds: [] },
    ],
  );
  assert.deepEqual(view.items[0].warnings, [], "an info query with 설비 · 라인 binds only");
  assert.deepEqual(view.items[1].warnings, [
    "info 조회 `chamber_row` 가 바인드 `chm_id` 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다.",
  ]);
  assert.deepEqual(view.items[2].warnings, [], "a data query keeps its binds");
  assert.deepEqual(view.items[3].warnings, ["항목 `ghost_row` 가 읽는 표 `FDC_GHOST` 에 활성 DB 스키마 문서가 없다. 이 표는 info 로 센다."]);
  assert.deepEqual(view.items[4].warnings, ["항목 `note_only` 에 ```sql 펜스가 없다."]);
  assert.deepEqual(view.presets.map((p) => p.warnings), [[], ["프리셋 `이력 보기` 이 없는 항목 `missing_one` 를 가리킨다."]]);
  assert.deepEqual(view.warnings, [
    ...view.items.flatMap((i) => i.warnings),
    "프리셋 `이력 보기` 이 없는 항목 `missing_one` 를 가리킨다.",
  ]);
});

test("queryWarnings: a starter's four kinds; an agent md's info-bind ones; none for another type or no markdown", () => {
  assert.deepEqual(queryWarnings("starter", DOC, KINDS), starterView(DOC, KINDS).warnings);
  const agent = [
    "# a",
    "",
    "## 데이터",
    "",
    "### sensor_row — 센서 행",
    "",
    fence("SELECT * FROM FDC_SENSOR WHERE SNSR_ID = :snsr_id AND EQP_ID = :eqp_id"),
    "",
    "### trace — 추이",
    "",
    fence("SELECT * FROM FDC_SETUP_EVENT WHERE EQP_ID = :eqp_id AND EVT_TIME > :start_time"),
    "",
    "### ask_value — 값",
    "",
    "```ask\n값을 알려 주세요\n```",
  ].join("\n");
  const want = ["info 조회 `sensor_row` 가 바인드 `snsr_id` 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다."];
  assert.deepEqual(queryWarnings("domain-skill", agent, KINDS), want, "a table without a document is info; the item without sql is no 조회");
  assert.deepEqual(queryWarnings("domain", agent, KINDS), want);
  assert.deepEqual(queryWarnings("voc", agent, KINDS), []);
  assert.deepEqual(queryWarnings("starter", undefined, KINDS), []);
});
