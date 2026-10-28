// Tokens woven into a flow — BE FlowCompiler.java, and the flow itself (BE
// QueryFlow.java, the parts the checks read). A node's kind is the first shape
// written for it; an id named without a shape is a query. Meaning is
// flow-rules'. No node imports: the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";
import { Kind, conditionText, lex } from "./flow-grammar.mjs";

/** An edge as the fence writes it: `caller -->|조건| callee` · `caller -.-> callee`. */
export const edgeText = (e) =>
  `${e.caller}${e.optional ? " -.->" : " -->"}${e.condition ? `|${conditionText(e.condition)}|` : ""} ${e.callee}`;

// A query and a map stand at the same place on an edge: a query's place.
const atQueryPlace = (kind) => kind === Kind.QUERY || kind === Kind.MAP;

/** An input node text's pieces — BE QueryFlow.piecesOf: cut at `·`, trimmed, the empty ones dropped. */
export const piecesOf = (text) => (text == null ? [] : String(text).split(/\s*·\s*/).map((p) => p.trim()).filter((p) => p !== ""));

/** The head of an input node text's option piece — BE QueryFlow.OPTION_HEAD. A space after it may be there or not. */
export const OPTION_HEAD = "선택:";

/** The piece is an option piece (starts with {@link OPTION_HEAD}). */
export const optionPiece = (piece) => piece != null && piece.startsWith(OPTION_HEAD);

/** One option piece's options: the rest after the head cut at `,`, trimmed, the empty ones dropped. */
export const optionsIn = (piece) => piece.slice(OPTION_HEAD.length).split(",").map((p) => p.trim()).filter((p) => p !== "");

/** An input node text's options — the first option piece after the first piece ({@link optionsIn}), written order; [] without one. */
export function optionsOf(text) {
  const piece = piecesOf(text).slice(1).find(optionPiece);
  return piece === undefined ? [] : optionsIn(piece);
}

/**
 * The graph a fence writes. Edges belong to their caller (the side that gives the value).
 * nodes: first-seen order, one per id ({id, kind, title, subgraph}); edges:
 * written order ({caller, callee, condition, optional}); lines: id → the fence
 * line its shape was written on (the line it was first named on without one).
 */
export class QueryFlow {
  constructor(nodes = [], edges = [], lines = new Map()) {
    const byId = new Map();
    for (const n of nodes) {
      if (byId.has(n.id)) continue;
      const title = n.title != null && n.title.trim() !== "" ? n.title.trim() : null;
      byId.set(n.id, { id: n.id, kind: n.kind, title, subgraph: n.subgraph ?? null });
    }
    this.nodes = [...byId.values()];
    this.edges = [...edges];
    this.lines = lines;
  }

