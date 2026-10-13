import { test } from "node:test";
import assert from "node:assert/strict";

import { skillDataIds } from "../src/skill-data-ids.mjs";

test("### id — title: em, en and hyphen dashes all split, with a space on both sides", () => {
  const md = "# s\n\n## 데이터\n\n### a — 가\n\n### b – 나\n\n### c - 다\n\n### d-e — 라\n";
  assert.deepEqual(skillDataIds(md), [
    { id: "a", title: "가", line: 5, query: false },
    { id: "b", title: "나", line: 7, query: false },
    { id: "c", title: "다", line: 9, query: false },
    { id: "d-e", title: "라", line: 11, query: false },
  ]);
});

test("query: an item whose body opens a ```sql fence (any case, ~~~ too); ask fences and prose are questions", () => {
  const md = [
    "## 데이터",
    "### q1 — 조회", "```sql", "SELECT 1", "```",
    "### q2 — 조회", "~~~SQL", "SELECT 2", "~~~",
    "### a1 — 물음", "```ask", "어느 설비?", "```",
    "### a2 — 물음", "설명만.",
    "### a3 — 물음", "```", "언어 없음", "```",
  ].join("\n");
  assert.deepEqual(
    skillDataIds(md).map((d) => [d.id, d.query]),
    [["q1", true], ["q2", true], ["a1", false], ["a2", false], ["a3", false]],
  );
});

test("without a dash the first token is the id and the title is null", () => {
  assert.deepEqual(skillDataIds("## 데이터\n### snsr_id\n### row 설명\n"), [
    { id: "snsr_id", title: null, line: 2, query: false },
    { id: "row", title: null, line: 3, query: false },
  ]);
});

test("#### lines are item body, and ### inside a fence is code", () => {
  const md = "## 데이터\n\n### a — 가\n\n#### 메모\n\n```sql\n### b — 아님\n```\n\n~~~\n### c\n~~~\n";
  assert.deepEqual(skillDataIds(md).map((d) => d.id), ["a"]);
});

test("only ## 데이터 counts: ### in other sections and a doc without the section give nothing", () => {
  assert.deepEqual(skillDataIds("# s\n\n## 도메인 지식\n\n### T — 표\n"), []);
  assert.deepEqual(skillDataIds("# s\n"), []);
  assert.deepEqual(skillDataIds(undefined), []);
  const md = "## 데이터\n### a\n## 도메인 지식\n### b\n";
  assert.deepEqual(skillDataIds(md).map((d) => d.id), ["a"]);
});

test("the section title matches through spacing and a trailing : or ?", () => {
  for (const heading of ["##   데이터  ", "## 데이터:", "## 데이터 ?", "## 데이터 ##"])
    assert.deepEqual(skillDataIds(`${heading}\n### a — 가\n`).map((d) => d.id), ["a"], heading);
});
