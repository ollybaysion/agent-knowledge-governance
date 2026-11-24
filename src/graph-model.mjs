// The document graph the dashboard's 그래프 screen draws (served as
// /lib/shared/graph-model.mjs): nodes = documents, edges = links[]. Two
// pictures read it: 둘레 보기 (egoView — one doc, who points at it on the left,
// what it points at on the right) and 전체 보기 (layoutColumns — undirected
// distance from the main agents, wrapped by wrapRows). The side lists read
// degrees · hubs · orphansByType, the name tags read declutter.
// No node imports: this file runs in the browser as it is.

/** Column order inside a column: type first, then name. */
export const GRAPH_TYPES = ["domain-skill", "db-schema", "msg-format", "manual", "screen-map", "voc"];

export const keyOf = (type, id) => `${type}/${id}`;

/** main · sub for domain-skill (role absent reads as main), the type otherwise. */
export function kindOf(doc) {
  if (doc.type !== "domain-skill") return doc.type;
  return doc.role === "sub" ? "sub" : "main";
}

/**
 * docs = GET /api/docs rows. Archived docs are left out, as the tree leaves
 * them out. An edge goes from the doc that holds the link to its target; links
 * to a doc not in the graph and repeated links are dropped. `types` = the
 * types drawn, in column order (GET /api/types).
 */
export function buildGraph(docs, types = GRAPH_TYPES) {
  const nodes = new Map();
  for (const d of docs) {
    if (d.status === "archived" || !types.includes(d.type)) continue;
    const key = keyOf(d.type, d.id);
    nodes.set(key, { key, type: d.type, id: d.id, name: d.title ?? d.id, kind: kindOf(d), status: d.status ?? "active" });
  }
  const edges = [];
  const seen = new Set();
  for (const d of docs) {
    const from = keyOf(d.type, d.id);
    if (!nodes.has(from)) continue;
    for (const l of d.links ?? []) {
      const to = keyOf(l.type, l.id);
      const rel = l.rel === "screen" ? "screen" : "related";
      const k = `${from}>${to}#${rel}`;
      if (to === from || !nodes.has(to) || seen.has(k)) continue;
      seen.add(k);
      edges.push({ from, to, rel });
    }
  }
  return { nodes, edges, types };
}

/** Undirected BFS distance from every main; a node no main reaches is absent. */
export function distances(graph) {
  const nbr = new Map([...graph.nodes.keys()].map((k) => [k, []]));
  for (const e of graph.edges) {
    nbr.get(e.from).push(e.to);
    nbr.get(e.to).push(e.from);
  }
  const dist = new Map();
  let frontier = [...graph.nodes.values()].filter((n) => n.kind === "main").map((n) => n.key);
  for (const k of frontier) dist.set(k, 0);
  for (let d = 1; frontier.length; d++) {
    const next = [];
    for (const k of frontier)
      for (const m of nbr.get(k))
        if (!dist.has(m)) {
          dist.set(m, d);
          next.push(m);
        }
    frontier = next;
  }
  return dist;
}

export function columnLabel(dist) {
  if (dist === null) return "연결 없음";
  if (dist === 0) return "메인 에이전트";
  if (dist === 1) return "1단 — 직접 연결";
  return `${dist}단`;
}

/**
 * The columns left to right: distance 0, 1, 2 …, then 연결 없음. Distances
 * come from the whole graph; `shown(node)` only decides which nodes stand in
 * them, and a column left empty is not returned.
 * → [{ dist (number | null), label, keys[] }]
 */
export function layoutColumns(graph, shown = () => true) {
  const dist = distances(graph);
  const byDist = new Map();
  for (const n of graph.nodes.values()) {
    if (!shown(n)) continue;
    const d = dist.has(n.key) ? dist.get(n.key) : null;
    if (!byDist.has(d)) byDist.set(d, []);
    byDist.get(d).push(n);
  }
  const order = [...byDist.keys()].sort((a, b) => (a === null) - (b === null) || a - b);
  const types = graph.types ?? GRAPH_TYPES;
  const rank = (n) => types.indexOf(n.type) * 2 + (n.kind === "sub" ? 1 : 0);
  return order.map((d) => ({
    dist: d,
    label: columnLabel(d),
    keys: byDist
      .get(d)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ko"))
      .map((n) => n.key),
  }));
}

