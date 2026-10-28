// BE FlowRulesTest and FlowSubgraphRulesTest, the same facts and the same codes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { QueryFlow, compile } from "../../src/flow/flow-compiler.mjs";
import { check, conditionColumns, cycle, edgeKinds, elses, facts, md, mdCycle, nodes, sources } from "../../src/flow/flow-rules.mjs";

function parse(fence) {
  const { flow, errors } = compile(fence);
  assert.deepEqual(errors, [], fence);
  return flow;
}
const flow = (body) => parse(`flowchart TD\n${body}`);
const pool = (...list) => new Map(list.map((q) => [q.id, q]));
const q = (id, vars, columns) => ({ id, vars, columns });
const codesOf = (errors) => errors.map((e) => e.code);

// The interlock md's queries — parameter list · interlock history · Spec.
const POOL = pool(
  q("param_list", ["eqp_id", "param_name", "param_index"], ["param_index", "param_name", "unit"]),
  q("interlock_history", ["eqp_id", "param_index", "start_time", "end_time"], ["act_time", "interlock_type", "spec_index"]),
  q("spec_doc", ["spec_index"], ["spec_index", "doc"]),
  q("eqp_by_line", ["line"], ["eqp_id"]),
  q("star", [], null),
);
const EQP_SCOPE = md("eqp-scope", flow("line([라인])\neqp_id([설비])\nduration([기간])"), []);
const SPEC_EXPLAIN = md("spec-explain", flow("spec_index([Spec 번호])\nspec_index --> spec_doc"), ["spec_doc"]);
const OWN = ["param_list", "interlock_history"];

function factsOf(own, ...mds) {
  const all = new Map([["interlock", md("interlock", own, OWN)]]);
  for (const m of mds) all.set(m.name, m);
  return facts("interlock", OWN, POOL, all);
}
function checkBody(body, ...mds) {
  const own = flow(body);
  return check(own, factsOf(own, ...mds));
}

// The final grammar example: the common md leads, two optional inputs, one conditioned flow node.
const GOOD = `eqp-scope[[설비 범위]]
param_name([파라미터 이름])
param_index([파라미터 번호])
param_list[파라미터 목록]
interlock_history[인터락 발생 내역]
spec-explain[[Spec 설명]]
eqp-scope --> param_list
param_name -.-> param_list
param_index -.-> param_list
param_list --> interlock_history
eqp-scope --> interlock_history
interlock_history -->|interlock_type = 'HOLD'| spec-explain
`;

test("모양 셋과 선택 입력과 공통 md 로 적은 흐름은 오류가 없다", () => {
  assert.deepEqual(checkBody(GOOD, EQP_SCOPE, SPEC_EXPLAIN), []);
});

test("공통 md 가 입력 셋을 주면 eqp_id 와 기간 쌍이 흘러든다", () => {
  const without = checkBody(GOOD.replace("eqp-scope --> interlock_history\n", ""), EQP_SCOPE, SPEC_EXPLAIN);
  assert.deepEqual(without.map((e) => [e.code, e.message]), [
    ["UNSOURCED_VAR", "interlock_history 의 :eqp_id 를 채울 입력이 없다"],
    ["UNSOURCED_VAR", "interlock_history 의 :start_time 를 채울 입력이 없다"],
    ["UNSOURCED_VAR", "interlock_history 의 :end_time 를 채울 입력이 없다"],
  ]);
});

test("기간 입력 하나가 시작 끝 둘을 채운다", () => {
  assert.deepEqual(codesOf(checkBody(`eqp_id([설비])
duration([기간])
param_index([번호])
eqp_id --> interlock_history
duration --> interlock_history
param_index --> interlock_history
eqp_id --> param_list
param_index -.-> param_list
param_name([이름])
param_name -.-> param_list`)), []);
});

test("공통 md 의 끝 조회 출력도 이름으로 흘러든다", () => {
  const byLine = md("eqp-by-line", flow("line([라인])\nline --> eqp_by_line"), ["eqp_by_line"]);
  assert.deepEqual(codesOf(checkBody(`eqp-by-line[[라인의 설비]]
eqp-by-line --> param_list
param_name([이름])
param_index([번호])
param_name -.-> param_list
param_index -.-> param_list
eqp_id([설비])
duration([기간])
eqp_id --> interlock_history
duration --> interlock_history
param_index --> interlock_history`, byLine)), []);
});

