import { test } from "node:test";
import assert from "node:assert/strict";

import { buildGraph, distances, layoutColumns, reach } from "../src/graph-model.mjs";

const link = (type, id, rel = "related") => ({ type, id, rel });
// interlock(main) → param(sub) → param_type(표); interlock → manual → screen(rel screen);
// voc → interlock(되가리킴); trace(main) → recipe_step; orphan 표 하나.
const DOCS = [
  { type: "domain-skill", id: "interlock", title: "인터락 에이전트", role: "main", links: [link("domain-skill", "param"), link("manual", "release")] },
  { type: "domain-skill", id: "trace", title: "트레이스 에이전트", role: "main", links: [link("db-schema", "recipe_step")] },
  { type: "domain-skill", id: "param", title: "인터락 파라미터", role: "sub", links: [link("db-schema", "param_type")] },
  { type: "db-schema", id: "param_type", links: [] },
  { type: "db-schema", id: "recipe_step", links: [] },
  { type: "db-schema", id: "lonely", links: [] },
  { type: "manual", id: "release", title: "인터락 해제 절차", links: [link("screen-map", "monitor", "screen")] },
  { type: "screen-map", id: "monitor", title: "설비 모니터", links: [] },
  { type: "voc", id: "voc-1", title: "VOC 인터락", links: [link("domain-skill", "interlock")] },
];
const graph = buildGraph(DOCS);
const names = (keys) => keys.map((k) => graph.nodes.get(k).name);

test("columns are the undirected distance from the mains; a doc no main reaches is in 연결 없음 at the end", () => {
  const cols = layoutColumns(graph);
  assert.deepEqual(
    cols.map((c) => [c.label, names(c.keys)]),
    [
      ["메인 에이전트", ["인터락 에이전트", "트레이스 에이전트"]],
      ["1단 — 직접 연결", ["인터락 파라미터", "recipe_step", "인터락 해제 절차", "VOC 인터락"]],
      ["2단", ["param_type", "설비 모니터"]],
      ["연결 없음", ["lonely"]],
    ],
  );
  // VOC points at the main, so it stands one step away all the same.
  assert.equal(distances(graph).get("voc/voc-1"), 1);
});

test("a column whose nodes are all hidden is not returned", () => {
  const cols = layoutColumns(graph, (n) => n.type !== "db-schema" && n.type !== "screen-map");
  assert.deepEqual(cols.map((c) => c.label), ["메인 에이전트", "1단 — 직접 연결"]);
});

test("an edge runs from the doc that holds the link; screen links keep rel screen; dangling and repeated links drop", () => {
  const g = buildGraph([
    ...DOCS,
    { type: "voc", id: "voc-2", links: [link("db-schema", "nope"), link("voc", "voc-1"), link("voc", "voc-1")] },
    { type: "voc", id: "gone", status: "archived", links: [link("voc", "voc-1")] },
  ]);
  assert.deepEqual(g.edges.find((e) => e.from === "manual/release"), { from: "manual/release", to: "screen-map/monitor", rel: "screen" });
  assert.deepEqual(g.edges.filter((e) => e.from === "voc/voc-2"), [{ from: "voc/voc-2", to: "voc/voc-1", rel: "related" }]);
  assert.equal(g.nodes.has("voc/gone"), false);
});

test("reach follows links forward and, in both directions, backward too", () => {
  const down = reach(graph, "domain-skill/interlock", { direction: "down" });
  assert.deepEqual(
    [...down.nodes].sort(),
    ["db-schema/param_type", "domain-skill/interlock", "domain-skill/param", "manual/release", "screen-map/monitor"],
  );
  const both = reach(graph, "domain-skill/param");
  assert.deepEqual([...both.nodes].sort(), ["db-schema/param_type", "domain-skill/interlock", "domain-skill/param", "voc/voc-1"]);
  // backward from param reaches interlock and, through it, the voc — never interlock's other children.
  assert.equal(both.nodes.has("manual/release"), false);
  assert.deepEqual(
    [...both.edges].map((i) => `${graph.edges[i].from}>${graph.edges[i].to}`).sort(),
    ["domain-skill/interlock>domain-skill/param", "domain-skill/param>db-schema/param_type", "voc/voc-1>domain-skill/interlock"],
  );
});

test("depth stops the walk that many links away", () => {
  const one = reach(graph, "domain-skill/interlock", { depth: 1, direction: "down" });
  assert.deepEqual([...one.nodes].sort(), ["domain-skill/interlock", "domain-skill/param", "manual/release"]);
  const two = reach(graph, "voc/voc-1", { depth: 2, direction: "down" });
  assert.deepEqual([...two.nodes].sort(), ["domain-skill/interlock", "domain-skill/param", "manual/release", "voc/voc-1"]);
});
