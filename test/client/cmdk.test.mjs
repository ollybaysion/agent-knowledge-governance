import { test } from "node:test";
import assert from "node:assert/strict";

import { columnHit, columnSection, groupOrder, matching, rankDocs, resultHash, sectionHit, splitHash } from "../../public/lib/cmdk.mjs";

const DOCS = [
  { type: "domain-skill", id: "fdc-interlock", title: "fdc-interlock", role: "main", keywords: [{ kw: "인터락" }] },
  { type: "manual", id: "interlock-release", title: "인터락 해제 절차" },
  { type: "voc", id: "voc-2026-09-interlock", title: "voc-2026-09-interlock" },
  { type: "db-schema", id: "interlock", title: "INTERLOCK" },
  { type: "db-schema", id: "fdc_alarm_hist", title: "FDC_ALARM_HIST" },
];
const ORDER = ["db-schema", "domain-skill", "manual", "voc"];

test("an empty box puts 즐겨찾기 · 최근 first; a query puts the results first", () => {
  assert.deepEqual(groupOrder(""), ["shelf", "types", "commands"]);
  assert.deepEqual(groupOrder("  "), ["shelf", "types", "commands"]);
  assert.deepEqual(groupOrder("인터"), ["results", "types", "favorites", "recent", "commands"]);
});

test("results rank id equal · id start · id · title · keyword · body, then the type order", () => {
  const ids = rankDocs(DOCS, "interlock", { order: ORDER }).map((r) => r.doc.id);
  assert.deepEqual(ids, ["interlock", "interlock-release", "fdc-interlock", "voc-2026-09-interlock"]);
  const byTitle = rankDocs(DOCS, "해제", { order: ORDER });
  assert.deepEqual(byTitle.map((r) => [r.doc.id, r.section]), [["interlock-release", "제목"]]);
});

test("a body hit names its ## section and the line", () => {
  const bodies = new Map([["db-schema/fdc_alarm_hist", "# t\n\n## 설명\n\n알람 이력\n\n## 쓰는 법\n\n인터락만 보려면 ALARM_TYPE\n"]]);
  const r = rankDocs(DOCS, "인터락만", { order: ORDER, bodies });
  assert.equal(r.length, 1);
  assert.equal(r[0].doc.id, "fdc_alarm_hist");
  assert.equal(r[0].section, "쓰는 법");
  assert.equal(r[0].line, "인터락만 보려면 ALARM_TYPE");
});

test("every term must hit; the result count is capped", () => {
  assert.deepEqual(rankDocs(DOCS, "interlock 없는말", { order: ORDER }), []);
  const many = Array.from({ length: 20 }, (_, i) => ({ type: "voc", id: `v-${i}` }));
  assert.equal(rankDocs(many, "v-", { limit: 8 }).length, 8);
});

test("sectionHit skips fenced code headings and the # title", () => {
  assert.equal(sectionHit("# 인터락\n\n## 정리\n\n```\n## 인터락\n```\n\n인터락 줄\n", "인터락").heading, "정리");
  assert.equal(sectionHit("## 받은 말\n\n없음\n", "인터락"), null);
  assert.equal(sectionHit("---\nname: a\ndescription: 인터락 설명\n---\n\n# a\n\n## 한 줄 설명\n\n인터락 설명\n", "인터락").heading, "한 줄 설명");
});

test("matching keeps the rows whose text holds every term", () => {
  const rows = [{ l: "새 문서" }, { l: "타입 없이 올리기" }, { l: "타입 관리" }];
  assert.deepEqual(matching(rows, "타입", (r) => r.l).map((r) => r.l), ["타입 없이 올리기", "타입 관리"]);
  assert.equal(matching(rows, "", (r) => r.l).length, 3);
});

const TABLES = [
  { type: "db-schema", id: "fdc_equipment", title: "FDC_EQUIPMENT", columns: ["EQP_ID", "MODEL_CD", "MODEL_CD_OLD", "LINE_ID"] },
  { type: "db-schema", id: "fdc_model", title: "FDC_MODEL", columns: ["MODEL_ID", "VENDOR_MODEL_CD"] },
  { type: "db-schema", id: "model_cd_map", title: "MODEL_CD_MAP", columns: ["A"] },
  { type: "db-schema", id: "fdc_chamber", title: "MODEL_CD 별 챔버", columns: ["CHAMBER_ID"] },
  { type: "voc", id: "voc-1", title: "voc-1" },
];

test("a column scores equal 70 · start 55 · holds 45, case ignored and _ kept", () => {
  const cols = ["EQP_ID", "MODEL_CD", "MODEL_CD_OLD", "VENDOR_MODEL_CD"];
  assert.deepEqual(columnHit(cols, "model_cd"), { name: "MODEL_CD", score: 70, more: 2 });
  assert.deepEqual(columnHit(cols, "vendor"), { name: "VENDOR_MODEL_CD", score: 55, more: 0 });
  assert.deepEqual(columnHit(cols, "p_i"), { name: "EQP_ID", score: 45, more: 0 });
  assert.equal(columnHit(cols, "modelcd"), null);
  assert.equal(columnHit(undefined, "a"), null);
});

test("a column hit stands between id and title: id start · column equal · id · column start · title · column", () => {
  const r = rankDocs(TABLES, "MODEL_CD", { order: ORDER });
  assert.deepEqual(r.map((x) => [x.doc.id, x.score]), [
    ["model_cd_map", 80],
    ["fdc_equipment", 70],
    ["fdc_chamber", 50],
    ["fdc_model", 45],
  ]);
  assert.deepEqual(rankDocs(TABLES, "model_cd", { order: ORDER }).map((x) => x.doc.id), r.map((x) => x.doc.id));
});

test("a column hit names the column as the section, with 외 n, and the col to open on", () => {
  const [, eqp, chamber, model] = rankDocs(TABLES, "model_cd", { order: ORDER });
  assert.deepEqual([eqp.section, eqp.col, eqp.line], ["열 MODEL_CD 외 1", "MODEL_CD", null]);
  assert.deepEqual([model.section, model.col], ["열 VENDOR_MODEL_CD", "VENDOR_MODEL_CD"]);
  assert.deepEqual([chamber.section, chamber.col], ["제목", null]);
  assert.equal(columnSection({ name: "A", more: 0 }), "열 A");
});

test("a column hit beats a body hit on the same doc: one score, the column's", () => {
  const bodies = new Map([["db-schema/fdc_equipment", "# t\n\n## 쓰는 법\n\nLINE_ID 로 거른다\n"]]);
  const [r] = rankDocs(TABLES, "line_id", { order: ORDER, bodies });
  assert.deepEqual([r.doc.id, r.score, r.section, r.line, r.col], ["fdc_equipment", 70, "열 LINE_ID", null, "LINE_ID"]);
});

test("a pick opens the doc with ?col=, and the router reads it back", () => {
  const [, eqp] = rankDocs(TABLES, "model_cd", { order: ORDER });
  assert.equal(resultHash(eqp), "#/doc/db-schema/fdc_equipment?col=MODEL_CD");
  assert.equal(resultHash({ doc: { type: "voc", id: "a b" }, col: null }), "#/doc/voc/a%20b");
  assert.deepEqual(splitHash("#/doc/db-schema/fdc_equipment?col=MODEL_CD"), { path: "#/doc/db-schema/fdc_equipment", col: "MODEL_CD" });
  assert.deepEqual(splitHash("#/doc/voc/a"), { path: "#/doc/voc/a", col: null });
  assert.deepEqual(splitHash("#/doc/voc/a?x=1"), { path: "#/doc/voc/a", col: null });
});
