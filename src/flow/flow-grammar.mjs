// The flow fence's lines read as tokens — BE FlowGrammar.java. The grammar is
// a strict subset of mermaid flowchart and every regex is here. Meaning is
// not looked at: node kinds are flow-compiler's, checks are flow-rules'.
// No node imports: the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";

/** Node kinds by shape: input `id([글])` · query `id[글]` or `id` · flow `md[[글]]` · map `id{{글}}`. */
export const Kind = Object.freeze({ INPUT: "input", QUERY: "query", FLOW: "flow", MAP: "map" });

/**
 * A query id or md name (`-` for md names). A `-` sits between characters, one
 * at a time — `--` is mermaid's edge text, so `a-b-->c` reads as `a-b --> c`.
 */
export const ID = "[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*";
/** An input node's id — a bind name. */
export const VAR = "[A-Za-z][A-Za-z0-9_]*";

const HEADER = /^flowchart\s+(TD|LR)$/;
const VAR_ONLY = new RegExp(`^${VAR}$`);
const INPUT_NODE = new RegExp(`^(${ID})\\(\\[([^\\[\\]()]*)\\]\\)$`);
const FLOW_NODE = new RegExp(`^(${ID})\\[\\[([^\\[\\]]*)\\]\\]$`);
const MAP_NODE = new RegExp(`^(${ID})\\{\\{([^{}]*)\\}\\}$`);
const QUERY_NODE = new RegExp(`^(${ID})(?:\\[([^\\[\\]]*)\\])?$`);
// The shape written at an edge end — input · flow · query · map.
const SHAPE = "\\(\\[[^\\[\\]()]*\\]\\)|\\[\\[[^\\[\\]]*\\]\\]|\\[[^\\[\\]]*\\]|\\{\\{[^{}]*\\}\\}";
// 1 · 2 caller id · shape, 3 arrow, 4 condition, 5 · 6 callee id · shape.
const EDGE = new RegExp(`^(${ID})(${SHAPE})?\\s*(-->|-\\.->)\\s*(?:\\|([^|]*)\\|\\s*)?(${ID})(${SHAPE})?$`);
const ARROWS = /-\.->|-->/g;
// Mermaid arrows besides --> and -.->.
const OTHER_ARROW = /---|==>|<--|--[ox]|-\.-(?!>)|~~~/;
const COMPARE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=)\s*'([^']*)'$/;
const IN = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s*\(\s*('[^']*'(?:\s*,\s*'[^']*')*)\s*\)$/;
const QUOTED = /'([^']*)'/g;
// 1 id, 2 title. The id's form is SUBGRAPH_ID's to judge.
const SUBGRAPH = /^subgraph\s+([^\s[\]]+)\s*(?:\[([^[\]]*)\])?$/;
// No `-`: a subgraph id and an md name differ by how they are written.
const SUBGRAPH_ID = /^[a-z][a-z0-9_]*$/;
// At a node id's place these are mermaid's other grammar. `subgraph id [글]`
// and `end` lines are read before this list is looked at.
const RESERVED = new Set(["subgraph", "end", "style", "classdef", "class", "click", "linkstyle", "direction", "flowchart", "graph"]);
// Java's \R.
const LINE_BREAK = /\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u;

class Bad extends Error {
  constructor(error) {
    super(error.message);
    this.error = error;
  }
}

const error = (i, line, code, why) => flowError(i + 1, code, `\`${line}\`: ${why}`);
const bad = (i, line, code, why) => new Bad(error(i, line, code, why));
const text = (raw) => (raw != null && raw.trim() !== "" ? raw.trim() : null);

/**
 * A condition label: `컬럼 = '값'` · `컬럼 != '값'` · `컬럼 in ('a', 'b')` · `else`.
 * @returns {{op: "=" | "!=", column: string, value: string}
 *   | {op: "in", column: string, values: string[]} | {op: "else", column: null} | null}
 *   null outside the four
 */
export function condition(label) {
  const t = label != null ? label.trim() : "";
  if (t === "else") return { op: "else", column: null };
  const c = COMPARE.exec(t);
  if (c) return { op: c[2], column: c[1], value: c[3] };
  const m = IN.exec(t);
  if (m) return { op: "in", column: m[1], values: [...m[2].matchAll(QUOTED)].map((q) => q[1]) };
  return null;
}

/** A condition as the fence writes it — BE Condition.text(). */
export function conditionText(c) {
  if (c.op === "else") return "else";
  if (c.op === "in") return `${c.column} in (${c.values.map((v) => `'${v}'`).join(", ")})`;
  return `${c.column} ${c.op} '${c.value}'`;
}

// A head before an id's first `-` that is a mermaid word breaks the line in
// mermaid (end-x · style-x).
function reservedHead(i, line, id) {
  const head = id.split("-")[0].toLowerCase();
  if (RESERVED.has(head))
    throw bad(i, line, Code.RESERVED_WORD, `id ${id} 은 ${head} 로 시작한다 — mermaid 문법 낱말은 id 머리에 쓸 수 없다`);
}

