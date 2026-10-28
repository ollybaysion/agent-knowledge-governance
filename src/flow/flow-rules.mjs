// The flow's meaning checked — BE FlowRules.java. One check per function; the
// input is the flow and the facts of the registered mds alone. An error's
// line is 0, but MAP_SOURCE · MAP_SCOPE's: the map line's md line. No node
// imports: the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";
import { Kind } from "./flow-grammar.mjs";
import { QueryFlow, edgeText } from "./flow-compiler.mjs";
import { parseExpr, splitMapLine } from "./map-expr.mjs";
import { EQP_BINDS, isEqpBind, isTimeBind } from "../sql-bind.mjs";

/** The input that fills :start_time and :end_time at once — the one exception. */
export const DURATION = "duration";

const error = (code, message, line = 0) => flowError(line, code, message);
const kind = (flow, id) => flow.kindOf(id) ?? Kind.QUERY;
const lower = (s) => s.toLowerCase();

/**
 * One registered md's facts.
 * @param {string} name
 * @param {QueryFlow} [flow]
 * @param {string[]} [queryIds] its SQL item ids, written order
 * @param {{id: string, line: number, rows: {line: number, text: string}[]}[]} [maps]
 *   its map items, written order, md lines (agent-md readAgentMd's maps)
 * @returns {{name: string, flow: QueryFlow, queryIds: string[], maps: object[]}}
 */
export const md = (name, flow, queryIds, maps) => ({ name, flow: flow ?? QueryFlow.EMPTY, queryIds: queryIds ?? [], maps: maps ?? [] });

/** A subgraph as an md: its id, its flow, the md's SQL items inside it. */
export function subgraphMd(m, id) {
  const flow = m.flow.subgraph(id);
  const inside = new Set(flow.ids());
  return md(id, flow, m.queryIds.filter((q) => inside.has(q)));
}

/** Every subgraph of the mds — md order, written order, the first of a repeated id. */
export function subgraphsOf(mds) {
  const out = new Map();
  for (const m of mds) for (const id of m.flow.subgraphIds()) if (!out.has(id)) out.set(id, subgraphMd(m, id));
  return out;
}

/**
 * The facts a check stands on.
 * @param {string} self the md checked
 * @param {string[]} ownQueries its SQL item ids, written order
 * @param {Map<string, {id: string, vars: string[], columns: string[]|null}>} queries every
 *   registered query (self's too); columns null when the SQL did not read — checks on them pass
 * @param {Map<string, ReturnType<md>>} mds every registered md
 * @param {Map<string, ReturnType<md>>} [subgraphs] every registered md's subgraphs ({@link subgraphsOf} by default)
 */
export function facts(self, ownQueries, queries, mds, subgraphs = subgraphsOf(mds.values())) {
  return {
    self,
    ownQueries: ownQueries ?? [],
    queries,
    mds,
    subgraphs,
    /** What a flow node id points at: a registered md, else a registered subgraph, else null. */
    target: (id) => mds.get(id) ?? subgraphs.get(id) ?? null,
  };
}

/** Every check, in order: nodes · edge kinds · else · condition columns · bind sources · map sources · cycle · md cycle. */
export function check(flow, f) {
  return [
    ...nodes(flow, f),
    ...edgeKinds(flow),
    ...elses(flow),
    ...conditionColumns(flow, f),
    ...sources(flow, f),
    ...mapSources(flow, f),
    ...cycle(flow),
    ...mdCycle(flow, f),
  ];
}

/**
 * Each node has what its shape names registered: a query node a query, a
 * flow node an md or a subgraph, an input node no query id. A subgraph of
 * this md takes no registered query id or md name.
 */
