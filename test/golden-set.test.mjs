import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkGolden, countByKind, knowledgePaths, parseGolden } from "../src/golden-set.mjs";
import { GOLDEN_SECTIONS, joinSkill, SkillSplitError, splitSkill } from "../src/skill-sections.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const golden = read("../examples/golden-set/fdc-explain-sensor-origin.md");
const skill = read("../examples/domain-skill/fdc-explain-sensor-origin.md");

test("the example reads into settings and seven questions, one per ###, with their fields", () => {
  const { settings, questions, errors } = parseGolden(golden);
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, {
    line: "L1",
    eqp: "EQP01",
    duration: { from: "2026-10-01T00:00", to: "2026-10-01T06:00" },
  });
  assert.deepEqual(countByKind(questions), { 1: 3, 2: 2, 3: 1, 4: 1 });
  const [first, , none, , second, relate, deferred] = questions;
  assert.equal(first.text, "가상 센서는 값을 어떻게 얻나?");
  assert.deepEqual(first.pieces, ["FDC_SENSOR"]);
  assert.equal(first.rubric, "다른 센서 값으로 수식을 계산해 얻는다");
  assert.equal(none.noKnowledge, true);
  assert.deepEqual(none.pieces, []);
  assert.deepEqual(second.queries, ["sensor_row", "message_row"]);
  assert.deepEqual(relate.inputs, { snsr_id: "S-0007" });
  assert.equal(relate.kind, 3);
  assert.equal(deferred.deferred, true);
});

test("each kind has its own fields; a missing required one or a foreign one is an error naming the line", () => {
  const errs = (md) => parseGolden(md).errors;
  assert.match(errs("## 일반 지식\n\n### q\n\n- 채점표: x\n")[0], /^3행 .*"조각" 칸이 있어야/);
  assert.match(errs("## 데이터 설명\n\n### q\n\n- 조각: A\n- 조회: a\n")[0], /데이터 설명 질문의 칸은 조회 · 입력/);
  assert.match(errs("## 데이터 연관\n\n### q\n\n- 조회: a\n")[0], /"채점표" 칸이 있어야/);
  assert.match(errs("## 고도화 분석\n\n### q\n")[0], /"보류" 칸이 있어야/);
  assert.match(errs("## 고도화 분석\n\n### q\n\n- 보류: 나중\n")[0], /값 없이 "- 보류"/);
  assert.match(errs("## 일반 지식\n\n### q\n\n- 조각: A\n- 조각: B\n")[0], /두 번/);
  assert.match(errs("## 일반 지식\n\n### q\n\n아무 글\n")[0], /"- 이름: 값" 줄/);
  assert.match(errs("## 데이터 설명\n\n### q\n\n- 조회: a\n- 입력: snsr_id\n")[0], /"키=값"/);
});

test("sections: only 설정 and the four kinds, each once; a trailing ? or : is noise; a question sits under a kind", () => {
  const errs = (md) => parseGolden(md).errors;
  assert.deepEqual(errs("## 설정:\n\n- 라인: L1\n- 설비: E\n\n## 일반 지식?\n\n### q\n\n- 조각: 없음\n"), []);
  assert.match(errs("## 데이터\n\n### q\n")[0], /모르는 절/);
  assert.match(errs("## 일반 지식\n\n## 일반 지식\n")[0], /두 번/);
  assert.match(errs("## 설정\n\n### q\n")[0], /종류 절.* 아래에/);
  assert.match(errs("## 일반 지식\n\n- 조각: A\n")[0], /"### 질문"/);
});

test("settings: 라인 · 설비 · 기간, the period as start ~ end in minutes, start before end", () => {
  const errs = (md) => parseGolden(md).errors;
  assert.match(errs("## 설정\n\n- 레시피: R\n")[0], /라인 · 설비 · 기간/);
  assert.match(errs("## 설정\n\n- 기간: 2026-10-01 ~ 2026-10-02\n")[0], /시작 ~ 끝/);
  assert.match(errs("## 설정\n\n- 기간: 2026-10-01T06:00 ~ 2026-10-01T00:00\n")[0], /끝이 시작보다 뒤/);
  assert.equal(parseGolden("# g\n").settings, null);
});

test("knowledge paths follow the consumer's piece ids: headings with text, ancestors joined by ' / '", () => {
  assert.deepEqual(knowledgePaths(skill), ["FDC_SENSOR", "답하지 않는 것", "답의 예"]);
  const md = "## 도메인 지식\n\n머리\n\n### DB\n\n#### SPEC_INFO\n\n본문\n\n#### 빈 것\n\n### 끝\n\n글\n\n## 데이터\n\n### x — y\n";
  assert.deepEqual(knowledgePaths(md), ["도메인 지식", "DB / SPEC_INFO", "끝"]);
});

test("against the skill md: an unknown 조회 id is an error, an unknown 조각 path a warning", () => {
  assert.deepEqual(checkGolden(golden, skill), { errors: [], warnings: [] });
  const bad = "## 설정\n\n- 라인: L1\n- 설비: E\n\n## 일반 지식\n\n### q\n\n- 조각: 옛 제목\n\n## 데이터 설명\n\n### r\n\n- 조회: sensor_row, snsr_id, gone\n";
  const { errors, warnings } = checkGolden(bad, skill);
  // snsr_id is an ask item, not a query.
  assert.deepEqual(errors, ['14행 "### r": 스킬 md 의 ## 데이터 에 없는 조회 id 입니다 — snsr_id, gone']);
  assert.deepEqual(warnings, ['8행 "### q": 스킬 md 의 ## 도메인 지식 에 없는 조각입니다 — 옛 제목']);
});

test("data questions with no 라인 · 설비 to run in are a warning, not an error", () => {
  const { errors, warnings } = checkGolden("## 데이터 설명\n\n### r\n\n- 조회: sensor_row\n", skill);
  assert.deepEqual(errors, []);
  assert.match(warnings[0], /데이터 질문 1개를 돌릴 수 없습니다/);
});

test("the section editor splits and joins a golden md by GOLDEN_SECTIONS", () => {
  const { title, sections } = splitSkill(golden, GOLDEN_SECTIONS);
  assert.equal(title, "fdc-explain-sensor-origin 골든 셋");
  assert.deepEqual(sections.map((s) => s.key), ["설정", "일반 지식", "데이터 설명", "데이터 연관", "고도화 분석"]);
  assert.equal(joinSkill(title, sections, GOLDEN_SECTIONS), golden);
  assert.throws(() => splitSkill(golden), SkillSplitError);
});
