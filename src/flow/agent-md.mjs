// An agent md (a domain-skill or domain document's markdown) read the way BE
// registers it — the `## 데이터` part of SkillMarkdownTool.java and
// SkillValidateTool.java — and a set of them checked the way BE loads them
// (QueryFlowTool.rejections, CheckFlow.check). No node imports: the
// dashboard runs this file as it is.
import { LANG as CHART, readChart } from "./chart-fence.mjs";
import { Code, errorReport, flowError, mdLine } from "./flow-error.mjs";
import { QueryFlow, compile } from "./flow-compiler.mjs";
import { Kind } from "./flow-grammar.mjs";
import { mapErrors } from "./flow-maps.mjs";
import { check, facts, md, subgraphsOf } from "./flow-rules.mjs";
import { columnsOf } from "../sql-bind.mjs";

export { mdLine };

/** BE's closing words of an input rejection — where an input is written. */
export const INPUT_HINT = "입력은 흐름 펜스의 `id([글])` 노드로 적는다";
/** The common md BE's check-flow always adds. */
export const COMMON = "eqp-scope";
export const COMMON_MD =
  "# 설비 범위\n\n## 한 줄 설명\n\n라인 · 설비 · 기간 입력을 모은다. 다른 md 가 흐름 노드 `eqp-scope[[설비 범위]]` 로 앞에 세운다.\n\n" +
  "## 데이터\n\n```mermaid\nflowchart TD\n  line([라인])\n  eqp_id([설비])\n  duration([기간])\n```\n";

const DATA = "데이터";
const ID_TITLE = /^([A-Za-z][A-Za-z0-9_]*)\s+[—–-]\s+(.+)$/;
const GROUP = /^(.*?)\s+@([A-Za-z][A-Za-z0-9_]*)\s*$/;
const ASCII_TITLE = /^[A-Za-z0-9_ ]+$/;
const NEED_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/;
const LINE_BREAK = /\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u;
// BE Query.varsOf: literals blanked, then every :name once, first-seen order.
const BIND_VAR = /:([A-Za-z][A-Za-z0-9_]*)/g;

// A reason not to register the md; `errors` the chart fence errors it carries (BE FlowError.Rejected.chart).
class Reject extends Error {
  constructor(message, errors = []) {
    super(message);
    this.errors = errors;
  }
}

/** BE FlowError.Rejected.chart's reason: `이름: 그래프 펜스 오류로 거부 — 오류; 오류`. */
const chartReject = (name, errors) => new Reject(`${name}: 그래프 펜스 오류로 거부 — ${errors.map(errorReport).join("; ")}`, errors);

const normalize = (title) => title.trim().replace(/[?？:：\s]+$/u, "").trim();

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return a === b ? null : lines.slice(a, b).join("\n").trimEnd();
}

