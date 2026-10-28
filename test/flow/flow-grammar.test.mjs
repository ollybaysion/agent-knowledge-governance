// BE FlowGrammarTest, the same fences and the same codes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/flow/flow-compiler.mjs";
import { CODES, errorText } from "../../src/flow/flow-error.mjs";
import { condition } from "../../src/flow/flow-grammar.mjs";

const codes = (fence) => compile(fence).errors.map((e) => e.code);
/** BE QueryFlowTool.parse: the flow, or the first error's text thrown. */
function parse(fence) {
  const { flow, errors } = compile(fence);
  if (errors.length) throw new Error(errorText(errors[0]));
  return flow;
}
const node = (id, kind, title = null, subgraph = null) => ({ id, kind, title, subgraph });
const edge = (caller, callee, cond = null, optional = false) => ({ caller, callee, condition: cond, optional });
const eq = (column, value) => ({ op: "=", column, value });

test("노드 모양 셋과 간선 둘을 읽는다", () => {
  const flow = parse(`flowchart TD
  eqp-scope[[설비 범위]]
  param_name([파라미터 이름])
  param_list[파라미터 목록]
  interlock_history
  spec-explain[[Spec 설명]]

  eqp-scope --> param_list
  param_name -.-> param_list
  param_list --> interlock_history
  interlock_history -->|interlock_type = 'HOLD'| spec-explain
`);
  assert.deepEqual(flow.nodes, [
    node("eqp-scope", "flow", "설비 범위"),
    node("param_name", "input", "파라미터 이름"),
    node("param_list", "query", "파라미터 목록"),
    node("interlock_history", "query"),
    node("spec-explain", "flow", "Spec 설명"),
  ]);
  assert.deepEqual(flow.edges.map((e) => [e.caller, e.callee, e.optional]), [
    ["eqp-scope", "param_list", false],
    ["param_name", "param_list", true],
    ["param_list", "interlock_history", false],
    ["interlock_history", "spec-explain", false],
  ]);
  assert.deepEqual(flow.edges[3].condition, eq("interlock_type", "HOLD"));
});

test("조건 넷과 주석 빈 줄을 읽는다", () => {
  const flow = parse("flowchart LR\n  %% 주석\n  a[제목]\n\n  a -->|x = 'E'| b\n  a -->|x != 'E'| c\n  a -->|x in ('T', 'R')| c\n  a -->|else| d\n");
  assert.deepEqual(flow.ids(), ["a", "b", "c", "d"]);
  assert.deepEqual(flow.nodes.filter((n) => n.title).map((n) => [n.id, n.title]), [["a", "제목"]]);
  assert.deepEqual(flow.edges.map((e) => e.condition), [
    eq("x", "E"),
    { op: "!=", column: "x", value: "E" },
    { op: "in", column: "x", values: ["T", "R"] },
    { op: "else", column: null },
  ]);
});

test("모양을 처음 적은 뒤에는 이름만 써도 되고 간선의 끝도 노드다", () => {
  const flow = parse("flowchart TD\nx([글])\nx\nx --> q\nmd-a[[A]]\nq --> md-a");
  assert.deepEqual(flow.nodes.map((n) => [n.id, n.kind]), [["x", "input"], ["q", "query"], ["md-a", "flow"]]);
});

test("같은 id 를 다른 모양으로 적으면 오류다", () => {
  assert.deepEqual(compile("flowchart TD\nx([글])\nx[조회]").errors, [
    { line: 3, code: "SHAPE_CONFLICT", message: "노드 x 의 모양이 둘이다 — 2 번째 줄은 입력 id([글]), 이 줄은 조회 id[글]" },
  ]);
});

