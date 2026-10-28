import { test } from "node:test";
import assert from "node:assert/strict";

import * as skill from "../../src/skill-sections.mjs";
import { changedKeys, headingPaths, joinBlocks, lineRanges, normSection, sameSection, splitBlocks, withBlock } from "../../public/lib/sections.mjs";
import { knowledgePaths } from "../../src/verify-set.mjs";

const SKILL = skill.joinSkill(
  "Interlock 에이전트",
  [
    { key: "한 줄 설명", heading: "한 줄 설명", body: "인터락을 설명한다." },
    { key: "언제 호출되는가", heading: "언제 호출되는가?", body: "인터락을 물을 때." },
    { key: "도메인 지식", heading: "도메인 지식", body: "### FDC_ALARM_HIST\n\n- 하나\n- 둘" },
    { key: "데이터", heading: "데이터", body: "### alarm_hist — 이력\n\n```sql\nSELECT 1\n```" },
  ],
);
const opts = { skill, order: skill.SKILL_SECTIONS };

test("a skill md splits into its sections and joins back with joinSkill, unchanged", () => {
  const split = splitBlocks(SKILL, opts);
  assert.equal(split.mode, "skill");
  assert.equal(split.title, "Interlock 에이전트");
  assert.deepEqual(split.blocks.map((b) => b.key), skill.SKILL_SECTIONS.map((s) => s.key));
  assert.equal(joinBlocks(split, split.blocks, opts), SKILL);
  const viaJoinSkill = skill.joinSkill(split.title, split.blocks, skill.SKILL_SECTIONS);
  assert.equal(joinBlocks(split, split.blocks, opts), viaJoinSkill);
});

test("절 저장 changes one section and leaves the others as saved", () => {
  const split = splitBlocks(SKILL, opts);
  const next = withBlock(split, "도메인 지식", "### FDC_ALARM_HIST\n\n- 하나\n- 셋", opts);
  const again = splitBlocks(next, opts);
  assert.equal(again.blocks.find((b) => b.key === "도메인 지식").body, "### FDC_ALARM_HIST\n\n- 하나\n- 셋");
  for (const key of ["한 줄 설명", "언제 호출되는가", "데이터"])
    assert.equal(again.blocks.find((b) => b.key === key).body, split.blocks.find((b) => b.key === key).body);
  assert.deepEqual(changedKeys(split.blocks, again.blocks), ["도메인 지식"]);
});

test("a skill md with an unknown ## section: the skill split refuses it, the every-## split keeps it through 절 저장", () => {
  const md = "# s\n\n## 도메인 지식\n\n글\n\n## 모르는 절\n\n메모\n";
  assert.throws(() => splitBlocks(md, opts), skill.SkillSplitError);
  const split = splitBlocks(md, { skill });
  assert.equal(split.mode, "plain");
  assert.deepEqual(split.blocks.map((b) => b.key), ["도메인 지식", "모르는 절"]);
  assert.equal(joinBlocks(split), md);
  assert.equal(withBlock(split, "도메인 지식", "고친 글"), "# s\n\n## 도메인 지식\n\n고친 글\n\n## 모르는 절\n\n메모\n");
});

test("an md of another type splits on every ## and joins back byte for byte", () => {
  const md = "# 회의록\n\n앞 글\n\n## 받은 말\n\n\"알람이 안 떠요\"\n\n## 정리\n\n- 설비: A\n- [[fdc_sensor]]\n";
  const split = splitBlocks(md);
  assert.equal(split.mode, "plain");
  assert.equal(split.title, "회의록");
  assert.equal(split.head, "# 회의록\n\n앞 글");
  assert.deepEqual(split.blocks.map((b) => b.key), ["받은 말", "정리"]);
  assert.equal(joinBlocks(split), md);
  assert.equal(joinBlocks(splitBlocks(withBlock(split, "정리", "- 설비: B"))), withBlock(split, "정리", "- 설비: B"));
});

test("a ## inside a code fence is text, and a repeated heading gets its own key", () => {
  const md = "## a\n\n```\n## not\n```\n\n## a\n\nx\n";
  const split = splitBlocks(md);
  assert.deepEqual(split.blocks.map((b) => b.key), ["a", "a#2"]);
  assert.equal(joinBlocks(split), md);
});

test("line ranges follow the joined md", () => {
  const split = splitBlocks(SKILL, opts);
  const r = lineRanges(split, split.blocks, opts);
  const lines = SKILL.split("\n");
  assert.equal(lines[r.get("도메인 지식").from - 1], "## 도메인 지식");
  assert.equal(lines[r.get("도메인 지식").to - 1], "- 둘");
  assert.equal(r.get("답변 품질 검증 Set"), null);
});

test("headingPaths: a heading after the lower-level headings above it, joined with \" / \"", () => {
  const body = ["### DB", "", "#### PARAM_INFO", "", "글", "", "#### SPEC_INFO", "", "글", "", "### 끝", "", "글", "", "```", "### 펜스 안", "```"].join("\n");
  assert.deepEqual(headingPaths(body), ["DB", "DB / PARAM_INFO", "DB / SPEC_INFO", "끝"]);
  assert.deepEqual(headingPaths("#### 깊게\n\n##### 더\n\n#### 다시\n"), ["깊게", "깊게 / 더", "다시"]);
  assert.deepEqual(headingPaths("# 머리\n\n### A\n"), [null, "A"]);
  assert.deepEqual(headingPaths("글만\n"), []);
});

test("headingPaths: the paths with text are the ones the consumer pieces (knowledgePaths)", () => {
  const body = "### DB\n\n#### PARAM_INFO\n\n글\n\n### 답의 예\n\n글\n";
  const md = `# s\n\n## 도메인 지식\n\n${body}`;
  assert.deepEqual(knowledgePaths(md), ["DB / PARAM_INFO", "답의 예"]);
  for (const p of knowledgePaths(md)) assert.ok(headingPaths(body).includes(p), p);
});

test("sameSection: the ## rule (trailing ? : and spaces) plus any spacing around /", () => {
  assert.equal(normSection(" 언제 호출되는가? "), "언제 호출되는가");
  assert.equal(normSection("DB/PARAM_INFO"), "DB / PARAM_INFO");
  assert.ok(sameSection("DB/PARAM_INFO", "DB  /  PARAM_INFO"));
  assert.ok(sameSection("언제 호출되는가", "언제 호출되는가?"));
  assert.equal(sameSection("DB", "DB / PARAM_INFO"), false);
  assert.equal(sameSection("", ""), false);
});

test("withBlock: editing another section leaves the 데이터 flow fence and its queries where they were", () => {
  const md = skill.joinSkill("게이트", [
    { key: "한 줄 설명", heading: "한 줄 설명", body: "멈춤 점검." },
    { key: "데이터", heading: "데이터", body: "```mermaid\nflowchart TD\n  q[조회]\n```\n\n### q — 조회\n\n```sql\nSELECT a FROM t\n```" },
  ]);
  const opts = { skill, order: skill.SKILL_SECTIONS };
  const out = withBlock(splitBlocks(md, opts), "한 줄 설명", "설비가 멈췄을 때.", opts);
  assert.equal(out, md.replace("멈춤 점검.", "설비가 멈췄을 때."));
});