/** The `:name` binds of a statement as BE's Query.varsOf reads them. */
export function varsOf(sql) {
  if (!sql || !sql.trim()) return [];
  return [...new Set([...sql.replace(/'[^']*'/g, "''").matchAll(BIND_VAR)].map((m) => m[1]))];
}

// Every heading opens a section; a heading inside a fence is text. `from` is
// the 0-based line of the body's first line.
function sections(text) {
  const first = { level: 0, title: "", from: 0, body: [] };
  const out = [first];
  let current = first;
  let fence = null;
  String(text ?? "").split(LINE_BREAK).forEach((line, i) => {
    const f = FENCE.exec(line);
    if (fence === null && f) fence = f[1];
    else if (fence !== null && line.trim().startsWith(fence)) fence = null;
    else if (fence === null) {
      const h = HEADING.exec(line);
      if (h) {
        current = { level: h[1].length, title: h[2].trim(), from: i + 1, body: [] };
        out.push(current);
        return;
      }
    }
    current.body.push(line);
  });
  return out;
}

const nextAtOrAbove = (list, from, max) => {
  for (let i = from; i < list.length; i++) if (list[i].level <= max) return i;
  return list.length;
};

// The ```mermaid fences of a body: each one's 0-based body line and inner lines.
function mermaidFences(body) {
  const fences = [];
  let open = null;
  let lines = null;
  body.forEach((line, i) => {
    const f = FENCE.exec(line);
    if (open === null && f) {
      open = f[1];
      lines = [];
      if (f[2].toLowerCase() === "mermaid") fences.push({ at: i, lines });
    } else if (open !== null && line.trim().startsWith(open)) open = null;
    else if (open !== null) lines.push(line);
  });
  return { fences, unclosed: open !== null };
}

function idAndTitle(name, heading) {
  const m = ID_TITLE.exec(heading);
  if (m) return [m[1], m[2].trim()];
  if (ASCII_TITLE.test(heading)) {
    const slug = heading.trim().toLowerCase().replace(/\s+/g, "_");
    if (NEED_ID.test(slug)) return [slug, heading.trim()];
  }
  throw new Reject(`${name}: 데이터 항목에 id 가 없습니다 — \`### id — ${heading}\` 처럼 ascii id 를 제목 앞에 적으세요`);
}

// The fences of an item's body ({text, line} rows): each one's language,
// opening md line and inner rows, and whether the last is left open.
function itemFences(rows) {
  const fences = [];
  let open = null;
  for (const row of rows) {
    const f = FENCE.exec(row.text);
    if (open === null && f) {
      open = f[1];
      fences.push({ lang: f[2].toLowerCase(), line: row.line, rows: [] });
    } else if (open !== null && row.text.trim().startsWith(open)) open = null;
    else if (open !== null) fences[fences.length - 1].rows.push(row);
  }
  return { fences, unclosed: open !== null };
}

// One data item: a map item when a fence of it is ```map, or when a map node
// points at it and it has no fence; else an SQL item. An old ASK item
// (```ask or no fence) and the group mark @이름 are refused. Beside its
// statement an SQL item may have one ```chart fence (chart-fence.mjs): two
// are CHART_DUPLICATE, its errors refuse the md, an unchecked one's warning
// goes into `warnings`.
function need(name, heading, at, rows, mapNodes, warnings) {
  const g = GROUP.exec(heading);
  if (g) throw new Reject(`${name}: 항목 \`${heading}\` 의 묶음 표시 @${g[2]} 는 쓰지 않는다 — ${INPUT_HINT}`);
  const [id, title] = idAndTitle(name, heading);
  const { fences, unclosed } = itemFences(rows);
  if (unclosed) throw new Reject(`${name} needs[${id}]: 펜스가 닫히지 않았습니다`);
  if (fences.some((f) => f.lang === "map") || (!fences.length && mapNodes.has(id))) {
    const ok = fences.length === 1;
    return { kind: Kind.MAP, id, title, line: at, ok, rows: ok ? fences[0].rows : [] };
  }
  const statements = fences.filter((f) => f.lang !== CHART);
  const charts = fences.filter((f) => f.lang === CHART);
  if (statements.length > 1) throw new Reject(`${name} needs[${id}]: 펜스가 둘입니다 — 항목 하나에 문장 하나다`);
  const lang = statements[0]?.lang ?? null;
  if (!statements.length || lang === "ask")
    throw new Reject(`${name} needs[${id}]: ${!statements.length ? "sql 펜스가 없다" : "ask 펜스는 쓰지 않는다"} — ${INPUT_HINT}`);
  if (lang !== "sql") throw new Reject(`${name} needs[${id}]: 펜스 언어는 sql 입니다 — \`\`\`${lang}`);
  if (charts.length > 1)
    throw chartReject(
      name,
      charts.slice(1).map((c) => flowError(c.line, Code.CHART_DUPLICATE, `항목 ${id} 에 chart 펜스가 ${charts.length} 개다 — 하나만 둔다`)),
    );
  const sql = trimBlank(statements[0].rows.map((r) => r.text));
  const query = { kind: Kind.QUERY, id, title, sql, vars: varsOf(sql) };
  if (!charts.length) return query;
  const read = readChart(query, charts[0], columnsOf(sql));
  if (read.warning) warnings.push(read.warning);
  if (read.errors.length) throw chartReject(name, read.errors);
  return { ...query, chart: read.chart };
}

// A section's body as {text, line} rows, line 1-based in the md.
const rowsOf = (s) => s.body.map((text, j) => ({ text, line: s.from + 1 + j }));

function needs(name, head, under, mapNodes, warnings) {
  const out = [];
  under.forEach((s, i) => {
    if (s.level !== 3) {
      if (!out.length) throw new Reject(`${name}: ## ${head.title} 아래 항목은 ### 로 적습니다 — ${"#".repeat(s.level)} ${s.title}`);
      return; // a #### inside an item is that item's body already
    }
    const rows = rowsOf(s);
    for (const deeper of under.slice(i + 1, nextAtOrAbove(under, i + 1, 3)))
      rows.push({ text: `${"#".repeat(deeper.level)} ${deeper.title}`, line: deeper.from }, ...rowsOf(deeper));
    out.push(need(name, s.title, s.from, rows, mapNodes, warnings));
  });
  return out;
}

/**
 * An agent md as BE reads it to register it.
 * - queries: the SQL items, written order ({id, title, sql, vars}, and `chart`
 *   — chart-fence readChart's — when the item has a ```chart fence).
 * - maps: the map items, written order ({id, title, line, rows: {line, text}[]}):
 *   line is the `###` line, rows the map fence's lines, md lines.
 * - fence: the flow fence — the first ```mermaid fence under `## 데이터` before
 *   its first `###` — with `line`, the md line (1-based) it opens on; null without one.
 * - flowErrors: the fence's grammar errors (flow-compiler), line = fence line,
 *   and the map checks of this md alone (flow-maps), line = md line; md line order.
 * - flow: the compiled flow, read as far as it reads.
 * - rejection: BE's reason for not registering the md (its first one), null when it registers.
 *   A second `## 데이터` section is the first reason checked.
 * - chartErrors: the CHART_* errors of a chart fence rejection, md lines; [] for another reason.
 * - warnings: a CHART_COLUMN warning at each chart fence whose columns went
 *   unchecked (`select *`), md lines, items read so far.
 * @param {string} name the md name — the document id
 */
export function readAgentMd(name, markdown) {
  const secs = sections(markdown);
  let fence = null;
  for (const s of secs) {
    if (fence || s.level !== 2 || normalize(s.title) !== DATA) continue;
    const { fences } = mermaidFences(s.body);
    if (fences.length) fence = { line: s.from + fences[0].at + 1, text: fences[0].lines.join("\n") };
  }
  const compiled = fence ? compile(fence.text) : { flow: QueryFlow.EMPTY, errors: [] };
  const out = { name, queries: [], maps: [], fence, flowErrors: compiled.errors, flow: compiled.flow, rejection: null, chartErrors: [], warnings: [] };
  const mapNodes = new Set(compiled.flow.nodes.filter((n) => n.kind === Kind.MAP).map((n) => n.id));
  try {
    const data = secs.filter((s) => s.level === 2 && normalize(s.title) === DATA);
    if (data.length > 1)
      throw new Reject(`${name}: ## ${DATA} 절은 하나다, ${data.length} 개다 — ${data.map((s) => s.from).join(" · ")} 번째 줄`);
    secs.forEach((s, i) => {
      if (s.level !== 2 || normalize(s.title) !== DATA) return;
      for (const item of needs(name, s, secs.slice(i + 1, nextAtOrAbove(secs, i + 1, 2)), mapNodes, out.warnings)) {
        const { kind, ...rest } = item;
        if (kind === Kind.QUERY) out.queries.push(rest);
        else out.maps.push(rest);
      }
      const base = fence?.line ?? 0;
      const maps = mapErrors(compiled.flow, base, out.maps, new Set(out.queries.map((q) => q.id)));
      out.flowErrors = [...out.flowErrors, ...maps].sort((a, b) => mdLine(a, base) - mdLine(b, base));
      for (const m of out.maps) delete m.ok;
      const { fences, unclosed } = mermaidFences(s.body);
      if (unclosed) throw new Reject(`${name}: 조회 흐름 오류로 거부 — mermaid 펜스가 닫히지 않았다`);
      if (fences.length > 1) throw new Reject(`${name}: 조회 흐름 오류로 거부 — mermaid 펜스는 하나다, ${fences.length} 개다`);
      if ((fences.length && compiled.errors.length) || maps.length)
        throw new Reject(`${name}: 조회 흐름 오류로 거부 — ${out.flowErrors.map(errorReport).join("; ")}`);
      if (fences.length) return;
      const q = out.queries.find((x) => x.vars.length);
      if (q) throw new Reject(`${name} needs[${q.id}]: :${q.vars[0]} 를 채울 입력을 적은 펜스가 없다 — ${INPUT_HINT}`);
    });
    const empty = out.queries.find((q) => q.sql === null);
    if (empty) throw new Reject(`${name} needs[${empty.id}]: sql 이 없습니다`);
  } catch (err) {
    if (!(err instanceof Reject)) throw err;
    out.rejection = err.message;
    out.chartErrors = err.errors;
  }
  return out;
}

/**
 * Each registered md's flow errors against all of them, one pass — BE
 * QueryFlowTool.errors. The facts: every md's queries (first id wins),
 * names and subgraphs. Output columns are read with columnsOf, as BE's
 * check-flow reads them.
 * @param {ReturnType<readAgentMd>[]} specs registered mds, in order (no rejection)
 * @returns {Map<string, object[]>} md name → its errors, specs order
 */
export function flowErrors(specs) {
  const pool = new Map();
  for (const s of specs)
    for (const q of s.queries) if (!pool.has(q.id)) pool.set(q.id, { id: q.id, vars: q.vars, columns: columnsOf(q.sql) });
  const mds = new Map();
  for (const s of specs) if (!mds.has(s.name)) mds.set(s.name, md(s.name, s.flow, s.queries.map((q) => q.id), s.maps));
  const subgraphs = subgraphsOf(mds.values());
  const out = new Map();
  for (const s of specs) {
    if (s.flow.isEmpty()) continue;
    const errors = check(s.flow, facts(s.name, s.queries.map((q) => q.id), pool, mds, subgraphs));
    if (errors.length) out.set(s.name, errors);
  }
  return out;
}

/**
 * The mds BE leaves out at load and their errors — BE QueryFlowTool.rejections:
 * {@link flowErrors}, the mds with errors taken out, again until none goes.
 * An md pointing at one taken out goes in the next round.
 * @returns {Map<string, object[]>} md name → its errors, in the order they went
 */
export function flowRejections(specs) {
  const out = new Map();
  let kept = specs;
  for (;;) {
    const errors = flowErrors(kept);
    if (!errors.size) return out;
    for (const [name, list] of errors) out.set(name, list);
    kept = kept.filter((s) => !errors.has(s.name));
  }
}

/**
 * A save of one agent md checked against the registered ones — what BE would
 * leave out once the store holds the save.
 * @param {{type: string, id: string, markdown: string}[]} registry the active
 *   agent mds as the store holds them now, in store order
 * @param {{type: string, id: string, markdown: string|null, active: boolean}} self
 *   the document saved; `active` false when the save takes it out of the registry
 * @returns {{errors: object[], fenceLine: number, broken: {md: string, errors: object[]}[]}}
 *   errors: self's flow errors (none when self is out); broken: the other mds
 *   the save makes BE leave out
 */
export function saveCheck(registry, self) {
  const isSelf = (d) => d.type === self.type && d.id === self.id;
  const read = (d) => readAgentMd(d.id, d.markdown);
  const registered = (docs) => docs.map(read).filter((s) => s.rejection === null);
  const before = flowRejections(registered(registry));
  const docs = registry.filter((d) => !isSelf(d) || self.active).map((d) => (isSelf(d) ? self : d));
  if (self.active && !registry.some(isSelf)) docs.push(self);
  const after = flowRejections(registered(docs));
  const mine = self.markdown != null ? readAgentMd(self.id, self.markdown) : null;
  return {
    errors: self.active ? after.get(self.id) ?? [] : [],
    fenceLine: mine?.fence?.line ?? 0,
    broken: [...after].filter(([name]) => name !== self.id && !before.has(name)).map(([name, errors]) => ({ md: name, errors })),
  };
}

/**
 * BE's check-flow over md files (CheckFlow.check): grammar errors at their md
 * line, chart fence errors at their md line, another reading rejection as
 * `파일:1 MD 사유`, a chart fence left unchecked as a warning, the load's errors at their md
 * line (the fence's opening line when they have none), a subgraph id another md has as a warning. The common md
 * eqp-scope is always in. The md name is the file name without `.md`.
 * @param {{path: string, text: string}[]} files
 * @returns {{lines: string[], ok: boolean}}
 */
export function checkFiles(files) {
  const out = new Map(); // name -> {path, fenceAt, lines}
  const specs = [];
  let ok = true;
  for (const f of files) {
    const name = f.path.replace(/\\/g, "/").split("/").pop().replace(/\.md$/, "");
    const r = readAgentMd(name, f.text);
    const open = r.fence?.line ?? 0;
    const mine = { path: f.path, fenceAt: Math.max(open, 1), lines: [] };
    out.set(name, mine);
    for (const e of r.flowErrors) mine.lines.push(`${f.path}:${mdLine(e, open)} ${e.code} ${e.message}`);
    if (!mine.lines.length) for (const e of r.chartErrors) mine.lines.push(`${f.path}:${e.line} ${e.code} ${e.message}`);
    if (!mine.lines.length && r.rejection) mine.lines.push(`${f.path}:1 MD ${r.rejection}`);
    if (mine.lines.length) ok = false;
    else specs.push(r);
    for (const w of r.warnings) mine.lines.push(`${f.path}:${w.line} 경고 ${w.code} ${w.message}`);
  }
  if (!specs.some((s) => s.name === COMMON)) specs.push(readAgentMd(COMMON, COMMON_MD));
  for (const [name, errors] of flowRejections(specs)) {
    const mine = out.get(name);
    if (!mine) continue;
    for (const e of errors) mine.lines.push(`${mine.path}:${mdLine(e, mine.fenceAt)} ${e.code} ${e.message}`);
    ok = false;
  }
  const owner = new Map();
  for (const s of specs)
    for (const id of s.flow.subgraphIds()) {
      const first = owner.get(id);
      if (first === undefined) owner.set(id, s.name);
      else if (out.has(s.name))
        out.get(s.name).lines.push(`${out.get(s.name).path}:${out.get(s.name).fenceAt} 경고 SUBGRAPH_ID_CLASH subgraph ${id} 가 md ${first} 에도 있다 — ${first} 의 것을 쓴다`);
    }
  const lines = [];
  for (const mine of out.values()) {
    lines.push(...mine.lines);
    if (!mine.lines.some((l) => !l.includes(" 경고 "))) lines.push(`OK ${mine.path}`);
  }
  return { lines, ok };
}