/**
 * What a selected doc reaches: following edges forward ("down") and, when
 * direction is "both", backward too, each up to `depth` steps (Infinity =
 * all). → { nodes: Set<key>, edges: Set<edge index> }
 */
export function reach(graph, start, { depth = Infinity, direction = "both" } = {}) {
  const nodes = new Set([start]);
  const edges = new Set();
  const walk = (from, to) => {
    let frontier = [start];
    const seen = new Set(frontier);
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const k of frontier)
        graph.edges.forEach((e, i) => {
          if (e[from] !== k) return;
          edges.add(i);
          nodes.add(e[to]);
          if (!seen.has(e[to])) {
            seen.add(e[to]);
            next.push(e[to]);
          }
        });
      frontier = next;
    }
  };
  walk("from", "to");
  if (direction === "both") walk("to", "from");
  return { nodes, edges };
}

/** The same graph with only the nodes `keep(node)` says yes to, and the edges between them. */
export function filterGraph(graph, keep) {
  const nodes = new Map([...graph.nodes].filter(([, n]) => keep(n)));
  const edges = graph.edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
  return { nodes, edges, types: graph.types };
}

/** Every node's link counts: in = 가리켜짐, out = 가리킴. → Map<key, { in, out }> */
export function degrees(graph) {
  const deg = new Map([...graph.nodes.keys()].map((k) => [k, { in: 0, out: 0 }]));
  for (const e of graph.edges) {
    deg.get(e.from).out++;
    deg.get(e.to).in++;
  }
  return deg;
}

/**
 * 허브: the docs with the most links (in + out), most first; ties go to the
 * more pointed-at doc, then the name. A doc with no link is never a hub.
 * `skip(node)` leaves a kind out (the start screen lists the mains apart).
 * → [{ key, in, out, degree }]
 */
export function hubs(graph, { limit = 10, skip = () => false } = {}) {
  const deg = degrees(graph);
  return [...graph.nodes.values()]
    .filter((n) => !skip(n))
    .map((n) => ({ key: n.key, ...deg.get(n.key), degree: deg.get(n.key).in + deg.get(n.key).out, name: n.name }))
    .filter((h) => h.degree > 0)
    .sort((a, b) => b.degree - a.degree || b.in - a.in || a.name.localeCompare(b.name, "ko"))
    .slice(0, limit)
    .map(({ name, ...h }) => h);
}

/**
 * 연결 없음: the docs no link touches, grouped by type in the graph's type
 * order, names in order. A type with none is left out.
 * → [{ type, keys[] }]
 */
export function orphansByType(graph) {
  const deg = degrees(graph);
  const types = graph.types ?? GRAPH_TYPES;
  const by = new Map(types.map((t) => [t, []]));
  for (const n of graph.nodes.values()) {
    const d = deg.get(n.key);
    if (d.in + d.out === 0) by.get(n.type)?.push(n);
  }
  return [...by]
    .filter(([, list]) => list.length)
    .map(([type, list]) => ({ type, keys: list.sort((a, b) => a.name.localeCompare(b.name, "ko")).map((n) => n.key) }));
}

/**
 * 둘레 보기: `center` and the docs up to `depth` links away, by direction.
 * Level 0 is the center; level -1 points at it, -2 points at those; level +1
 * is what it points at, +2 what those point at. A doc stands once, at the
 * level nearest the center (the pointed-at side on a tie).
 *
 * A level shows `cap` docs (`more[level]` raises it for that level): mains
 * first, then the most linked. Past the first level the docs are dealt out
 * parent by parent, so one busy parent does not fill the column, and they
 * stand in their parents' order, which keeps the lines from crossing.
 * Only a shown doc is walked further. `hidden` = the docs the cap left out.
 *
 * Edges: every link between two shown docs. A pair that links both ways is
 * one edge with `both`.
 * → { columns: [{ level, keys[], hidden }], edges: [{ from, to, rel, both }] }
 */
