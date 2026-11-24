import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GRAPH_SHAPES,
  buildGraph,
  declutter,
  degrees,
  distances,
  egoView,
  filterGraph,
  hubs,
  layoutColumns,
  orphansByType,
  reach,
  shapeOf,
  shapePath,
  wrapRows,
} from "../src/graph-model.mjs";

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

// ---------- 둘레 보기 · 목록 · 이름표 ----------

test("degrees count the links in and out; hubs are the most linked first, a doc with no link never", () => {
  const deg = degrees(graph);
  assert.deepEqual(deg.get("domain-skill/interlock"), { in: 1, out: 2 });
  assert.deepEqual(deg.get("db-schema/lonely"), { in: 0, out: 0 });
  const top = hubs(graph, { limit: 3 });
  assert.deepEqual(top[0], { key: "domain-skill/interlock", in: 1, out: 2, degree: 3 });
  assert.equal(top.length, 3);
  assert.equal(hubs(graph, { limit: 99 }).some((h) => h.key === "db-schema/lonely"), false);
  // the start screen lists the mains apart
  assert.equal(hubs(graph, { skip: (n) => n.kind === "main" }).some((h) => h.key.startsWith("domain-skill/interlock")), false);
});

test("연결 없음 is the docs no link touches, by type", () => {
  assert.deepEqual(orphansByType(graph), [{ type: "db-schema", keys: ["db-schema/lonely"] }]);
  // with the manual filtered out, the screen it pointed at stands alone too
  const cut = filterGraph(graph, (n) => n.type !== "manual");
  assert.equal(cut.nodes.has("manual/release"), false);
  assert.equal(cut.edges.some((e) => e.to === "manual/release" || e.from === "manual/release"), false);
  assert.deepEqual(orphansByType(cut), [
    { type: "db-schema", keys: ["db-schema/lonely"] },
    { type: "screen-map", keys: ["screen-map/monitor"] },
  ]);
});

test("둘레 보기: who points at the doc on the left, what it points at on the right, one level per link", () => {
  const one = egoView(graph, "domain-skill/interlock", { depth: 1 });
  assert.deepEqual(
    one.columns.map((c) => [c.level, c.keys, c.hidden]),
    [
      [-1, ["voc/voc-1"], 0],
      [0, ["domain-skill/interlock"], 0],
      [1, ["domain-skill/param", "manual/release"], 0],
    ],
  );
  assert.deepEqual(one.edges.map((e) => `${e.from}>${e.to}`).sort(), [
    "domain-skill/interlock>domain-skill/param",
    "domain-skill/interlock>manual/release",
    "voc/voc-1>domain-skill/interlock",
  ]);
  const two = egoView(graph, "domain-skill/interlock", { depth: 2 });
  assert.deepEqual(two.columns.map((c) => c.level), [-1, 0, 1, 2]);
  // the second level stands in its parents' order: param's 표, then the manual's 화면
  assert.deepEqual(two.columns.at(-1).keys, ["db-schema/param_type", "screen-map/monitor"]);
  assert.equal(two.edges.find((e) => e.to === "screen-map/monitor").rel, "screen");
  // a doc with no link is a column of its own
  assert.deepEqual(egoView(graph, "db-schema/lonely").columns.map((c) => c.keys), [["db-schema/lonely"]]);
  assert.deepEqual(egoView(graph, "voc/none"), { columns: [], edges: [] });
});

test("둘레 보기: a level shows `cap` docs — mains first, then the most linked — and counts the rest", () => {
  const docs = [
    { type: "db-schema", id: "big", links: [] },
    ...Array.from({ length: 30 }, (_, i) => ({ type: "voc", id: `v${String(i).padStart(2, "0")}`, links: [link("db-schema", "big")] })),
    { type: "domain-skill", id: "agent", role: "main", links: [link("db-schema", "big"), link("db-schema", "other")] },
    { type: "db-schema", id: "other", links: [] },
    { type: "manual", id: "busy", links: [link("db-schema", "big"), link("db-schema", "other"), link("voc", "v00")] },
  ];
  const g = buildGraph(docs);
  const view = egoView(g, "db-schema/big", { depth: 1, cap: 5 });
  const left = view.columns.find((c) => c.level === -1);
  assert.deepEqual(left.keys.slice(0, 2), ["domain-skill/agent", "manual/busy"]);
  assert.equal(left.keys.length, 5);
  assert.equal(left.hidden, 27);
  // 더 보기 raises that one level
  const more = egoView(g, "db-schema/big", { depth: 1, cap: 5, more: { [-1]: 20 } });
  assert.equal(more.columns.find((c) => c.level === -1).keys.length, 20);
  assert.equal(more.columns.find((c) => c.level === -1).hidden, 12);
  // only links between shown docs are drawn
  const shown = new Set(view.columns.flatMap((c) => c.keys));
  assert.equal(view.edges.every((e) => shown.has(e.from) && shown.has(e.to)), true);
});

