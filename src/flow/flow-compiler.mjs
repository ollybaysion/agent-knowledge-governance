// Tokens woven into a flow — BE FlowCompiler.java, and the flow itself (BE
// QueryFlow.java, the parts the checks read). A node's kind is the first shape
// written for it; an id named without a shape is a query. Meaning is
// flow-rules'. No node imports: the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";
import { Kind, conditionText, lex } from "./flow-grammar.mjs";

/** An edge as the fence writes it: `caller -->|조건| callee` · `caller -.-> callee`. */
export const edgeText = (e) =>
  `${e.caller}${e.optional ? " -.->" : " -->"}${e.condition ? `|${conditionText(e.condition)}|` : ""} ${e.callee}`;

/**
 * The graph a fence writes. Edges belong to their caller (the side that gives the value).
 * nodes: first-seen order, one per id ({id, kind, title, subgraph}); edges:
 * written order ({caller, callee, condition, optional}).
 */
export class QueryFlow {
  constructor(nodes = [], edges = []) {
    const byId = new Map();
    for (const n of nodes) {
      if (byId.has(n.id)) continue;
      const title = n.title != null && n.title.trim() !== "" ? n.title.trim() : null;
      byId.set(n.id, { id: n.id, kind: n.kind, title, subgraph: n.subgraph ?? null });
    }
    this.nodes = [...byId.values()];
    this.edges = [...edges];
  }

  isEmpty() {
    return this.nodes.length === 0 && this.edges.length === 0;
  }

  ids() {
    return this.nodes.map((n) => n.id);
  }

