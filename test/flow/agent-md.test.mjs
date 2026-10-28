// BE CheckFlowTest · QueryFlowToolTest · SkillMarkdownToolTest's refusals on
// BE's own test mds (test/fixtures/flow, copied from fdc-agent-be-spring
// src/test/resources), and the claude-hooks fdc-flowchart skill's samples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFiles, flowRejections, readAgentMd, saveCheck, INPUT_HINT } from "../../src/flow/agent-md.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "flow");
const file = (rel) => ({ path: rel.split("/").pop(), text: readFileSync(join(FIXTURES, rel), "utf8") });
const md = (path, fence, data) => ({ path, text: `# 제목\n\n## 데이터\n\n\`\`\`mermaid\n${fence}\n\`\`\`\n\n${data}` });
const PARAM_LIST = "### param_list — 파라미터 목록\n\n```sql\nselect param_index, param_type from PARAM_INFO where eqp_id = :eqp_id\n```\n";

test("BE 테스트 md 는 BE 처럼 모두 통과한다", () => {
  const sets = [
    ["subgraph/param-interlock.md", "subgraph/param-spec.md", "subgraph/state-gate.md"],
    ["split-md/interlock-history.md", "split-md/param-pick.md"],
    ["flow-inputs/interlock-param.md"],
    ["eqp-duration/interlock-duration.md"],
    ["skills/eqp-scope.md", "skills/example_skill.md"],
    ["akg/fdc-explain-sensor-origin.md"],
  ];
  for (const set of sets) {
    const r = checkFiles(set.map(file));
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.deepEqual(r.lines, set.map((p) => `OK ${p.split("/").pop()}`));
  }
});

test("문법 오류는 md 파일의 줄로 낸다", () => {
  const r = checkFiles([md("bad.md", "flowchart TD\n  eqp-scope[[설비]] --> param_list\n  a --> b --> c", PARAM_LIST)]);
  assert.equal(r.ok, false);
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].startsWith("bad.md:8 CHAIN `a --> b --> c`"), r.lines[0]);
});

test("md 를 가로지르는 오류는 펜스 여는 줄로 내고 가리킨 md 가 없으면 UNKNOWN_ID 다", () => {
  const alone = checkFiles([file("subgraph/param-spec.md")]);
  assert.equal(alone.ok, false);
  assert.ok(alone.lines[0].startsWith("param-spec.md:13 UNKNOWN_ID 흐름 노드 param_pick"), alone.lines[0]);
  assert.ok(!alone.lines.some((l) => l.startsWith("OK ")));

  const column = checkFiles([
    md(
      "col.md",
      "flowchart TD\n  eqp-scope[[설비]] --> param_list\n  param_list -->|\"no_such in ('A', 'B')\"| param_list2\n  eqp-scope --> param_list2",
      `${PARAM_LIST}\n### param_list2 — 둘\n\n\`\`\`sql\nselect x from T where eqp_id = :eqp_id\n\`\`\`\n`,
    ),
  ]);
  assert.equal(column.lines.length, 1);
  assert.ok(column.lines[0].startsWith("col.md:5 CONDITION_COLUMN"), column.lines[0]);
});

test("펜스 밖 md 오류는 MD 로 낸다", () => {
  const r = checkFiles([{ path: "nofence.md", text: "# 제목\n\n## 데이터\n\n### q — 조회\n\n```sql\nselect a from T where b = :b\n```\n" }]);
  assert.equal(r.ok, false);
  assert.equal(r.lines.length, 1);
  assert.ok(r.lines[0].startsWith("nofence.md:1 MD "), r.lines[0]);
});

// ---- QueryFlowToolTest: the load's refusals over registered mds
const interlock = (lines) =>
  readAgentMd(
    "interlock",
    `# 인터락\n## 데이터\n\`\`\`mermaid\nflowchart TD\neqp_id([설비])\nspec_index([Spec 번호])\neqp_id --> interlock_history\n${lines}\n\`\`\`\n### interlock_history — 인터락 발생 내역\n\`\`\`sql\nselect act_time, param_type, spec_index from interlock_data where eqp_id = :eqp_id\n\`\`\`\n### spec_by_index — Spec\n\`\`\`sql\nselect spec_index, limit_count from spec_info where spec_index = :spec_index\n\`\`\`\n`,
  );
