import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { checkVerifySet, countByKind, knowledgePaths, parseVerifySet, verifySetTemplate } from "../src/verify-set.mjs";
import { joinSkill, splitSkill } from "../src/skill-sections.mjs";

const skill = readFileSync(new URL("../examples/domain-skill/fdc-explain-sensor-origin.md", import.meta.url), "utf8");

// The example skill with a verification set: knowledge 3 · explain 2 · relate 1 · advanced 1.
const SET = [
  "## 답변 품질 검증 Set",
  "",
  "### 설정",
  "",
  "- 라인: L1",
  "- 설비: EQP01",
  "- 기간: 2026-10-01T00:00 ~ 2026-10-01T06:00",
  "",
  "### 일반 지식",
  "",
  "#### 가상 센서는 값을 어떻게 얻나?",
  "",
  "- 정답: FDC_SENSOR",
  "- 채점표: 다른 센서 값으로 수식을 계산해 얻는다",
  "",
  "#### ARG_ORDER 가 크면 중요한 입력 센서인가?",
  "",
  "- 정답: FDC_SENSOR",
  "",
  "#### 센서 값의 단위 환산 규칙은?",
  "",
  "- 정답: 없음",
  "",
  "### 데이터 설명",
  "",
  "#### S-0004 는 물리 센서인가 가상 센서인가?",
  "",
  "```sql",
  "SELECT snsr_id, eqp_id, snsr_kind, snsr_type_cd, unit_cd",
  "  FROM fdc_sensor WHERE snsr_id = 'S-0004'",
  "```",
  "",
  "#### S-0004 값은 어느 메시지로 들어오나?",
  "",
  "```sql",
  "SELECT vid, msg_name FROM fdc_message WHERE snsr_id = 'S-0004'",
  "```",
  "",
  "### 데이터 연관",
  "",
  "#### S-0007 은 어떤 센서들로 계산되나?",
  "",
  "```sql",
  "SELECT expr FROM fdc_formula WHERE snsr_id = 'S-0007'",
  "```",
  "",
  "```sql",
  "SELECT src_snsr_id, arg_order FROM fdc_formula_input WHERE snsr_id = 'S-0007' ORDER BY arg_order",
  "```",
  "",
  "- 채점표: 수식과 입력 센서를 인자 순서대로 함께 말한다",
  "",
  "### 고도화 분석",
  "",
  "#### 가상 센서 값이 튀는 원인은 어느 입력 센서인가?",
  "",
  "- 보류",
  "",
].join("\n");
const withSet = `${skill.trimEnd()}\n\n${SET}`;
const sectionOf = (body) => `# s\n\n## 답변 품질 검증 Set\n\n${body}\n`;
const errs = (body) => parseVerifySet(sectionOf(body)).errors;

test("the section reads into settings and seven questions, one per ####, SQL answers verbatim", () => {
  const { present, settings, questions, errors } = parseVerifySet(withSet);
  assert.deepEqual(errors, []);
  assert.equal(present, true);
  assert.deepEqual(settings, { line: "L1", eqp: "EQP01", duration: { from: "2026-10-01T00:00", to: "2026-10-01T06:00" } });
  assert.deepEqual(countByKind(questions), { 1: 3, 2: 2, 3: 1, 4: 1 });
  const [first, , none, explain, , relate, deferred] = questions;
  assert.deepEqual(first.pieces, ["FDC_SENSOR"]);
  assert.equal(first.rubric, "다른 센서 값으로 수식을 계산해 얻는다");
  assert.equal(none.noKnowledge, true);
  assert.deepEqual(explain.sqls, ["SELECT snsr_id, eqp_id, snsr_kind, snsr_type_cd, unit_cd\n  FROM fdc_sensor WHERE snsr_id = 'S-0004'"]);
  assert.equal(relate.sqls.length, 2);
  assert.equal(relate.kind, 3);
  assert.equal(deferred.deferred, true);
});

test("a skill md without the section has no set", () => {
  const r = parseVerifySet(skill);
  assert.equal(r.present, false);
  assert.deepEqual(r.questions, []);
  assert.deepEqual(r.errors, []);
});