export function egoView(graph, center, { depth = 1, cap = 10, more = {} } = {}) {
  if (!graph.nodes.has(center)) return { columns: [], edges: [] };
  const deg = degrees(graph);
  const types = graph.types ?? GRAPH_TYPES;
  const next = { 1: new Map(), [-1]: new Map() }; // side → key → neighbours on that side
  for (const k of graph.nodes.keys()) {
    next[1].set(k, []);
    next[-1].set(k, []);
  }
  for (const e of graph.edges) {
    next[1].get(e.from).push(e.to);
    next[-1].get(e.to).push(e.from);
  }
  const weight = (k) => deg.get(k).in + deg.get(k).out;
  const order = (a, b) => {
    const x = graph.nodes.get(a);
    const y = graph.nodes.get(b);
    return (
      (y.kind === "main") - (x.kind === "main") ||
      weight(b) - weight(a) ||
      types.indexOf(x.type) - types.indexOf(y.type) ||
      x.name.localeCompare(y.name, "ko")
    );
  };
  const placed = new Set([center]);
  const columns = [{ level: 0, keys: [center], hidden: 0 }];
  const frontier = { 1: [center], [-1]: [center] };
  for (let d = 1; d <= depth; d++) {
    for (const side of [1, -1]) {
      // candidate → the index of the first parent that reaches it
      const parent = new Map();
      frontier[side].forEach((p, pi) => {
        for (const k of next[side].get(p)) if (!placed.has(k) && !parent.has(k)) parent.set(k, pi);
      });
      for (const k of parent.keys()) placed.add(k);
      const level = side * d;
      const limit = more[level] ?? cap;
      const groups = new Map();
      for (const [k, pi] of parent) {
        if (!groups.has(pi)) groups.set(pi, []);
        groups.get(pi).push(k);
      }
      const queues = [...groups].sort((a, b) => a[0] - b[0]).map(([pi, keys]) => ({ pi, keys: keys.sort(order) }));
      const taken = [];
      for (let round = 0; taken.length < limit && queues.some((q) => q.keys.length > round); round++)
        for (const q of queues) if (taken.length < limit && q.keys.length > round) taken.push(q.keys[round]);
      const keys = taken.sort((a, b) => parent.get(a) - parent.get(b) || order(a, b));
      frontier[side] = keys;
      if (parent.size) columns.push({ level, keys, hidden: parent.size - keys.length });
    }
  }
  columns.sort((a, b) => a.level - b.level);
  const shown = new Set(columns.flatMap((c) => c.keys));
  const edges = [];
  const at = new Map();
  for (const e of graph.edges) {
    if (!shown.has(e.from) || !shown.has(e.to)) continue;
    const back = at.get(`${e.to}>${e.from}#${e.rel}`);
    if (back) back.both = true;
    else {
      const edge = { from: e.from, to: e.to, rel: e.rel, both: false };
      at.set(`${e.from}>${e.to}#${e.rel}`, edge);
      edges.push(edge);
    }
  }
  return { columns, edges };
}

/**
 * 전체 보기 wraps a long column into side-by-side stacks. The rows a stack
 * holds: the fewest (from `minRows`) that make the whole picture at least as
 * tall as the canvas (`aspect` = height / width), so it fills the screen
 * instead of standing as one thin strip. `sizes` = docs per column.
 */
export function wrapRows(sizes, { cellW, cellH, gap, aspect, minRows = 6 }) {
  const tallest = Math.max(1, ...sizes);
  for (let rows = Math.min(minRows, tallest); rows < tallest; rows++) {
    const width = sizes.reduce((w, n) => w + Math.max(1, Math.ceil(n / rows)) * cellW, 0) + Math.max(0, sizes.length - 1) * gap;
    if ((rows * cellH) / width >= aspect) return rows;
  }
  return tallest;
}

