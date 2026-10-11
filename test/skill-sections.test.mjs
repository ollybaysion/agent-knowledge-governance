import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { joinSkill, SkillSplitError, splitSkill } from "../src/skill-sections.mjs";

const example = JSON.parse(
  readFileSync(new URL("../examples/domain-skill/fdc-explain-sensor-origin.json", import.meta.url), "utf8"),
).body.markdown;

test("split → join gives the document back byte for byte when its sections are in the standard order", () => {
  const { title, sections } = splitSkill(example);
  assert.equal(title, "fdc-explain-sensor-origin");
  assert.deepEqual(sections.map((s) => s.heading), ["한 줄 설명", "언제 호출되는가?", "도메인 지식", "데이터"]);
  assert.ok(sections[2].body.startsWith("### FDC_SENSOR"));
  assert.equal(joinSkill(title, sections), example);
});

test("a ## inside a fenced block is text of its section, not a heading", () => {
  const md = "# s\n\n## 데이터\n\n```sql\n## not a heading\nSELECT 1\n```\n\n~~~\n## nor this\n~~~\n";
  const { sections } = splitSkill(md);
  assert.equal(sections[3].body, "```sql\n## not a heading\nSELECT 1\n```\n\n~~~\n## nor this\n~~~");
  assert.equal(joinSkill("s", sections), md);
});

test("an unknown or repeated section, or text outside a section, is refused", () => {
  assert.throws(() => splitSkill("# s\n\n## 데이타\n\nx\n"), SkillSplitError);
  assert.throws(() => splitSkill("# s\n\n## 데이터\n\na\n\n## 데이터:\n\nb\n"), SkillSplitError);
  assert.throws(() => splitSkill("# s\n\n머리말\n\n## 데이터\n\na\n"), SkillSplitError);
});

test("missing sections split to empty bodies; join writes standard order and leaves empty sections out", () => {
  const { title, sections } = splitSkill("# s\n\n## 데이터\n\nd\n\n## 한 줄 설명:\n\n요약\n");
  assert.deepEqual(
    sections.map((s) => [s.key, s.heading, s.body]),
    [
      ["한 줄 설명", "한 줄 설명:", "요약"],
      ["언제 호출되는가", "언제 호출되는가?", ""],
      ["도메인 지식", "도메인 지식", ""],
      ["데이터", "데이터", "d"],
    ],
  );
  assert.equal(joinSkill(title, sections), "# s\n\n## 한 줄 설명:\n\n요약\n\n## 데이터\n\nd\n");
});