test("each kind takes its own fields and SQL blocks; a break names the line", () => {
  assert.match(errs("### 일반 지식\n\n#### q\n\n- 채점표: x")[0], /^7행 .*"정답" 칸이 있어야/);
  assert.match(errs("### 일반 지식\n\n#### q\n\n- 정답: A\n\n```sql\nSELECT 1\n```")[0], /SQL 을 쓰지 않습니다/);
  assert.match(errs("### 데이터 설명\n\n#### q\n\n- 채점표: x\n\n```sql\nSELECT 1\n```")[0], /칸 없이 ```sql 블록만/);
  assert.match(errs("### 데이터 설명\n\n#### q\n\n```sql\nSELECT 1\n```\n\n```sql\nSELECT 2\n```")[0], /꼭 하나 있어야 합니다 \(지금 2개\)/);
  assert.match(errs("### 데이터 설명\n\n#### q\n\n```sql\n\n```")[0], /SQL 블록이 비었습니다/);
  assert.match(errs("### 데이터 설명\n\n#### q\n\n```text\nSELECT 1\n```")[0], /```sql 입니다/);
  assert.match(errs("### 데이터 연관\n\n#### q\n\n- 채점표: x")[0], /하나 이상 있어야/);
  assert.match(errs("### 데이터 연관\n\n#### q\n\n```sql\nSELECT 1\n```")[0], /"채점표" 칸이 있어야/);
  assert.match(errs("### 고도화 분석\n\n#### q\n\n- 보류: 나중")[0], /값 없이 "- 보류"/);
  assert.match(errs("### 일반 지식\n\n#### q\n\n아무 글")[0], /"- 이름: 값" 줄/);
});

test("parts: 설정 and the four kinds, each once; a question is #### under a kind", () => {
  assert.deepEqual(errs("### 설정:\n\n- 라인: L1\n\n### 일반 지식?\n\n#### q\n\n- 정답: 없음"), []);
  assert.match(errs("### 데이터\n")[0], /### 는 설정 · 일반 지식/);
  assert.match(errs("### 일반 지식\n\n### 일반 지식")[0], /두 번/);
  assert.match(errs("### 설정\n\n#### q")[0], /종류\(### 일반 지식 …\) 아래에/);
  assert.match(errs("머리글")[0], /### 로 나눕니다/);
  assert.match(errs("### 일반 지식\n\n- 정답: A")[0], /"#### 질문"/);
  assert.match(errs("### 일반 지식\n\n##### q")[0], /#### 한 단계/);
  assert.match(errs("### 데이터 설명\n\n#### q\n\n```sql\nSELECT 1")[0], /펜스가 닫히지 않았습니다/);
});

test("settings: 라인 · 설비 · 기간, the period start ~ end in minutes, start before end", () => {
  assert.match(errs("### 설정\n\n- 레시피: R")[0], /라인 · 설비 · 기간/);
  assert.match(errs("### 설정\n\n- 기간: 2026-10-01 ~ 2026-10-02")[0], /시작 ~ 끝/);
  assert.match(errs("### 설정\n\n- 기간: 2026-10-01T06:00 ~ 2026-10-01T00:00")[0], /끝이 시작보다 뒤/);
});

test("knowledge paths follow the consumer's piece ids: headings with text, ancestors joined by ' / '", () => {
  assert.deepEqual(knowledgePaths(withSet), ["FDC_SENSOR", "답하지 않는 것", "답의 예"]);
  const md = "## 도메인 지식\n\n머리\n\n### DB\n\n#### SPEC_INFO\n\n본문\n\n#### 빈 것\n\n### 끝\n\n글\n\n## 데이터\n\n### x — y\n";
  assert.deepEqual(knowledgePaths(md), ["도메인 지식", "DB / SPEC_INFO", "끝"]);
});

test("an unknown 정답 path and data questions with nowhere to run are warnings, not errors", () => {
  assert.deepEqual(checkVerifySet(withSet), { present: true, errors: [], warnings: [] });
  const md = `${skill.trimEnd()}\n\n## 답변 품질 검증 Set\n\n### 일반 지식\n\n#### q\n\n- 정답: 옛 제목\n\n### 데이터 설명\n\n#### r\n\n\`\`\`sql\nSELECT 1\n\`\`\`\n`;
  const { errors, warnings } = checkVerifySet(md);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /#### q": ## 도메인 지식 에 없는 정답 경로입니다 — 옛 제목/);
  assert.match(warnings[1], /데이터 질문 1개를 돌릴 수 없습니다/);
});

test("the template is the five parts and no question — valid as it is", () => {
  const body = verifySetTemplate();
  assert.equal(body, "### 설정\n\n### 일반 지식\n\n### 데이터 설명\n\n### 데이터 연관\n\n### 고도화 분석");
  const r = parseVerifySet(sectionOf(body));
  assert.deepEqual([r.present, r.questions, r.errors], [true, [], []]);
});

test("the section editor splits and joins a skill md with the set, the set last", () => {
  const { title, sections } = splitSkill(withSet);
  assert.equal(sections.at(-1).key, "답변 품질 검증 Set");
  assert.equal(joinSkill(title, sections), withSet.trimEnd() + "\n");
});
