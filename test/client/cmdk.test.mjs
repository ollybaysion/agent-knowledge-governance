import { test } from "node:test";
import assert from "node:assert/strict";

import { groupOrder, matching, rankDocs, sectionHit } from "../../public/lib/cmdk.mjs";

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