test("var 를 채울 곳이 없으면 조회와 이름을 적는다", () => {
  const messages = checkBody("eqp_id([설비])\neqp_id --> param_list\nparam_name([이름])\nparam_name --> param_list").map((e) => e.message);
  assert.ok(messages.includes("param_list 의 :param_index 를 채울 입력이 없다"), messages.join("\n"));
});

test("caller 조회의 출력 컬럼이 var 를 채운다", () => {
  assert.deepEqual(codesOf(checkBody(`eqp_id([설비])
duration([기간])
param_name([이름])
param_index([번호])
eqp_id --> param_list
param_name -.-> param_list
param_index -.-> param_list
eqp_id --> interlock_history
duration --> interlock_history
param_list --> interlock_history`)), []);
});

test("설비 바인드를 caller 조회의 출력으로만 채우면 설비 간 흐름이라 아직 받지 않는다", () => {
  const p = new Map(POOL).set("eqp_list", q("eqp_list", [], ["eqp_id"]));
  const own = flow("eqp_list --> param_list\nparam_name([이름])\nparam_index([번호])\nparam_name --> param_list\nparam_index --> param_list");
  const f = facts("interlock", ["param_list"], p, new Map([["interlock", md("interlock", own, ["param_list"])]]));
  assert.deepEqual(codesOf(sources(own, f)), ["UNSUPPORTED_EQP_FLOW"]);
});

test("입력 id 가 SQL 항목 id 와 겹치면 오류다", () => {
  assert.deepEqual(codesOf(nodes(flow("spec_doc([글])"), factsOf(QueryFlow.EMPTY))), ["INPUT_IS_QUERY"]);
});

test("흐름 노드를 이름만 쓰면 모르는 id 이고 대괄호 둘을 권한다", () => {
  assert.deepEqual(nodes(flow("param_list --> spec-explain"), factsOf(QueryFlow.EMPTY, SPEC_EXPLAIN)), [
    { line: 0, code: "UNKNOWN_ID", message: "노드 spec-explain: 조회가 아니다 — md 를 흐름 노드로 쓰려면 `spec-explain[[글]]` 로 적는다" },
  ]);
});

test("등재되지 않은 id 와 md 는 모르는 id 다", () => {
  assert.deepEqual(codesOf(nodes(flow("nowhere\nghost-md[[유령]]"), factsOf(QueryFlow.EMPTY))), ["UNKNOWN_ID", "UNKNOWN_ID"]);
});

test("자기 md 를 흐름 노드로 쓰면 오류다", () => {
  assert.deepEqual(codesOf(nodes(flow("interlock[[나]]"), factsOf(QueryFlow.EMPTY))), ["SELF_FLOW"]);
});

test("조회 id 와 md 이름이 겹치면 오류다", () => {
  assert.deepEqual(codesOf(nodes(flow("spec_doc"), factsOf(QueryFlow.EMPTY, md("spec_doc")))), ["QUERY_IS_MD"]);
});

test("허용되지 않는 간선 조합은 오류다", () => {
  assert.deepEqual(codesOf(edgeKinds(flow("a([입력])\nq --> a"))), ["EDGE_KIND"]);
  assert.deepEqual(codesOf(edgeKinds(flow("a([입력])\nm[[흐름]]\na --> m"))), ["EDGE_KIND"]);
  assert.deepEqual(codesOf(edgeKinds(flow("m[[흐름]]\nn[[흐름]]\nm --> n"))), ["EDGE_KIND"]);
  assert.deepEqual(codesOf(edgeKinds(flow("a([x])\nb([y])\na --> b"))), ["EDGE_KIND"]);
  assert.deepEqual(codesOf(edgeKinds(flow("a([입력])\nm[[흐름]]\nq\na --> q\nm --> q\nq --> r\nq --> m"))), []);
});