const other = (name, lines) =>
  readAgentMd(
    name,
    `# ${name}\n## 데이터\n\`\`\`mermaid\nflowchart TD\nspec_index([Spec 번호])\nspec_index --> ${name}_detail\n${lines}\n\`\`\`\n### ${name}_detail — 상세\n\`\`\`sql\nselect spec_index, detail from spec_detail where spec_index = :spec_index\n\`\`\`\n`,
  );
const kept = (...specs) => {
  const out = flowRejections(specs);
  return specs.filter((s) => !out.has(s.name)).map((s) => s.name);
};
const rejected = (spec, ...others) => !kept(spec, ...others).includes(spec.name);

test("검사를 통과한 흐름은 그대로다 · 모르는 id · 출처 없는 var · 조건 컬럼 · 순환 · else 둘은 거부한다", () => {
  for (const s of [interlock("interlock_history -->|param_type = 'E'| spec_by_index"), interlock("interlock_history --> spec_by_index")])
    assert.equal(s.rejection, null);
  assert.equal(rejected(interlock("interlock_history -->|param_type = 'E'| spec_by_index")), false);
  assert.equal(rejected(interlock("interlock_history --> nowhere\nspec_index --> spec_by_index")), true);
  assert.equal(rejected(interlock("")), true);
  assert.equal(rejected(interlock("spec_index -.-> spec_by_index")), false);
  assert.equal(rejected(interlock("interlock_history -->|no_such = 'E'| spec_by_index")), true);
  assert.equal(rejected(interlock("interlock_history -->|PARAM_TYPE = 'E'| spec_by_index")), false);
  assert.equal(rejected(interlock("interlock_history -->|else| spec_by_index")), false);
  assert.equal(rejected(interlock("interlock_history --> spec_by_index\nspec_by_index --> interlock_history")), true);
  assert.equal(rejected(interlock("interlock_history -->|else| spec_by_index\ninterlock_history -->|else| spec_by_index")), true);
});

test("풀에만 있는 조회는 참조로 받고, 흐름 노드는 대괄호 둘로 적은 등재된 md 이름이다", () => {
  const lib = other("lib", "");
  assert.equal(rejected(interlock("interlock_history --> spec_by_index\ninterlock_history --> lib_detail"), lib), false);
  const explain = other("spec_explain", "");
  const ok = "interlock_history --> spec_by_index\nspec_explain[[Spec 설명]]\ninterlock_history -->|param_type = 'E'| spec_explain";
  assert.equal(rejected(interlock(ok), explain), false);
  assert.equal(rejected(interlock(ok.replace("spec_explain[[Spec 설명]]\n", "")), explain), true);
  const sensor = readAgentMd("fdc-explain-sensor-origin", "# 센서 출처\n## 한 줄 설명\n센서 출처.\n");
  assert.equal(
    rejected(interlock("interlock_history --> spec_by_index\nfdc-explain-sensor-origin[[센서 출처]]\ninterlock_history -->|param_type = 'E'| fdc-explain-sensor-origin"), sensor),
    false,
  );
});

test("md 를 가로지르는 순환은 양쪽 다 거부하고, 거부한 md 를 가리키던 md 도 다시 검사해 거부한다", () => {
  const a = interlock("interlock_history --> spec_by_index\nback[[저쪽]]\ninterlock_history --> back");
  const back = other("back", "interlock[[이쪽]]\nback_detail --> interlock");
  assert.deepEqual(kept(a, back), []);
  const bad = other("lib", "lib_detail --> nowhere");
  const user = interlock("interlock_history --> spec_by_index\nlib[[라이브러리]]\ninterlock_history --> lib");
  assert.deepEqual(kept(user, bad, other("fine", "")), ["fine"]);
});