export function nodes(flow, f) {
  const out = [];
  for (const n of flow.nodes) {
    const id = n.id;
    const query = f.queries.has(id);
    const isMd = f.mds.has(id);
    const sub = f.subgraphs.has(id);
    if (n.kind === Kind.INPUT) {
      if (query) out.push(error(Code.INPUT_IS_QUERY, `입력 ${id}: SQL 항목 id 와 겹친다`));
    } else if (n.kind === Kind.QUERY) {
      if (query && isMd) out.push(error(Code.QUERY_IS_MD, `노드 ${id}: 조회 id 와 md 이름이 겹친다`));
      else if (!query)
        out.push(error(Code.UNKNOWN_ID, `노드 ${id}${isMd || sub
          ? `: 조회가 아니다 — ${isMd ? "md" : "다른 md 의 subgraph"} 를 흐름 노드로 쓰려면 \`${id}[[글]]\` 로 적는다`
          : ": 이 md 의 SQL 항목도, 등재된 조회도 아니다"}`));
    } else if (n.kind === Kind.MAP) {
      // its map item is agent-md's to pair (MAP_ITEM · MAP_SHAPE)
    } else if (flow.isSubgraph(id)) {
      if (query) out.push(error(Code.SUBGRAPH_ID_CLASH, `subgraph ${id}: 등재된 조회 id 와 겹친다`));
      else if (isMd) out.push(error(Code.SUBGRAPH_ID_CLASH, `subgraph ${id}: 등재된 md 이름과 겹친다`));
    } else if (!isMd && !sub) out.push(error(Code.UNKNOWN_ID, `흐름 노드 ${id}: 등재된 md 이름도, 등재된 subgraph id 도 아니다`));
    else if (id === f.self) out.push(error(Code.SELF_FLOW, `흐름 노드 ${id}: 자기 md 를 가리킨다(순환)`));
    else if (query) out.push(error(Code.QUERY_IS_MD, `노드 ${id}: 조회 id 와 md 이름이 겹친다`));
  }
  return out;
}

/**
 * Edge kinds: input → query · flow → query · query → query · query → flow,
 * a map at a query's place. `-.->` is input → query only, a condition a query
 * or map caller's only. A flow node is on an edge — a subgraph of this md may
 * stand alone (another md may point at it). A map's own edges are flow-maps'.
 */
export function edgeKinds(flow) {
  const out = [];
  for (const e of flow.edges) {
    const caller = kind(flow, e.caller);
    const callee = kind(flow, e.callee);
    if (callee === Kind.INPUT) out.push(error(Code.EDGE_KIND, `간선 ${edgeText(e)}: 입력으로 들어가는 간선은 쓸 수 없다`));
    else if (caller === Kind.INPUT && callee === Kind.FLOW)
      out.push(error(Code.EDGE_KIND, `간선 ${edgeText(e)}: 입력 → 흐름 간선은 쓸 수 없다 — 입력은 조회로 간다`));
    else if (caller === Kind.FLOW && callee === Kind.FLOW) out.push(error(Code.EDGE_KIND, `간선 ${edgeText(e)}: 흐름 → 흐름 간선은 쓸 수 없다`));
    if (e.optional && !(caller === Kind.INPUT && callee === Kind.QUERY))
      out.push(error(Code.OPTIONAL_EDGE, `간선 ${edgeText(e)}: -.-> 는 입력 → 조회에만 쓴다`));
    if (e.condition && caller !== Kind.QUERY && caller !== Kind.MAP)
      out.push(error(Code.CONDITION_PLACE, `간선 ${edgeText(e)}: 조건은 조회 · 변환 caller 의 간선에만 쓴다`));
  }
  for (const n of flow.nodes)
    if (n.kind === Kind.FLOW && !flow.isSubgraph(n.id) && flow.edgesFrom(n.id).length === 0 && !flow.hasCaller(n.id))
      out.push(error(Code.FLOW_ALONE, `흐름 노드 ${n.id}: 간선에 쓰지 않았다`));
  return out;
}

/** One else per caller at most. */
export function elses(flow) {
  const out = [];
  const seen = new Set();
  for (const e of flow.edges) {
    if (e.condition?.op !== "else") continue;
    if (seen.has(e.caller)) out.push(error(Code.ELSE_DUPLICATE, `간선 ${edgeText(e)}: ${e.caller} 의 else 는 하나까지다`));
    seen.add(e.caller);
  }
  return out;
}

/**
 * A condition's column is among the caller query's output columns, or among
 * the names a caller map gives; a caller whose SQL did not read is skipped.
 */
export function conditionColumns(flow, f) {
  const out = [];
  for (const e of flow.edges) {
    const column = e.condition?.column ?? null;
    if (column !== null && kind(flow, e.caller) === Kind.MAP) {
      const g = gives(flow, f, e.caller, new Set());
      if (!g.anything && !g.names.has(lower(column)))
        out.push(error(Code.CONDITION_COLUMN, `간선 ${edgeText(e)}: 컬럼 ${column} 이 caller 변환 ${e.caller} 가 내는 이름 [${[...g.names].join(", ")}] 에 없다`));
      continue;
    }
    const caller = f.queries.get(e.caller);
    const columns = column !== null && caller ? caller.columns : null;
    if (columns && !columns.some((c) => lower(c) === lower(column)))
      out.push(error(Code.CONDITION_COLUMN, `간선 ${edgeText(e)}: 컬럼 ${column} 이 caller 조회 ${e.caller} 의 출력 컬럼 [${columns.join(", ")}] 에 없다`));
  }
  return out;
}

// The names that fill a bind: the bind, duration for a time bind, every eqp bind name for an eqp bind. Lower case.
function names(v) {
  const out = new Set([lower(v)]);
  if (isTimeBind(v)) out.add(DURATION);
  if (isEqpBind(v)) for (const b of EQP_BINDS) out.add(b);
  return out;
}

// The query gives the column; a query whose SQL did not read gives any.
const columnOf = (caller, column) => !!caller && (caller.columns === null || caller.columns.some((c) => lower(c) === lower(column)));

// What a leading flow (md or subgraph) gives a callee: its input ids and its
// end queries' columns, and what the flows leading it give. `anything` when
// an end query's columns did not read.
function provided(id, f, seen) {
  const m = f.target(id);
  const out = { names: new Set(), anything: false };
  if (!m || seen.has(id)) return out;
  seen.add(id);
  for (const n of m.flow.inputs()) out.names.add(lower(n.id));
  for (const end of m.flow.ends(m.queryIds)) {
    const fact = f.queries.get(end);
    if (!fact) continue;
    if (fact.columns === null) out.anything = true;
    else for (const c of fact.columns) out.names.add(lower(c));
  }
  for (const lead of m.flow.leading()) {
    const p = provided(lead, f, seen);
    for (const n of p.names) out.names.add(n);
    out.anything ||= p.anything;
  }
  return out;
}

// The edges a node takes values by: its own, and its subgraph's when it is a
// start of that subgraph (a query or map caller pointing at the subgraph).
function callersOf(flow, id) {
  const own = flow.edgesInto(id);
  const sub = flow.node(id)?.subgraph ?? null;
  if (sub === null || !flow.subgraph(sub).starts([]).includes(id)) return own;
  return [...own, ...flow.edgesInto(sub).filter((e) => [Kind.QUERY, Kind.MAP].includes(kind(flow, e.caller)))];
}

// A map's left names, lower case: this md's map item of that id.
function leftNames(f, id) {
  const item = f.mds.get(f.self)?.maps.find((m) => m.id === id);
  const out = new Set();
  for (const r of item?.rows ?? []) {
    const split = splitMapLine(r.text);
    if (split) out.add(lower(split.name));
  }
  return out;
}

// The names a node gives the node it points at, lower case: an input its id,
// a query its columns, a flow what it provides, a map what flows into it and
// its left names. `anything` when a query's columns did not read.
function gives(flow, f, id, seen) {
  const k = kind(flow, id);
  if (k === Kind.INPUT) return { names: new Set([lower(id)]), anything: false };
  if (k === Kind.FLOW) return provided(id, f, new Set());
  if (k === Kind.QUERY) {
    const fact = f.queries.get(id);
    return { names: new Set((fact?.columns ?? []).map(lower)), anything: !!fact && fact.columns === null };
  }
  const out = inflow(flow, f, id, seen);
  for (const n of leftNames(f, id)) out.names.add(n);
  return out;
}

// What flows into a node: the names its callers give.
function inflow(flow, f, id, seen) {
  const out = { names: new Set(), anything: false };
  if (seen.has(id)) return out;
  seen.add(id);
  for (const e of callersOf(flow, id)) {
    const g = gives(flow, f, e.caller, seen);
    for (const n of g.names) out.names.add(n);
    out.anything ||= g.anything;
  }
  return out;
}

// The caller fills :v of the node it points at. A map fills it by a left
// name, else passes on what fills it.
function fills(flow, f, caller, v, seen) {
  const k = kind(flow, caller);
  if (k === Kind.INPUT) return names(v).has(lower(caller));
  if (k === Kind.QUERY) return !isEqpBind(v) && columnOf(f.queries.get(caller), v);
  if (k === Kind.MAP) {
    const left = leftNames(f, caller);
    return [...names(v)].some((n) => left.has(n)) || sourced(flow, f, caller, v, seen);
  }
  const p = provided(caller, f, new Set());
  return p.anything || [...names(v)].some((n) => p.names.has(n));
}

function sourced(flow, f, q, v, seen = new Set()) {
  if (seen.has(q)) return false;
  seen.add(q);
  return callersOf(flow, q).some((e) => fills(flow, f, e.caller, v, seen));
}

// :v (an eqp bind) is filled by a caller query's output — straight, or passed on by maps.
function byQuery(flow, f, q, v, seen = new Set()) {
  if (seen.has(q)) return false;
  seen.add(q);
  return flow.edgesInto(q).some((e) => {
    const k = kind(flow, e.caller);
    if (k === Kind.QUERY) return columnOf(f.queries.get(e.caller), v);
    return k === Kind.MAP && !leftNames(f, e.caller).has(lower(v)) && byQuery(flow, f, e.caller, v, seen);
  });
}

/**
 * Each query's :var has a source: an input node coming in, a caller query's
 * output column, a caller flow's inputs or end-query output, a caller map's
 * left name or what flows into that map. Names are any case; :start_time ·
 * :end_time take the input duration. The queries looked at are this md's SQL
 * items and the fence's query nodes. An eqp bind filled by a caller query's
 * output alone is a flow between eqps, not taken yet — a map's left name may fill it.
 */
export function sources(flow, f) {
  const targets = new Set(f.ownQueries);
  for (const n of flow.nodes) if (n.kind === Kind.QUERY) targets.add(n.id);
  const out = [];
  for (const q of targets) {
    const fact = f.queries.get(q);
    if (!fact) continue;
    const seen = new Set();
    for (const v of fact.vars) {
      if (seen.has(lower(v))) continue;
      seen.add(lower(v));
      if (sourced(flow, f, q, v)) continue;
      out.push(
        isEqpBind(v) && byQuery(flow, f, q, v)
          ? error(Code.UNSUPPORTED_EQP_FLOW, `${q} 의 :${v} 를 caller 조회의 출력으로 채운다 — 설비 간 흐름은 아직 받지 않는다. 입력 ${v}([글]) 을 잇는다`)
          : error(Code.UNSOURCED_VAR, `${q} 의 :${v} 를 채울 입력이 없다`),
      );
    }
  }
  return out;
}

/**
 * On each map node of this md, its 식's names flow into it (MAP_SOURCE) and
 * each `$eqp[n].이름` is a name a node before it gives (MAP_SCOPE). A caller
 * whose columns did not read passes both. A line that does not read is
 * flow-maps' (the md is not registered).
 */
export function mapSources(flow, f) {
  const out = [];
  for (const item of f.mds.get(f.self)?.maps ?? []) {
    if (flow.kindOf(item.id) !== Kind.MAP) continue;
    const flowing = inflow(flow, f, item.id, new Set());
    const known = (name) => flowing.anything || flowing.names.has(lower(name));
    for (const r of item.rows) {
      const split = splitMapLine(r.text.trim());
      const expr = split ? parseExpr(split.expr) : null;
      if (!expr || expr.error) continue;
      for (const name of expr.names)
        if (!known(name)) out.push(error(Code.MAP_SOURCE, `식의 이름 ${name} 이 변환 노드 ${item.id} 로 흘러들지 않는다`, r.line));
      for (const { n, name } of expr.eqp)
        if (!known(name)) out.push(error(Code.MAP_SCOPE, `$eqp[${n}].${name} 은 앞 노드가 낸 이름이어야 한다`, r.line));
    }
  }
  return out;
}

function walk(at, next, path, onPath, done) {
  if (onPath.has(at)) {
    path.splice(0, path.indexOf(at));
    path.push(at);
    return true;
  }
  if (done.has(at)) return false;
  done.add(at);
  onPath.add(at);
  path.push(at);
  for (const to of next.get(at) ?? []) if (walk(to, next, path, onPath, done)) return true;
  onPath.delete(at);
  path.pop();
  return false;
}

// The node path of the first cycle along the edges (ending on its first node), or [].
function cycleOf(edges) {
  const next = new Map();
  for (const e of edges) next.set(e.caller, [...(next.get(e.caller) ?? []), e.callee]);
  const done = new Set();
  for (const start of next.keys()) {
    const path = [];
    if (walk(start, next, path, new Set(), done)) return path;
  }
  return [];
}

/** A cycle inside the flow — input nodes take no edge in, so they are in none. */
export function cycle(flow) {
  const c = cycleOf(flow.edges);
  return c.length ? [error(Code.CYCLE, `순환 ${c.join(" --> ")}`)] : [];
}

const flowOf = (name, own, f) => (name === f.self ? own : f.target(name)?.flow ?? QueryFlow.EMPTY);

function mdWalk(at, from, own, f, path, seen) {
  if (seen.has(at)) return false;
  seen.add(at);
  for (const n of flowOf(at, own, f).nodes) {
    const next = n.id;
    if (n.kind !== Kind.FLOW || f.target(next) === null || (next === at && at !== from)) continue;
    path.push(next);
    if (next === from || mdWalk(next, from, own, f, path, seen)) return true;
    path.pop();
  }
  return false;
}

// This flow and the mds its flow nodes reach, spread into edges between queries. Input edges are left out.
function joined(own, f) {
  const out = [];
  const seen = new Set();
  const todo = [f.self];
  while (todo.length) {
    const at = todo.shift();
    if (seen.has(at)) continue;
    seen.add(at);
    const fl = flowOf(at, own, f);
    for (const e of fl.edges) {
      if (kind(fl, e.caller) === Kind.INPUT) continue;
      let from = [e.caller];
      let to = [e.callee];
      const caller = kind(fl, e.caller) === Kind.FLOW ? f.target(e.caller) : null;
      const callee = kind(fl, e.callee) === Kind.FLOW ? f.target(e.callee) : null;
      if (caller) {
        from = caller.flow.ends(caller.queryIds);
        todo.push(caller.name);
      }
      if (callee) {
        to = callee.flow.starts(callee.queryIds);
        todo.push(callee.name);
      }
      for (const a of from) for (const b of to) out.push({ caller: a, callee: b, condition: e.condition, optional: false });
    }
  }
  return out;
}

/**
 * A cycle across mds: an md path through flow nodes back to this md, or a
 * cycle of the edges with flow nodes spread into that md's queries
 * (`X --> md` goes to its start queries, `md --> Y` leaves its end queries).
 */
export function mdCycle(flow, f) {
  const path = [f.self];
  if (mdWalk(f.self, f.self, flow, f, path, new Set())) return [error(Code.MD_CYCLE, `md 를 가로지르는 순환 ${path.join(" → ")}`)];
  if (cycleOf(flow.edges).length) return []; // the cycle inside is cycle()'s
  const c = cycleOf(joined(flow, f));
  return c.length ? [error(Code.MD_CYCLE, `md 를 가로지르는 순환 ${c.join(" --> ")}`)] : [];
}