test("점 간선은 입력에서 조회로만 쓴다", () => {
  assert.deepEqual(codesOf(edgeKinds(flow("q -.-> r"))), ["OPTIONAL_EDGE"]);
  assert.deepEqual(codesOf(edgeKinds(flow("m[[흐름]]\nm -.-> r"))), ["OPTIONAL_EDGE"]);
  assert.deepEqual(codesOf(edgeKinds(flow("a([입력])\na -.-> r"))), []);
});

test("조건 라벨은 조회 caller 의 간선에만 쓴다", () => {
  assert.deepEqual(codesOf(edgeKinds(flow("a([입력])\na -->|x = '1'| r"))), ["CONDITION_PLACE"]);
  assert.deepEqual(codesOf(edgeKinds(flow("m[[흐름]]\nm -->|else| r"))), ["CONDITION_PLACE"]);
});

test("간선에 쓰지 않은 흐름 노드는 오류다", () => {
  assert.deepEqual(codesOf(edgeKinds(flow("m[[흐름]]"))), ["FLOW_ALONE"]);
});

test("caller 마다 else 는 하나까지다", () => {
  assert.deepEqual(elses(flow("a -->|else| b\na -->|else| c")).map((e) => e.message), ["간선 a -->|else| c: a 의 else 는 하나까지다"]);
  assert.deepEqual(elses(flow("a -->|else| b\nc -->|else| b")), []);
});

test("조건 컬럼은 caller 조회의 출력에 있어야 하고 읽지 못한 문장은 건너뛴다", () => {
  const f = factsOf(QueryFlow.EMPTY);
  assert.deepEqual(codesOf(conditionColumns(flow("param_list -->|nope = '1'| interlock_history"), f)), ["CONDITION_COLUMN"]);
  assert.deepEqual(conditionColumns(flow("param_list -->|UNIT = '1'| interlock_history"), f), []);
  assert.deepEqual(conditionColumns(flow("star -->|any = '1'| interlock_history"), f), []);
});

test("순환은 오류다", () => {
  assert.deepEqual(cycle(flow("a --> b\nb --> c\nc --> a")).map((e) => e.message), ["순환 a --> b --> c --> a"]);
  assert.deepEqual(codesOf(cycle(flow("a --> a"))), ["CYCLE"]);
});

test("md 를 가로지르는 순환은 오류다", () => {
  const back = md("back", flow("interlock[[되돌아감]]\nspec_doc --> interlock"), ["spec_doc"]);
  const own = flow("back[[저쪽]]\ninterlock_history --> back");
  assert.deepEqual(mdCycle(own, factsOf(own, back)).map((e) => e.message), ["md 를 가로지르는 순환 interlock → back → interlock"]);
});

test("얹은 md 가 caller 로 되돌아오는 조회 순환도 오류다", () => {
  const loop = md("loop", flow("spec_doc --> interlock_history"), ["spec_doc"]);
  const own = flow("loop[[루프]]\ninterlock_history --> loop");
  assert.deepEqual(codesOf(mdCycle(own, factsOf(own, loop))), ["MD_CYCLE"]);
});

// ---- FlowSubgraphRulesTest
const PICK = `flowchart TD
  subgraph param_pick [파라미터 고르기]
    eqp-scope[[설비 · 기간]]
    param_list[파라미터 목록]
    eqp-scope --> param_list
  end
  param_index([파라미터 번호])
  interlock_history[인터락 이력]
  param_pick --> interlock_history
  param_index --> interlock_history
`;
const SUB_POOL = pool(
  q("param_list", ["eqp_id"], ["param_index", "param_name"]),
  q("interlock_history", ["eqp_id", "param_index", "start_time", "end_time"], ["act_time"]),
  q("spec_by_param", ["eqp_id", "param_index"], ["spec_low"]),
  q("eqp_state", ["eqp_id"], ["state"]),
  q("alarm_list", ["eqp_id", "state"], ["alarm_id"]),
);
const SUB_EQP_SCOPE = md("eqp-scope", parse("flowchart TD\nline([라인])\neqp_id([설비])\nduration([기간])"), []);
const codes = (fence) => compile(fence).errors.map((e) => e.code);

