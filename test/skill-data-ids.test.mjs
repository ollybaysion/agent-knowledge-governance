import { test } from "node:test";
import assert from "node:assert/strict";

import { skillDataIds } from "../src/skill-data-ids.mjs";

test("### id — title: em, en and hyphen dashes all split, with a space on both sides", () => {
  const md = "# s\n\n## 데이터\n\n### a — 가\n\n### b – 나\n\n### c - 다\n\n### d-e — 라\n";
  assert.deepEqual(skillDataIds(md).map(({ id, title, line }) => ({ id, title, line })), [
    { id: "a", title: "가", line: 5 },
    { id: "b", title: "나", line: 7 },
    { id: "c", title: "다", line: 9 },
    { id: "d-e", title: "라", line: 11 },
  ]);
});

test("sql: the item's first ```sql fence (any case, ~~~ too), text: the prose, each trimmed of blank lines; #### stays in the prose", () => {
  const md = [
    "## 데이터",
    "### q1 — 조회", "```sql", "SELECT 1", "```",
    "### q2 — 조회", "~~~SQL", "SELECT 2", "~~~",
    "### row — 행", "", "#### 메모", "기준 정보.", "", "```sql", "SELECT a", "  FROM t WHERE id = :snsr_id", "```", "",
    "### a3 — 언어 없음", "```", "SELECT 3", "```",
    "### bare",
  ].join("\n");
  assert.deepEqual(skillDataIds(md).map(({ id, sql, text }) => ({ id, sql, text })), [
    { id: "q1", sql: "SELECT 1", text: null },
    { id: "q2", sql: "SELECT 2", text: null },
    { id: "row", sql: "SELECT a\n  FROM t WHERE id = :snsr_id", text: "#### 메모\n기준 정보." },
    { id: "a3", sql: null, text: null },
    { id: "bare", sql: null, text: null },
  ]);
});

test("the flow fence before the first ### is no item, and a ### inside it is code", () => {
  const md = "## 데이터\n\n```mermaid\nflowchart TD\n  snsr_id([센서])\n### not — an item\n  snsr_id --> row\n```\n\n입력 설명.\n\n### row — 행\n\n```sql\nSELECT a FROM t WHERE id = :snsr_id\n```\n";
  assert.deepEqual(skillDataIds(md).map(({ id, line, sql, text }) => ({ id, line, sql, text })), [
    { id: "row", line: 12, sql: "SELECT a FROM t WHERE id = :snsr_id", text: null },
  ]);
});

test("without a dash the first token is the id and the title is null", () => {
  assert.deepEqual(skillDataIds("## 데이터\n### snsr_id\n### row 설명\n").map(({ id, title, line }) => ({ id, title, line })), [
    { id: "snsr_id", title: null, line: 2 },
    { id: "row", title: null, line: 3 },
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