test("문법 밖의 줄은 몇 번째 줄인지와 사유를 낸다", () => {
  assert.throws(() => parse("flowchart TD\na --> b --> c"), { message: "2 번째 줄 `a --> b --> c`: 한 줄에 간선 하나다 — 체인은 줄을 나눈다" });
  assert.throws(() => parse("flowchart TD\nsubgraph g\na --> b\nend"), { message: "2 번째 줄 `subgraph g`: subgraph g 의 글이 없다 — `subgraph g [글]` 로 적는다" });
  assert.throws(() => parse("flowchart TD\nstyle a fill:#f00"), { message: "2 번째 줄 `style a fill:#f00`: style 은 쓸 수 없다 — 노드 · 간선 · 주석 · subgraph · end 줄만 쓴다" });
  assert.deepEqual(codes("flowchart TD\na --> b --> c"), ["CHAIN"]);
  assert.deepEqual(codes("flowchart TD\na -.-> b -.-> c"), ["CHAIN"]);
  assert.deepEqual(codes("flowchart TD\na --> b & c"), ["AMPERSAND"]);
  assert.deepEqual(codes("flowchart TD\nstyle a fill:#f9f"), ["RESERVED_WORD"]);
  assert.deepEqual(codes("flowchart TD\na((원))"), ["NODE_SYNTAX"]);
  assert.deepEqual(codes("flowchart TD\na{마름모}"), ["NODE_SYNTAX"]);
  assert.deepEqual(codes("flowchart TD\na ==> b"), ["ARROW"]);
  assert.deepEqual(codes("flowchart TD\na --- b"), ["ARROW"]);
  assert.deepEqual(codes("flowchart TD\na -.- b"), ["ARROW"]);
  assert.deepEqual(codes("%%{init: {}}%%\nflowchart TD"), ["HEADER", "RESERVED_WORD"]);
  assert.deepEqual(codes("flowchart TD\n%%{init: {}}%%"), ["DIRECTIVE"]);
  assert.deepEqual(codes("flowchart TB\na --> b"), ["HEADER"]);
});

test("오류가 여럿이면 줄마다 모은다", () => {
  assert.deepEqual(compile("flowchart TD\na ==> b\nc((원))\nd --> e").errors.map((e) => [e.line, e.code]), [[2, "ARROW"], [3, "NODE_SYNTAX"]]);
});

test("간선 줄에 끝마다 모양을 같이 적는다", () => {
  const flow = parse("flowchart TD\n  eqp-scope[[설비 · 기간]] --> param_list[파라미터 목록]\n  a([글]) -.-> q\n  q[조회] -->|x = '1'| b[[흐름]]\n  q --> c\n");
  assert.deepEqual(flow.nodes, [
    node("eqp-scope", "flow", "설비 · 기간"),
    node("param_list", "query", "파라미터 목록"),
    node("a", "input", "글"),
    node("q", "query", "조회"),
    node("b", "flow", "흐름"),
    node("c", "query"),
  ]);
  assert.deepEqual(flow.edges, [edge("eqp-scope", "param_list"), edge("a", "q", null, true), edge("q", "b", eq("x", "1")), edge("q", "c")]);
});

test("간선 줄의 모양도 처음 것이 남고 다른 모양은 겹침이다", () => {
  assert.deepEqual(codes("flowchart TD\nq[조회] --> b\nq([입력]) --> c"), ["SHAPE_CONFLICT"]);
  assert.deepEqual(codes("flowchart TD\nq[조회] --> q([입력])"), ["SHAPE_CONFLICT"]);
  assert.equal(parse("flowchart TD\nq[처음] --> b\nq[나중] --> c").node("q").title, "처음");
  assert.deepEqual(codes("flowchart TD\na[가] --> b[나] --> c[다]"), ["CHAIN"]);
  assert.deepEqual(codes("flowchart TD\nx((원)) --> q"), ["EDGE_SYNTAX"]);
  assert.deepEqual(codes("flowchart TD\nparam-name([이름]) --> q"), ["INPUT_ID"]);
});

test("조건 라벨은 따옴표로 감싸도 된다", () => {
  const inAB = { op: "in", column: "param_type", values: ["A", "B"] };
  assert.deepEqual(parse("flowchart TD\na -->|\"param_type in ('A', 'B')\"| b").edges, [edge("a", "b", inAB)]);
  assert.deepEqual(parse("flowchart TD\na -->|param_type in ('A', 'B')| b").edges, [edge("a", "b", inAB)]);
  assert.deepEqual(parse("flowchart TD\na -->|\"x = '1'\"| b\na -->|\"else\"| c").edges.map((e) => e.condition), [eq("x", "1"), { op: "else", column: null }]);
  assert.deepEqual(codes("flowchart TD\na -->|\"x > 1\"| b"), ["CONDITION_SYNTAX"]);
});

test("입력 id 는 바인드 이름이다", () => {
  assert.deepEqual(codes("flowchart TD\nparam-name([이름])"), ["INPUT_ID"]);
  assert.deepEqual(codes("flowchart TD\nparam_name([이름])"), []);
});