/** md name → fence; the first md is checked. */
function subCheck(fences, queries) {
  const mds = new Map([[SUB_EQP_SCOPE.name, SUB_EQP_SCOPE]]);
  for (const [name, fence] of Object.entries(fences)) mds.set(name, md(name, parse(fence), queries[name] ?? []));
  const self = Object.keys(fences)[0];
  return check(mds.get(self).flow, facts(self, queries[self] ?? [], SUB_POOL, mds));
}

test("subgraph 는 흐름 노드 하나가 되고 안의 노드가 그 subgraph 에 든다", () => {
  const f = parse(PICK);
  assert.deepEqual(f.nodes, [
    { id: "param_pick", kind: "flow", title: "파라미터 고르기", subgraph: null },
    { id: "eqp-scope", kind: "flow", title: "설비 · 기간", subgraph: "param_pick" },
    { id: "param_list", kind: "query", title: "파라미터 목록", subgraph: "param_pick" },
    { id: "param_index", kind: "input", title: "파라미터 번호", subgraph: null },
    { id: "interlock_history", kind: "query", title: "인터락 이력", subgraph: null },
  ]);
  assert.deepEqual(f.subgraphIds(), ["param_pick"]);
  assert.deepEqual(f.subgraph("param_pick").ids(), ["eqp-scope", "param_list"]);
  assert.equal(f.subgraph("param_pick").edges.length, 1);
  assert.deepEqual(f.leading(), ["param_pick", "eqp-scope"]);
});

test("간선으로 처음 나온 노드도 그 subgraph 에 든다", () => {
  const f = parse("flowchart TD\n  subgraph g [묶음]\n    a --> b\n  end\n  b --> c\n");
  assert.deepEqual(f.subgraph("g").ids(), ["a", "b"]);
  assert.equal(f.node("c").subgraph, null);
});