test("둘레 보기: a pair that links both ways is one edge; past the first level every parent gets its turn", () => {
  const docs = [
    { type: "domain-skill", id: "a", role: "main", links: [link("domain-skill", "b"), link("domain-skill", "c")] },
    { type: "domain-skill", id: "b", role: "sub", links: [link("domain-skill", "a"), ...[1, 2, 3, 4].map((i) => link("db-schema", `b${i}`))] },
    { type: "domain-skill", id: "c", role: "sub", links: [1, 2, 3, 4].map((i) => link("db-schema", `c${i}`)) },
    ...["b", "c"].flatMap((p) => [1, 2, 3, 4].map((i) => ({ type: "db-schema", id: `${p}${i}`, links: [] }))),
  ];
  const view = egoView(buildGraph(docs), "domain-skill/a", { depth: 2, cap: 4 });
  // b points back at a: it stands once, on the pointed-at side, and the pair is one edge
  assert.deepEqual(view.columns.map((c) => c.level), [0, 1, 2]);
  const pair = view.edges.filter((e) => [e.from, e.to].sort().join() === "domain-skill/a,domain-skill/b");
  assert.equal(pair.length, 1);
  assert.equal(pair[0].both, true);
  const second = view.columns.at(-1);
  assert.deepEqual(second.keys, ["db-schema/b1", "db-schema/b2", "db-schema/c1", "db-schema/c2"]);
  assert.equal(second.hidden, 4);
});

test("전체 보기 wraps long columns until the picture is as tall as the canvas", () => {
  const opts = { cellW: 200, cellH: 30, gap: 80, aspect: 0.7 };
  // one column of 400: 23 rows × 18 stacks is the first shape at least 0.7 tall
  const rows = wrapRows([4, 400, 120], opts);
  const width = [4, 400, 120].reduce((w, n) => w + Math.ceil(n / rows) * 200, 0) + 160;
  assert.ok((rows * 30) / width >= 0.7);
  assert.ok(rows < 400);
  // a small graph keeps its columns whole
  assert.equal(wrapRows([2, 5, 3], opts), 5);
  assert.equal(wrapRows([], opts), 1);
});

test("이름표 솎기: the more important box stays, a pinned one always", () => {
  const box = (key, x, y, pin) => ({ key, x, y, w: 80, h: 14, pin });
  const kept = declutter([box("hub", 0, 0), box("under", 40, 6), box("far", 300, 0), box("next", 0, 20)]);
  assert.deepEqual([...kept].sort(), ["far", "hub", "next"]);
  // the hovered doc's name shows even over a more important one, and takes its room
  const pinned = declutter([box("hub", 0, 0), box("hovered", 40, 6, true), box("far", 300, 0)]);
  assert.deepEqual([...pinned].sort(), ["far", "hovered"]);
  // boxes that span grid cells still meet
  const wide = declutter([{ key: "a", x: 90, y: 90, w: 200, h: 14 }, { key: "b", x: 280, y: 95, w: 50, h: 14 }]);
  assert.deepEqual([...wide], ["a"]);
});

test("every built-in type has its own shape; an added type takes one in turn", () => {
  const builtin = ["domain-skill", "db-schema", "msg-format", "domain", "starter", "screen-map", "manual", "voc", "unclassified"];
  assert.equal(new Set(builtin.map((t) => shapeOf(t))).size, builtin.length);
  const types = [...builtin, "fault-note", "recipe"];
  assert.notEqual(shapeOf("fault-note", types), shapeOf("recipe", types));
  assert.ok(GRAPH_SHAPES.includes(shapeOf("fault-note", types)));
  for (const s of GRAPH_SHAPES) assert.match(shapePath(s, 6), /^M-?[\d.]+ -?[\d.]+.*Z$/);
});

test("a node carries its status, for the picture to draw an inactive doc hollow", () => {
  const g = buildGraph([{ type: "voc", id: "a", status: "inactive", links: [] }, { type: "voc", id: "b", links: [] }]);
  assert.equal(g.nodes.get("voc/a").status, "inactive");
  assert.equal(g.nodes.get("voc/b").status, "active");
});
