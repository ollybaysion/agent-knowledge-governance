// The document graph the dashboard's 그래프 screen draws (served as
// /graph-model.mjs): nodes = documents, edges = links[], columns = undirected
// distance from the main agents. No node imports: this file runs in the
// browser as it is.

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
    nodes.set(key, { key, type: d.type, id: d.id, name: d.title ?? d.id, kind: kindOf(d) });
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