  node(id) {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  /** The node's kind, null without the node. */
  kindOf(id) {
    return this.node(id)?.kind ?? null;
  }

  inputs() {
    return this.nodes.filter((n) => n.kind === Kind.INPUT);
  }

  /** Flow nodes that are an edge's caller — the flows that lead. */
  leading() {
    return this.nodes.filter((n) => n.kind === Kind.FLOW && this.edgesFrom(n.id).length > 0).map((n) => n.id);
  }

  hasCaller(id) {
    return this.edges.some((e) => e.callee === id);
  }

  /** A query caller points at the id, or at the subgraph it sits in. */
  hasQueryCaller(id) {
    if (this.edgesInto(id).some((e) => this.kindOf(e.caller) === Kind.QUERY)) return true;
    const sub = this.node(id)?.subgraph ?? null;
    return sub !== null && this.edgesInto(sub).some((e) => this.kindOf(e.caller) === Kind.QUERY);
  }

  /** The subgraph ids nodes sit in, first-seen order. */
  subgraphIds() {
    return [...new Set(this.nodes.map((n) => n.subgraph).filter((s) => s !== null))];
  }

  isSubgraph(id) {
    return id != null && this.nodes.some((n) => n.subgraph === id);
  }

  /** The subgraph's nodes and the edges with both ends among them. */
  subgraph(id) {
    const inside = this.nodes.filter((n) => id != null && n.subgraph === id);
    const ids = new Set(inside.map((n) => n.id));
    return new QueryFlow(inside, this.edges.filter((e) => ids.has(e.caller) && ids.has(e.callee)));
  }

  edgesFrom(caller) {
    return this.edges.filter((e) => e.caller === caller);
  }

  edgesInto(callee) {
    return this.edges.filter((e) => e.callee === callee);
  }

  /** An md's start queries: its query ids and query nodes without a query caller. */
  starts(queryIds) {
    const out = new Set(queryIds);
    for (const n of this.nodes) if (n.kind === Kind.QUERY) out.add(n.id);
    return [...out].filter((id) => !this.hasQueryCaller(id));
  }

  /** An md's end queries: its query ids and query nodes without an edge out. */
  ends(queryIds) {
    const out = new Set(queryIds);
    for (const n of this.nodes) if (n.kind === Kind.QUERY) out.add(n.id);
    return [...out].filter((id) => this.edgesFrom(id).length === 0);
  }
}

QueryFlow.EMPTY = new QueryFlow();

const NAME = { [Kind.INPUT]: "입력 id([글])", [Kind.QUERY]: "조회 id[글]", [Kind.FLOW]: "흐름 md[[글]]" };

/**
 * Tokens woven into a flow. Nodes in first-seen order, an edge's ends
 * counted. `subgraph id [글]` becomes the flow node `id`, and a node first
 * seen inside it sits in it; the subgraph id itself sits in none.
 * @returns {{flow: QueryFlow, errors: object[]}} the flow woven as far as it reads
 */
export function compileTokens(tokens) {
  const kinds = new Map(); // id -> first shape, null when only named
  const titles = new Map();
  const shapedAt = new Map();
  const member = new Map(); // node id -> the subgraph it was first seen in
  const subgraphAt = new Map(); // subgraph id -> its line
  let open = null;
  let nested = 0;
  const edges = [];
  const errors = [];
  for (const t of tokens) {
    if (t.kind === "subgraph") {
      if (open !== null) {
        nested++;
        errors.push(flowError(t.line, Code.SUBGRAPH_NESTED, `subgraph ${t.id}: subgraph ${open} 안에 열었다 — subgraph 안에 subgraph 는 쓸 수 없다`));
        continue;
      }
      const had = kinds.get(t.id) ?? null;
      if (subgraphAt.has(t.id))
        errors.push(flowError(t.line, Code.SUBGRAPH_ID_CLASH, `subgraph ${t.id}: ${subgraphAt.get(t.id)} 번째 줄의 subgraph 와 id 가 겹친다`));
      else if (had !== null && had !== Kind.FLOW)
        errors.push(flowError(t.line, Code.SUBGRAPH_ID_CLASH, `subgraph ${t.id}: ${shapedAt.get(t.id)} 번째 줄의 ${NAME[had]} 와 id 가 겹친다`));
      else {
        subgraphAt.set(t.id, t.line);
        kinds.set(t.id, Kind.FLOW);
        if (!shapedAt.has(t.id)) shapedAt.set(t.id, t.line);
        titles.set(t.id, t.title);
      }
      open = t.id;
    } else if (t.kind === "end") {
      if (nested > 0) nested--;
      else if (open === null) errors.push(flowError(t.line, Code.SUBGRAPH_END, "end: 닫을 subgraph 가 없다"));
      else open = null;
    } else if (t.kind === "node") {
      if (open !== null) {
        if (t.id === open) {
          errors.push(flowError(t.line, Code.SELF_FLOW, `subgraph ${open} 안에서 ${open} 를 노드로 적었다(순환)`));
          continue;
        }
        const inside = member.get(t.id) ?? null;
        if (kinds.has(t.id) && open !== inside)
          errors.push(flowError(t.line, Code.SUBGRAPH_MEMBER, `노드 ${t.id}: ${inside !== null ? `subgraph ${inside} 에 든 노드다` : "subgraph 밖에서 먼저 나온 노드다"} — 한 노드는 처음 나온 subgraph 하나에 든다`));
        else if (!member.has(t.id)) member.set(t.id, open);
      }
      if (subgraphAt.has(t.id) && t.shape !== null && t.shape !== Kind.FLOW) {
        errors.push(flowError(t.line, Code.SUBGRAPH_ID_CLASH, `노드 ${t.id}: ${subgraphAt.get(t.id)} 번째 줄의 subgraph 와 id 가 겹친다`));
        continue;
      }
      if (!kinds.has(t.id)) kinds.set(t.id, null);
      if (t.shape !== null) {
        const had = kinds.get(t.id);
        if (had === null) {
          kinds.set(t.id, t.shape);
          shapedAt.set(t.id, t.line);
        } else if (had !== t.shape)
          errors.push(flowError(t.line, Code.SHAPE_CONFLICT, `노드 ${t.id} 의 모양이 둘이다 — ${shapedAt.get(t.id)} 번째 줄은 ${NAME[had]}, 이 줄은 ${NAME[t.shape]}`));
      }
      if (t.text !== null && !titles.has(t.id)) titles.set(t.id, t.text);
    } else {
      if (open !== null)
        for (const end of [t.caller, t.callee]) if (!kinds.has(end) && end !== open) member.set(end, open);
      if (!kinds.has(t.caller)) kinds.set(t.caller, null);
      if (!kinds.has(t.callee)) kinds.set(t.callee, null);
      edges.push({ caller: t.caller, callee: t.callee, condition: t.condition, optional: t.optional });
    }
  }
  if (open !== null)
    errors.push(flowError(subgraphAt.get(open) ?? 0, Code.SUBGRAPH_UNCLOSED, `subgraph ${open}: end 로 닫지 않았다`));
  for (const id of subgraphAt.keys()) member.delete(id);
  const used = new Set(member.values());
  for (const [id, line] of subgraphAt) if (!used.has(id)) errors.push(flowError(line, Code.SUBGRAPH_EMPTY, `subgraph ${id}: 든 노드가 없다`));
  const nodes = [...kinds].map(([id, kind]) => ({ id, kind: kind ?? Kind.QUERY, title: titles.get(id) ?? null, subgraph: member.get(id) ?? null }));
  return { flow: new QueryFlow(nodes, edges), errors };
}

/**
 * The fence text read (flow-grammar lex) and woven. Errors: the grammar's
 * and the weaving's, by line.
 * @returns {{flow: QueryFlow, errors: {line: number, code: string, message: string}[]}}
 */
export function compile(fence) {
  const lexed = lex(fence);
  const woven = compileTokens(lexed.tokens);
  const errors = [...lexed.errors, ...woven.errors].sort((a, b) => a.line - b.line);
  return { flow: woven.flow, errors };
}