/**
 * 이름표 솎기: `boxes` ({ key, x, y, w, h, pin? }) come most important first.
 * A pinned box always stays. Any other stays when it overlaps no box already
 * kept (`pad` = the air kept between two). → Set<key> of the boxes to show.
 */
export function declutter(boxes, { pad = 2 } = {}) {
  const CELL = 96;
  const grid = new Map();
  const cells = (b) => {
    const out = [];
    for (let cx = Math.floor((b.x - pad) / CELL); cx <= Math.floor((b.x + b.w + pad) / CELL); cx++)
      for (let cy = Math.floor((b.y - pad) / CELL); cy <= Math.floor((b.y + b.h + pad) / CELL); cy++) out.push(`${cx}:${cy}`);
    return out;
  };
  const hits = (a, b) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const kept = new Set();
  const keep = (b) => {
    kept.add(b.key);
    for (const c of cells(b)) {
      if (!grid.has(c)) grid.set(c, []);
      grid.get(c).push(b);
    }
  };
  for (const b of boxes) if (b.pin) keep(b);
  for (const b of boxes) {
    if (b.pin) continue;
    if (!cells(b).some((c) => grid.get(c)?.some((o) => hits(b, o)))) keep(b);
  }
  return kept;
}

/**
 * A type's shape, so a type reads without its color. The built-in types have
 * a fixed one; a type an admin added takes the next shape in turn.
 */
export const GRAPH_SHAPES = ["circle", "square", "diamond", "hexagon", "triangle", "pill", "pentagon", "wedge", "cross"];
const FIXED_SHAPE = {
  "domain-skill": "circle",
  "db-schema": "square",
  "msg-format": "diamond",
  domain: "hexagon",
  starter: "triangle",
  "screen-map": "pill",
  manual: "pentagon",
  voc: "wedge",
  unclassified: "cross",
};
export function shapeOf(type, types = GRAPH_TYPES) {
  if (FIXED_SHAPE[type]) return FIXED_SHAPE[type];
  const extra = types.filter((t) => !FIXED_SHAPE[t]);
  return GRAPH_SHAPES[1 + (Math.max(0, extra.indexOf(type)) % (GRAPH_SHAPES.length - 1))];
}

/** The SVG path of a shape about (0, 0); `r` = half its size. */
export function shapePath(shape, r) {
  const f = (n) => Math.round(n * 100) / 100;
  const poly = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join("L")}Z`;
  const ring = (n, R, turn) => poly(Array.from({ length: n }, (_, i) => [R * Math.cos(turn + (i * 2 * Math.PI) / n), R * Math.sin(turn + (i * 2 * Math.PI) / n)]));
  switch (shape) {
    case "square":
      return poly([[-r * 0.88, -r * 0.88], [r * 0.88, -r * 0.88], [r * 0.88, r * 0.88], [-r * 0.88, r * 0.88]]);
    case "diamond":
      return ring(4, r * 1.2, -Math.PI / 2);
    case "hexagon":
      return ring(6, r * 1.1, 0);
    case "triangle":
      return ring(3, r * 1.25, -Math.PI / 2);
    case "wedge":
      return ring(3, r * 1.25, Math.PI / 2);
    case "pentagon":
      return ring(5, r * 1.12, -Math.PI / 2);
    case "pill": {
      const w = r * 1.35;
      const h = r * 0.68;
      return `M${f(-w + h)} ${f(-h)}H${f(w - h)}A${f(h)} ${f(h)} 0 0 1 ${f(w - h)} ${f(h)}H${f(-w + h)}A${f(h)} ${f(h)} 0 0 1 ${f(-w + h)} ${f(-h)}Z`;
    }
    case "cross": {
      const a = r * 1.05;
      const b = r * 0.38;
      return poly([[-b, -a], [b, -a], [b, -b], [a, -b], [a, b], [b, b], [b, a], [-b, a], [-b, b], [-a, b], [-a, -b], [-b, -b]]);
    }
    default:
      return `M${f(-r)} 0A${f(r)} ${f(r)} 0 1 0 ${f(r)} 0A${f(r)} ${f(r)} 0 1 0 ${f(-r)} 0Z`;
  }
}