test("subgraph 줄의 꼴 글 닫기 중첩을 본다", () => {
  assert.deepEqual(codes("flowchart TD\nsubgraph param-pick [고르기]\na\nend"), ["SUBGRAPH_ID"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph Pick [고르기]\na\nend"), ["SUBGRAPH_ID"]);
  assert.deepEqual(codes('flowchart TD\nsubgraph "고르기"\na\nend'), ["SUBGRAPH_ID"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph pick\na\nend"), ["SUBGRAPH_TITLE"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph pick [ ]\na\nend"), ["SUBGRAPH_TITLE"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph pick [고르기]\na"), ["SUBGRAPH_UNCLOSED"]);
  assert.deepEqual(codes("flowchart TD\na\nend"), ["SUBGRAPH_END"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph pick [고르기]\na\nsubgraph inner [안]\nb\nend\nend"), ["SUBGRAPH_NESTED"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph pick [고르기]\nend"), ["SUBGRAPH_EMPTY"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph end [고르기]\na\nend"), ["RESERVED_WORD"]);
});

test("틀린 subgraph 여는 줄도 짝 end 를 받는다 — 오류는 여는 줄 하나다", () => {
  assert.deepEqual(compile("flowchart TD\nsubgraph param-pick [고르기]\na\nend").errors.map((e) => [e.line, e.code]), [[2, "SUBGRAPH_ID"]]);
  assert.deepEqual(codes("flowchart TD\nsubgraph bad-id [틀림]\na\nend\nend"), ["SUBGRAPH_ID", "SUBGRAPH_END"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph bad-id [틀림]\nsubgraph g [묶음]\na\nend\nend\nb"), ["SUBGRAPH_ID"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph g [묶음]\na\nsubgraph bad-id [틀림]\nb\nend\nend"), ["SUBGRAPH_ID"]);
});

test("한 노드는 한 subgraph 에 든다", () => {
  const sorted = (x) => [...x].sort();
  assert.deepEqual(sorted(codes("flowchart TD\n  subgraph g [하나]\n    a[가]\n  end\n  subgraph h [둘]\n    a[가]\n  end\n")), ["SUBGRAPH_EMPTY", "SUBGRAPH_MEMBER"]);
  assert.deepEqual(sorted(codes("flowchart TD\n  a --> b\n  subgraph g [하나]\n    a[가]\n  end\n")), ["SUBGRAPH_EMPTY", "SUBGRAPH_MEMBER"]);
});

test("subgraph id 가 같은 md 의 id 와 겹치면 오류다", () => {
  assert.deepEqual(codes("flowchart TD\nsubgraph g [하나]\na\nend\nsubgraph g [둘]\nb\nend"), ["SUBGRAPH_ID_CLASH"]);
  assert.deepEqual(codes("flowchart TD\ng([입력])\nsubgraph g [하나]\na\nend"), ["SUBGRAPH_ID_CLASH"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph g [하나]\na\nend\ng[조회]"), ["SUBGRAPH_ID_CLASH"]);
  assert.deepEqual(codes("flowchart TD\nsubgraph g [하나]\ng[[나]]\na\nend"), ["SELF_FLOW"]);
});

test("subgraph id 가 등재된 조회 id md 이름과 겹치면 오류다", () => {
  assert.ok(codesOf(subCheck({ own: "flowchart TD\nsubgraph param_list [하나]\ninterlock_history\nend" }, {})).includes("SUBGRAPH_ID_CLASH"));
  const fences = {
    own: "flowchart TD\nsubgraph other [하나]\neqp-scope[[설비]]\nparam_list\neqp-scope --> param_list\nend",
    other: "flowchart TD\nx([입력])",
  };
  assert.deepEqual(codesOf(subCheck(fences, { own: ["param_list"] })), ["SUBGRAPH_ID_CLASH"]);
});

test("같은 md 의 subgraph caller 는 오류가 없고 간선 없는 subgraph 도 된다", () => {
  assert.deepEqual(subCheck({ own: PICK }, { own: ["param_list", "interlock_history"] }), []);
  assert.deepEqual(subCheck({ own: "flowchart TD\nsubgraph g [묶음]\neqp-scope[[설비]]\nparam_list\neqp-scope --> param_list\nend" }, { own: ["param_list"] }), []);
});

test("다른 md 의 subgraph 는 흐름 노드로 가리키고 출처로 센다", () => {
  const queries = { spec: ["spec_by_param"], owner: ["param_list", "interlock_history"] };
  const ok = { spec: "flowchart TD\nparam_pick[[파라미터 고르기]]\neqp-scope[[설비]]\nparam_pick --> spec_by_param\neqp-scope --> spec_by_param", owner: PICK };
  assert.deepEqual(subCheck(ok, queries), []);

  const nope = { ...ok, spec: "flowchart TD\nnope[[없음]]\neqp-scope[[설비]]\nnope --> spec_by_param\neqp-scope --> spec_by_param" };
  const unknown = subCheck(nope, queries).find((e) => e.code === "UNKNOWN_ID");
  assert.match(unknown.message, /등재된 subgraph id 도 아니다/);

  const bare = { ...ok, spec: "flowchart TD\neqp-scope[[설비]]\nparam_pick --> spec_by_param\neqp-scope --> spec_by_param" };
  assert.match(subCheck(bare, queries).find((e) => e.code === "UNKNOWN_ID").message, /param_pick\[\[글\]\]/);
});

test("같은 md 의 callee subgraph 시작 조회는 caller 조회의 출력으로 채운다", () => {
  const gate = `flowchart TD
  eqp-scope[[설비]]
  eqp_state[설비 상태]
  eqp-scope --> eqp_state
  eqp_state -->|state = 'DOWN'| down_check
  subgraph down_check [멈춤 점검]
    alarm_list[알람 목록]
  end
  eqp-scope --> alarm_list
`;
  assert.deepEqual(subCheck({ gate }, { gate: ["eqp_state", "alarm_list"] }), []);
  assert.equal(parse(gate).hasQueryCaller("alarm_list"), true);
  assert.deepEqual(parse(gate).starts(["eqp_state", "alarm_list"]), ["eqp_state"]);
});

test("subgraph 를 돌아 자기로 오면 순환이다", () => {
  const loop = "flowchart TD\n  eqp-scope[[설비]]\n  subgraph g [묶음]\n    param_list\n  end\n  eqp-scope --> param_list\n  param_list --> g\n";
  assert.ok(codesOf(subCheck({ own: loop }, { own: ["param_list"] })).includes("MD_CYCLE"));
});