  /** The fence line the node is written on, 0 when not known. */
  lineOf(id) {
    return this.lines.get(id) ?? 0;
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

  /** An input node's options ({@link optionsOf} of its text); [] for another node or none. */
  optionsOf(id) {
    const n = this.node(id);
    return n?.kind === Kind.INPUT ? optionsOf(n.title) : [];
  }

  /** The id is an input node with options — BE QueryFlow.choiceInput. */
  choiceInput(id) {
    return this.optionsOf(id).length > 0;
  }

  /** Flow nodes that are an edge's caller — the flows that lead. */
  leading() {
    return this.nodes.filter((n) => n.kind === Kind.FLOW && this.edgesFrom(n.id).length > 0).map((n) => n.id);
  }

  hasCaller(id) {
    return this.edges.some((e) => e.callee === id);
  }

  /** A query or map caller points at the id, or at the subgraph it sits in. */
  hasQueryCaller(id) {
    if (this.edgesInto(id).some((e) => atQueryPlace(this.kindOf(e.caller)))) return true;
    const sub = this.node(id)?.subgraph ?? null;
    return sub !== null && this.edgesInto(sub).some((e) => atQueryPlace(this.kindOf(e.caller)));
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
    return new QueryFlow(inside, this.edges.filter((e) => ids.has(e.caller) && ids.has(e.callee)), this.lines);
  }

  edgesFrom(caller) {
    return this.edges.filter((e) => e.caller === caller);
  }

  edgesInto(callee) {
    return this.edges.filter((e) => e.callee === callee);
  }

  /** An md's start queries: its query ids and query · map nodes without a query · map caller. */
  starts(queryIds) {
    const out = new Set(queryIds);
    for (const n of this.nodes) if (atQueryPlace(n.kind)) out.add(n.id);
    return [...out].filter((id) => !this.hasQueryCaller(id));
  }

  /** An md's end queries: its query ids and query · map nodes without an edge out. */
  ends(queryIds) {
    const out = new Set(queryIds);
    for (const n of this.nodes) if (atQueryPlace(n.kind)) out.add(n.id);
    return [...out].filter((id) => this.edgesFrom(id).length === 0);
  }
}

QueryFlow.EMPTY = new QueryFlow();

const NAME = { [Kind.INPUT]: "입력 id([글])", [Kind.QUERY]: "조회 id[글]", [Kind.FLOW]: "흐름 md[[글]]", [Kind.MAP]: "변환 id{{글}}" };

// An input node text's option pieces checked — BE FlowCompiler.options: one
// piece at most, one option or more, none twice, none with `'`. The first
// piece (the name) is not looked at.
function options(t) {
  const found = piecesOf(t.text).slice(1).filter(optionPiece);
  const out = [];
  const head = `입력 ${t.id}: `;
  if (found.length > 1) out.push(flowError(t.line, Code.INPUT_OPTION, `${head}${OPTION_HEAD} 토막이 ${found.length} 개다 — 하나만 쓴다`));
  if (found.length === 0) return out;
  const list = optionsIn(found[0]);
  if (list.length === 0) out.push(flowError(t.line, Code.INPUT_OPTION, `${head}선택지가 비었다 — \`${OPTION_HEAD} a, b\` 로 적는다`));
  const seen = new Set();
  for (const option of list) {
    if (option.includes("'")) out.push(flowError(t.line, Code.INPUT_OPTION, `${head}선택지 ${option} 에 ' 가 든다`));
    if (seen.has(option)) out.push(flowError(t.line, Code.INPUT_OPTION, `${head}선택지 ${option} 가 둘이다`));
    seen.add(option);
  }
  return out;
}

/**
 * Tokens woven into a flow. Nodes in first-seen order, an edge's ends
 * counted. `subgraph id [글]` becomes the flow node `id`, and a node first
 * seen inside it sits in it; the subgraph id itself sits in none. A subgraph
 * token with id null (its line did not read) only takes its `end`.
 * @returns {{flow: QueryFlow, errors: object[]}} the flow woven as far as it reads
 */
export function compileTokens(tokens) {
  const kinds = new Map(); // id -> first shape, null when only named
  const titles = new Map();
  const shapedAt = new Map();
  const seenAt = new Map(); // id -> the line it was first named on
  const member = new Map(); // node id -> the subgraph it was first seen in
  const subgraphAt = new Map(); // subgraph id -> its line
  let open = null;
  let nested = 0;
  let unread = 0; // subgraphs opened outside any subgraph by a line that did not read (id null)
  const edges = [];
  const errors = [];
  for (const t of tokens) {
    if (t.kind === "subgraph") {
      if (open !== null) {
        nested++;
        if (t.id !== null)
          errors.push(flowError(t.line, Code.SUBGRAPH_NESTED, `subgraph ${t.id}: subgraph ${open} 안에 열었다 — subgraph 안에 subgraph 는 쓸 수 없다`));
        continue;
      }
      if (t.id === null) {
        unread++;
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
      else if (open !== null) open = null;
      else if (unread > 0) unread--;
      else errors.push(flowError(t.line, Code.SUBGRAPH_END, "end: 닫을 subgraph 가 없다"));
    } else if (t.kind === "node") {
      if (!seenAt.has(t.id)) seenAt.set(t.id, t.line);
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
      if (t.shape === Kind.INPUT && t.text !== null && !titles.has(t.id)) errors.push(...options(t));
      if (t.text !== null && !titles.has(t.id)) titles.set(t.id, t.text);
    } else {
      if (open !== null)
        for (const end of [t.caller, t.callee]) if (!kinds.has(end) && end !== open) member.set(end, open);
      for (const end of [t.caller, t.callee]) if (!seenAt.has(end)) seenAt.set(end, t.line);
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
  const lines = new Map([...kinds.keys()].map((id) => [id, shapedAt.get(id) ?? seenAt.get(id) ?? 0]));
  return { flow: new QueryFlow(nodes, edges, lines), errors };
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