// One node: a whole node line or one end of an edge line.
function node(i, line, written) {
  let m = INPUT_NODE.exec(written);
  if (m) {
    reservedHead(i, line, m[1]);
    if (!VAR_ONLY.test(m[1]))
      throw bad(i, line, Code.INPUT_ID, `입력 id ${m[1]} 는 바인드 이름([A-Za-z][A-Za-z0-9_]*)이다`);
    return { kind: "node", line: i + 1, id: m[1], shape: Kind.INPUT, text: text(m[2]) };
  }
  m = FLOW_NODE.exec(written);
  if (m) {
    reservedHead(i, line, m[1]);
    return { kind: "node", line: i + 1, id: m[1], shape: Kind.FLOW, text: text(m[2]) };
  }
  m = MAP_NODE.exec(written);
  if (m) {
    reservedHead(i, line, m[1]);
    return { kind: "node", line: i + 1, id: m[1], shape: Kind.MAP, text: text(m[2]) };
  }
  m = QUERY_NODE.exec(written);
  if (m) {
    reservedHead(i, line, m[1]);
    return { kind: "node", line: i + 1, id: m[1], shape: m[2] !== undefined ? Kind.QUERY : null, text: text(m[2]) };
  }
  throw bad(i, line, Code.NODE_SYNTAX, "노드는 `id` · `id[글]` · `id([글])` · `md[[글]]` · `id{{글}}` 이다");
}

// An edge end's id without a shape: no node token.
function idOnly(i, line, id) {
  reservedHead(i, line, id);
  return { kind: "node", line: i + 1, id, shape: null, text: null };
}

// A condition label's text, its "…" taken off (mermaid reads brackets inside quotes).
function label(raw) {
  const t = raw.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t;
}

function subgraph(i, line) {
  const m = SUBGRAPH.exec(line);
  if (!m) throw bad(i, line, Code.SUBGRAPH_ID, "subgraph 줄은 `subgraph id [글]` 이다");
  const id = m[1];
  if (!SUBGRAPH_ID.test(id))
    throw bad(i, line, Code.SUBGRAPH_ID, `subgraph id ${id} 는 [a-z][a-z0-9_]* 다 — \`-\` 는 md 이름에만 쓴다`);
  if (RESERVED.has(id)) throw bad(i, line, Code.RESERVED_WORD, `subgraph id ${id} 는 mermaid 문법 낱말이다`);
  const title = text(m[2]);
  if (title === null)
    throw bad(i, line, Code.SUBGRAPH_TITLE, `subgraph ${id} 의 글이 없다 — \`subgraph ${id} [글]\` 로 적는다`);
  return { kind: "subgraph", line: i + 1, id, title };
}

// One line's tokens; a comment gives none. An edge line with shapes gives a
// node token per shaped end before the edge token, caller first.
function tokens(i, line) {
  if (line.startsWith("%%{")) throw bad(i, line, Code.DIRECTIVE, "지시문 %%{…}%% 은 쓸 수 없다");
  if (line.startsWith("%%")) return [];
  const first = line.split(/[\s[(|-]/)[0].toLowerCase();
  if (first === "subgraph") {
    try {
      return [subgraph(i, line)];
    } catch (err) {
      // A subgraph line that does not read still opens one: its `end` closes it.
      if (err instanceof Bad) err.token = { kind: "subgraph", line: i + 1, id: null, title: null };
      throw err;
    }
  }
  if (line === "end") return [{ kind: "end", line: i + 1 }];
  if (RESERVED.has(first))
    throw bad(i, line, Code.RESERVED_WORD, `${first} 은 쓸 수 없다 — 노드 · 간선 · 주석 · subgraph · end 줄만 쓴다`);
  if (line.includes("&")) throw bad(i, line, Code.AMPERSAND, "& 는 쓸 수 없다 — 한 줄에 간선 하나다");
  const arrows = [...line.matchAll(ARROWS)].length;
  if (arrows > 1) throw bad(i, line, Code.CHAIN, "한 줄에 간선 하나다 — 체인은 줄을 나눈다");
  if (OTHER_ARROW.test(line.replace(ARROWS, " "))) throw bad(i, line, Code.ARROW, "화살표는 --> 와 -.-> 둘이다");
  if (arrows === 1) {
    const e = EDGE.exec(line);
    if (!e)
      throw bad(i, line, Code.EDGE_SYNTAX, "간선은 `a --> b` · `a -->|조건| b` · `a -.-> b` 이다 — 끝마다 모양을 같이 적어도 된다");
    let cond = null;
    if (e[4] !== undefined) {
      cond = condition(label(e[4]));
      if (cond === null)
        throw bad(i, line, Code.CONDITION_SYNTAX, "조건은 `컬럼 = '값'` · `컬럼 != '값'` · `컬럼 in ('a', 'b')` · `else` 넷이다");
    }
    const ends = [
      e[2] !== undefined ? node(i, line, e[1] + e[2]) : idOnly(i, line, e[1]),
      e[6] !== undefined ? node(i, line, e[5] + e[6]) : idOnly(i, line, e[5]),
    ].filter((t) => t.shape !== null);
    return [...ends, { kind: "edge", line: i + 1, caller: e[1], callee: e[5], condition: cond, optional: e[3] === "-.->" }];
  }
  return [node(i, line, line)];
}

/**
 * The fence text read line by line. A line that does not read is an error
 * and the next line is read.
 * @returns {{tokens: object[], errors: {line: number, code: string, message: string}[]}} both in written order
 */
export function lex(fence) {
  const lines = String(fence ?? "").split(LINE_BREAK);
  const out = [];
  const errors = [];
  let header = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === "") return;
    if (!header) {
      if (!HEADER.test(line)) errors.push(error(i, line, Code.HEADER, "첫 줄은 flowchart TD 또는 flowchart LR 이다"));
      header = true;
      return;
    }
    try {
      out.push(...tokens(i, line));
    } catch (err) {
      if (!(err instanceof Bad)) throw err;
      errors.push(err.error);
      if (err.token) out.push(err.token);
    }
  });
  return { tokens: out, errors };
}
