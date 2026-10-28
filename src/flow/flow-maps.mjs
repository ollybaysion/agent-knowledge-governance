// Map nodes and their `### id — 제목` map items, and the items' map fence
// lines — BE FlowMaps.java: the checks that look at one md alone. Whether a
// 식's names flow in is flow-rules'. Every error's line is the md's. No node
// imports: the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";
import { Kind } from "./flow-grammar.mjs";
import { parseExpr, splitMapLine } from "./map-expr.mjs";

const lower = (s) => s.toLowerCase();

/**
 * One map item's lines: `이름 = 식` each (MAP_LINE), a left name once in any
 * case (MAP_DUP), a 식 that reads (MAP_EXPR). Blank lines are skipped.
 * @param {{line: number, text: string}[]} rows the map fence's lines, md lines
 */
export function mapLineErrors(rows) {
  const out = [];
  const lefts = new Set();
  for (const r of rows) {
    const text = r.text.trim();
    if (text === "") continue;
    const split = splitMapLine(text);
    if (!split) {
      out.push(flowError(r.line, Code.MAP_LINE, `map 줄은 '이름 = 식' 꼴이다: ${text}`));
      continue;
    }
    if (lefts.has(lower(split.name))) out.push(flowError(r.line, Code.MAP_DUP, `map 왼쪽 이름 ${split.name} 이 두 번 나온다`));
    lefts.add(lower(split.name));
    const expr = parseExpr(split.expr);
    if (expr.error) out.push(flowError(r.line, Code.MAP_EXPR, `식을 읽을 수 없다(${expr.error}): ${text}`));
  }
  return out;
}

/**
 * Map nodes and map items paired, and each map item's lines. A map node
 * points at a map item of this md (MAP_ITEM; an SQL item is MAP_SHAPE) and
 * has an edge in (MAP_NO_SOURCE — an edge into the subgraph it starts counts)
 * and an edge out (MAP_ALONE); a query node is no map item (MAP_SHAPE); a
 * map item has one fence, a map one (MAP_FENCE).
 * @param {import("./flow-compiler.mjs").QueryFlow} flow
 * @param {number} fenceLine the md line the flow fence opens on (0 without one)
 * @param {{id: string, line: number, ok: boolean, rows: object[]}[]} maps the map items, md lines
 * @param {Set<string>} sqlIds this md's SQL item ids
 * @returns {object[]} errors, md lines
 */
export function mapErrors(flow, fenceLine, maps, sqlIds) {
  const out = [];
  const mapIds = new Set(maps.map((m) => m.id));
  for (const n of flow.nodes) {
    const at = fenceLine + flow.lineOf(n.id);
    if (n.kind === Kind.MAP) {
      if (sqlIds.has(n.id)) out.push(flowError(at, Code.MAP_SHAPE, `${n.id} 는 sql 항목이다. 노드는 [글] 로 적는다`));
      else if (!mapIds.has(n.id)) out.push(flowError(at, Code.MAP_ITEM, `변환 노드 ${n.id} 를 가리키는 '### ${n.id}' 항목이 없다`));
      if (!takesValues(flow, n.id)) out.push(flowError(at, Code.MAP_NO_SOURCE, `변환 노드 ${n.id} 로 들어오는 간선이 없다`));
      if (!flow.edgesFrom(n.id).length) out.push(flowError(at, Code.MAP_ALONE, `변환 노드 ${n.id} 에서 나가는 간선이 없다`));
    } else if (n.kind === Kind.QUERY && mapIds.has(n.id)) out.push(flowError(at, Code.MAP_SHAPE, `${n.id} 는 map 항목이다. 노드는 {{글}} 로 적는다`));
  }
  for (const m of maps) {
    if (!m.ok) out.push(flowError(m.line, Code.MAP_FENCE, `항목 ${m.id} 에는 map 펜스가 하나 있어야 한다`));
    else out.push(...mapLineErrors(m.rows));
  }
  return out;
}

/**
 * The first assigning `=` of a line — BE FlowMaps.assign: the `=` of `==` ·
 * `!=` · `<=` · `>=` is no assignment. A ```chart fence line splits at it.
 * @returns {number} its index, -1 without one
 */
export function assign(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "=") continue;
    if (text[i + 1] === "=") {
      i++;
      continue;
    }
    if ("!<>=".includes(text[i - 1] ?? "")) continue;
    return i;
  }
  return -1;
}

// An edge comes into the node, or into the subgraph it starts.
function takesValues(flow, id) {
  if (flow.edgesInto(id).length) return true;
  const sub = flow.node(id)?.subgraph ?? null;
  return sub !== null && flow.subgraph(sub).starts([]).includes(id) && flow.edgesInto(sub).length > 0;
}
