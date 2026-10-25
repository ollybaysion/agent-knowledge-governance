import { test } from "node:test";
import assert from "node:assert/strict";

import * as skill from "../../src/skill-sections.mjs";
import { changedKeys, joinBlocks, lineRanges, splitBlocks, withBlock } from "../../public/lib/sections.mjs";

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

test("a skill md with an unknown ## section is refused, as the server refuses it", () => {
  assert.throws(() => splitBlocks("# s\n\n## 모르는 절\n\n글\n", opts), skill.SkillSplitError);
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