// ---- SkillMarkdownToolTest: what BE refuses when it reads the md
const reason = (markdown) => readAgentMd("x", markdown).rejection;

test("ask 펜스 항목과 펜스 없는 항목은 거부하고 입력은 흐름 펜스에 적으라고 알린다", () => {
  assert.equal(reason("## 데이터\n### operator — 담당자\n```ask\n이 설비 담당자 이름을 적어 주세요.\n```\n"), `x needs[operator]: ask 펜스는 쓰지 않는다 — ${INPUT_HINT}`);
  assert.equal(reason("## 데이터\n### root_cause — 원인\n이 인터락이 왜 났는지는 데이터에 없다. 사용자에게 묻는다.\n"), `x needs[root_cause]: sql 펜스가 없다 — ${INPUT_HINT}`);
});

test("묶음 표시 골뱅이가 남은 md 는 거부한다", () => {
  assert.equal(
    reason("## 데이터\n### param_list — 파라미터 목록 @param\n```sql\nselect param_index from PARAM_INFO\n```\n"),
    `x: 항목 \`param_list — 파라미터 목록 @param\` 의 묶음 표시 @param 는 쓰지 않는다 — ${INPUT_HINT}`,
  );
});

test("바인드를 쓰는 조회가 있는데 흐름 펜스가 없으면 거부하고, 바인드 없는 조회만 있으면 펜스가 없어도 된다", () => {
  assert.equal(
    reason("## 데이터\n### spec_info — Spec\n```sql\nselect spec_index from spec_index where spec_index = :spec_index\n```\n"),
    `x needs[spec_info]: :spec_index 를 채울 입력을 적은 펜스가 없다 — ${INPUT_HINT}`,
  );
  const plain = readAgentMd("x", "## 데이터\n### a — 에이\n```sql\nselect a from t\n```\n");
  assert.equal(plain.rejection, null);
  assert.equal(plain.flow.isEmpty(), true);
  assert.deepEqual(plain.queries.map((q) => q.id), ["a"]);
});