test("id 는 글자 사이에 하이픈 하나씩을 받고 화살표 앞뒤 공백은 없어도 된다", () => {
  assert.deepEqual(parse("flowchart TD\na-b --> c-d\nc-d -->|x = '1'| e-f-g\ne-f-g[제목]").edges.map((e) => [e.caller, e.callee]), [["a-b", "c-d"], ["c-d", "e-f-g"]]);
  assert.deepEqual(parse("flowchart TD\na-b-->c").edges, [edge("a-b", "c")]);
  assert.deepEqual(parse("flowchart TD\na-.->c").edges, [edge("a", "c", null, true)]);
  assert.deepEqual(codes("flowchart TD\na--b --> c"), ["EDGE_SYNTAX"]);
  assert.deepEqual(codes("flowchart TD\na- --> c"), ["EDGE_SYNTAX"]);
  assert.deepEqual(codes("flowchart TD\na-b--->c"), ["EDGE_SYNTAX"]);
});

test("mermaid 문법 낱말로 시작하는 id 는 오류다", () => {
  assert.throws(() => parse("flowchart TD\nq1 --> end-x"), { message: "2 번째 줄 `q1 --> end-x`: id end-x 은 end 로 시작한다 — mermaid 문법 낱말은 id 머리에 쓸 수 없다" });
  assert.deepEqual(codes("flowchart TD\nend-x([글])"), ["RESERVED_WORD"]);
  assert.deepEqual(parse("flowchart TD\nq1 --> endx-y\nq1 --> x-end").ids(), ["q1", "endx-y", "x-end"]);
});

test("모르는 조건은 오류다", () => {
  assert.throws(() => parse("flowchart TD\na -->|x > '1'| b"), /조건은 `컬럼 = '값'` · `컬럼 != '값'` · `컬럼 in \('a', 'b'\)` · `else` 넷이다/);
  assert.deepEqual(codes("flowchart TD\na -->|x = E| b"), ["CONDITION_SYNTAX"]);
  assert.deepEqual(condition("x in ('a', 'b')"), { op: "in", column: "x", values: ["a", "b"] });
  assert.equal(condition("x > 1"), null);
});

test("변환 노드 id{{글}} 를 노드 줄과 간선 끝에 적고 그 줄을 안다", () => {
  const flow = parse("flowchart TD\n  m{{이름 맞추기}}\n  chamber[챔버] --> to_recipe{{레시피 변수}}\n  to_recipe --> recipe\n  m --> recipe");
  assert.deepEqual(flow.nodes, [node("m", "map", "이름 맞추기"), node("chamber", "query", "챔버"), node("to_recipe", "map", "레시피 변수"), node("recipe", "query")]);
  assert.deepEqual([flow.lineOf("m"), flow.lineOf("to_recipe"), flow.lineOf("recipe")], [2, 3, 4]);
  assert.deepEqual(codes("flowchart TD\nm{{변환}} --> q\nm[조회] --> r"), ["SHAPE_CONFLICT"]);
  assert.match(compile("flowchart TD\nm{{변환}}\nm[조회]").errors[0].message, /2 번째 줄은 변환 id\{\{글\}\}, 이 줄은 조회 id\[글\]/);
  assert.deepEqual(codes("flowchart TD\nm{{a{b}}"), ["NODE_SYNTAX"]);
});

test("오류 코드는 이름이 계약이다", () => {
  assert.deepEqual(CODES, [
    "HEADER", "DIRECTIVE", "RESERVED_WORD", "AMPERSAND", "CHAIN", "ARROW", "EDGE_SYNTAX",
    "NODE_SYNTAX", "CONDITION_SYNTAX", "INPUT_ID", "SHAPE_CONFLICT", "UNKNOWN_ID", "INPUT_IS_QUERY", "QUERY_IS_MD",
    "SELF_FLOW", "FLOW_ALONE", "EDGE_KIND", "OPTIONAL_EDGE", "CONDITION_PLACE", "ELSE_DUPLICATE", "CONDITION_COLUMN",
    "UNSOURCED_VAR", "UNSUPPORTED_EQP_FLOW", "CYCLE", "MD_CYCLE", "SUBGRAPH_ID", "SUBGRAPH_TITLE", "SUBGRAPH_UNCLOSED",
    "SUBGRAPH_END", "SUBGRAPH_NESTED", "SUBGRAPH_MEMBER", "SUBGRAPH_EMPTY", "SUBGRAPH_ID_CLASH",
    "MAP_ITEM", "MAP_FENCE", "MAP_SHAPE", "MAP_LINE", "MAP_EXPR", "MAP_DUP", "MAP_SOURCE", "MAP_SCOPE", "MAP_NO_SOURCE", "MAP_ALONE",
    "CHART_KIND", "CHART_KEY", "CHART_REQUIRED", "CHART_COLUMN", "CHART_BINS", "CHART_DUPLICATE",
  ]);
});