test("펜스 언어가 sql 이 아니면 · 한글 제목에 id 가 없으면 거절하고, ascii 제목은 id 를 생략할 수 있다", () => {
  assert.match(reason("## 데이터\n### a — 에이\n```\nselect a from t\n```\n"), /펜스 언어는 sql 입니다/);
  assert.match(reason("## 데이터\n### param 정보\n```sql\nselect a from t\n```\n"), /id 가 없습니다.*### id — param 정보/);
  assert.deepEqual(readAgentMd("x", "## 데이터\n### Spec Info\n```sql\nselect a from t\n```\n").queries.map((q) => [q.id, q.title]), [["spec_info", "Spec Info"]]);
});

test("흐름 문법 오류는 코드와 줄을 담아 md 를 거부하고, mermaid 펜스가 둘이면 거부한다", () => {
  const base = (fence) => `## 데이터\n\`\`\`mermaid\n${fence}\n\`\`\`\n### interlock_events — 인터락\n\`\`\`sql\nselect act_time from INTERLOCK_DATA\n\`\`\`\n### spec_info — Spec\n\`\`\`sql\nselect a from t\n\`\`\`\n`;
  const bad = {
    "flowchart TD\ninterlock_events --> spec_info --> param_info": "2 번째 줄 CHAIN",
    "flowchart TD\ninterlock_events --> spec_info & param_info": "2 번째 줄 AMPERSAND",
    "flowchart TD\nsubgraph g\ninterlock_events --> spec_info\nend": "2 번째 줄 SUBGRAPH_TITLE",
    "flowchart TD\ninterlock_events -->|param_type > 'E'| spec_info": "2 번째 줄 CONDITION_SYNTAX",
    "graph TD\ninterlock_events --> spec_info": "1 번째 줄 HEADER",
  };
  for (const [fence, why] of Object.entries(bad)) {
    const r = readAgentMd("example_skill", base(fence));
    assert.ok(r.rejection.startsWith("example_skill: 조회 흐름 오류로 거부 — "), r.rejection);
    assert.ok(r.rejection.includes(why), `${fence}: ${r.rejection}`);
    assert.equal(r.flowErrors[0].code, why.split(" ").pop());
  }
  const fence = "```mermaid\nflowchart TD\ninterlock_events --> spec_info\n```\n";
  assert.equal(
    readAgentMd("example_skill", `## 데이터\n${fence}${fence}### a — 에이\n\`\`\`sql\nselect a from t\n\`\`\`\n`).rejection,
    "example_skill: 조회 흐름 오류로 거부 — mermaid 펜스는 하나다, 2 개다",
  );
});

test("플로우 펜스는 데이터 절 첫 ### 앞의 mermaid 펜스이고 그 줄을 안다", () => {
  const r = readAgentMd("x", file("subgraph/param-interlock.md").text);
  assert.equal(r.fence.line, 13);
  assert.deepEqual(r.flow.subgraphIds(), ["param_pick"]);
  assert.deepEqual(r.queries.map((q) => [q.id, q.vars]), [
    ["param_list", ["eqp_id"]],
    ["interlock_history", ["eqp_id", "param_index", "start_time", "end_time"]],
  ]);
});

// ---- the fdc-flowchart skill's samples (claude-hooks skills/fdc-flowchart/SKILL.md §9)
const PICK_ONE = `# 파라미터 인터락

## 데이터

\`\`\`mermaid
flowchart TD
  subgraph param_pick [파라미터 고르기]
    eqp-scope[[설비 범위]]
    param_list[파라미터 목록]
    eqp-scope --> param_list
  end
  param_index([파라미터 번호])
  interlock_history[인터락 이력]
  param_pick --> interlock_history
  param_index --> interlock_history
\`\`\`

### param_list — 파라미터 목록

\`\`\`sql
select param_index, param_name from PARAM_INFO where eqp_id = :eqp_id
\`\`\`

### interlock_history — 인터락 이력

\`\`\`sql
select act_time, interlock_id from INTERLOCK_HIST where eqp_id = :eqp_id and param_index = :param_index and act_time between :start_time and :end_time
\`\`\`
`;
const HOLD = `# 홀드

## 데이터

\`\`\`mermaid
flowchart TD
  eqp-scope[[설비 범위]] --> interlock_list[인터락 목록]
  interlock_list -->|"interlock_type in ('HOLD', 'STOP')"| hold_detail[홀드 상세]
  eqp-scope --> hold_detail
\`\`\`

### interlock_list — 인터락 목록

\`\`\`sql
select interlock_id, interlock_type, act_time from INTERLOCK_HIST where eqp_id = :eqp_id and act_time between :start_time and :end_time
\`\`\`

### hold_detail — 홀드 상세

\`\`\`sql
select interlock_id, hold_reason from HOLD_DETAIL where eqp_id = :eqp_id and interlock_id = :interlock_id
\`\`\`
`;

test("fdc-flowchart 좋은 표본 셋은 통과한다", () => {
  const r = checkFiles([
    { path: "interlock-pick.md", text: PICK_ONE },
    { path: "hold.md", text: HOLD },
    file("split-md/param-pick.md"),
    file("split-md/interlock-history.md"),
  ]);
  assert.deepEqual(r.lines, ["OK interlock-pick.md", "OK hold.md", "OK param-pick.md", "OK interlock-history.md"]);
});

test("fdc-flowchart 흔한 실수는 스킬이 적은 코드를 낸다", () => {
  const codes = (text) => checkFiles([{ path: "bad.md", text }]).lines.map((l) => l.split(" ")[1]);
  const shape = PICK_ONE.replace("  param_index --> interlock_history", "  param_index[파라미터 번호] --> interlock_history");
  assert.deepEqual(codes(shape), ["SHAPE_CONFLICT"]);
  assert.match(checkFiles([{ path: "bad.md", text: shape }]).lines[0], /노드 param_index 의 모양이 둘이다 — \d+ 번째 줄은 입력 id\(\[글\]\), 이 줄은 조회 id\[글\]/);
  assert.deepEqual(codes(PICK_ONE.replace("  param_index --> interlock_history", "  param_list --> param_index\n  param_index --> interlock_history")), ["EDGE_KIND"]);
  const pick = readFileSync(join(FIXTURES, "split-md/param-pick.md"), "utf8");
  const unknown = checkFiles([{ path: "unknown-bad.md", text: pick.replace("eqp-scope[[설비 · 기간]]", "eqp-scope[설비 범위]") }]).lines;
  assert.deepEqual(unknown, [
    "unknown-bad.md:9 UNKNOWN_ID 노드 eqp-scope: 조회가 아니다 — md 를 흐름 노드로 쓰려면 `eqp-scope[[글]]` 로 적는다",
    "unknown-bad.md:9 UNSOURCED_VAR param_list 의 :eqp_id 를 채울 입력이 없다",
  ]);
  const lot = "# 로트\n\n## 데이터\n\n```mermaid\nflowchart TD\n  eqp-scope[[설비 범위]]\n  lot_history[로트 이력]\n  eqp-scope --> lot_history\n```\n\n### lot_history — 로트 이력\n\n```sql\nselect lot_id, step_id from LOT_HIST where eqp_id = :eqp_id and lot_id = :lot_id\n```\n";
  assert.match(checkFiles([{ path: "lot.md", text: lot }]).lines[0], /UNSOURCED_VAR lot_history 의 :lot_id 를 채울 입력이 없다$/);
  assert.deepEqual(checkFiles([{ path: "lot.md", text: lot.replace("  eqp-scope --> lot_history", "  lot_id([로트 번호])\n  eqp-scope --> lot_history\n  lot_id --> lot_history") }]).lines, ["OK lot.md"]);
  assert.deepEqual(codes(PICK_ONE.replace("param_index([파라미터 번호])", "param_index([파라미터 번호(숫자)])")), ["NODE_SYNTAX"]);
  assert.deepEqual(checkFiles([{ path: "p.md", text: PICK_ONE.replace("param_index([파라미터 번호])", "param_index([파라미터 번호（숫자）])") }]).lines, ["OK p.md"]);
});

// ---- a save against the store's registered mds
const doc = (id, markdown, type = "domain-skill") => ({ type, id, markdown });

test("저장 검사: 자기 오류를 내고, 저장으로 깨지는 다른 md 를 알린다", () => {
  const owner = doc("param-interlock", file("subgraph/param-interlock.md").text);
  const spec = doc("param-spec", file("subgraph/param-spec.md").text);
  const scope = doc("eqp-scope", file("skills/eqp-scope.md").text);
  const registry = [scope, owner, spec];

  assert.deepEqual(saveCheck(registry, { ...spec, active: true }), { errors: [], fenceLine: 13, broken: [] });

  // the owner drops its subgraph: param-spec, which points at it, breaks
  const flat = owner.markdown
    .replace("  subgraph param_pick [파라미터 고르기]\n", "")
    .replace("  end\n", "")
    .replace("  param_pick --> interlock_history", "  eqp-scope --> interlock_history");
  const r = saveCheck(registry, { ...owner, markdown: flat, active: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.broken.map((b) => b.md), ["param-spec"]);
  assert.equal(r.broken[0].errors[0].code, "UNKNOWN_ID");

  // the same when it leaves the registry (deactivated, deleted)
  assert.deepEqual(saveCheck(registry, { ...owner, markdown: null, active: false }).broken.map((b) => b.md), ["param-spec"]);

  // a new md pointing at nothing registered is refused
  const lone = saveCheck([scope], { ...spec, active: true });
  assert.deepEqual(lone.errors.map((e) => e.code), ["UNKNOWN_ID", "UNSOURCED_VAR"]);
  assert.deepEqual(lone.broken, []);
});
