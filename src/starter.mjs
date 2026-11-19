// The 첫 선택 데이터 (starter) document and the save warnings on 조회.
//
// A starter document writes its items in the agent md's grammar: each
// `### <id> — <title>` of `## 데이터` with its first ```sql fence
// (src/skill-data-ids.mjs). An item's kind is not written in the document. It comes from the tables
// the query reads (FROM · JOIN, src/table-class.mjs): data when one of them
// has an active db-schema document of kind data, info otherwise — an empty
// kind and a table without a document read as info (user decision
// 2026-11-10). The consumer (fdc-agent-be-spring) runs an info query once per
// 설비 and reuses that table whatever the binds, so an info query that takes
// a bind other than 설비 · 라인 is warned about, in every type with 조회.
// Pure: the caller passes the kinds (server/data-ids.mjs tableKinds).
import { skillDataIds } from "./skill-data-ids.mjs";
import { END_TIME, START_TIME, isEqpBind, isLineBind, varsOf } from "./sql-bind.mjs";
import { tablesOfSql } from "./table-class.mjs";

export const STARTER = "starter";
const SKILL_TYPES = ["domain-skill", "domain"];

const code = (s) => `\`${s}\``;

/**
 * A query's kind from the tables it reads: data when one of them is data,
 * info otherwise.
 * @param {string[]} tables upper case, as tablesOfSql gives them
 * @param {Map<string, string|undefined>} kinds table → its db-schema document's kind
 */
export const queryKind = (tables, kinds) => (tables.some((t) => kinds.get(t) === "data") ? "data" : "info");

/** The binds of an info query beyond 설비 (eqp_id · equipment · eqp) and 라인 (line), in order. */
export const infoBinds = (sql) => varsOf(sql).filter((name) => !isEqpBind(name) && !isLineBind(name));

function infoBindWarning(id, sql, kind) {
  if (!sql || kind !== "info") return null;
  const binds = infoBinds(sql);
  if (!binds.length) return null;
  return `info 조회 ${code(id)} 가 바인드 ${binds.map(code).join(" · ")} 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다.`;
}

/**
 * A document's `구간 출처` check, one per document: `of(item)` gives an item's
 * warnings. A source id must be a ```sql item of the same document or an item
 * of a registered starter. The item's SQL must take :start_time, :end_time
 * or both (any case). With one of them, the SQL itself sets the window's
 * length. BE warns the same way and leaves the line out.
 * @param {ReturnType<typeof skillDataIds>} items the document's items
 * @param {() => Set<string>} starterIds the registered starters' item ids;
 *   called once, at the first source the document does not hold
 */
function windowCheck(items, starterIds) {
  const own = new Set(items.filter((i) => i.sql).map((i) => i.id));
  let starters = null;
  const known = (id) => own.has(id) || (starters ??= starterIds()).has(id);
  return (item) => {
    if (!item.windowSources.length) return [];
    const out = item.windowSources.filter((s) => !known(s)).map((s) => `항목 ${code(item.id)} 의 구간 출처 ${code(s)} 를 찾을 수 없다.`);
    const vars = new Set(item.sql ? varsOf(item.sql).map((v) => v.toLowerCase()) : []);
    if (item.sql && !vars.has(START_TIME) && !vars.has(END_TIME))
      out.push(`항목 ${code(item.id)} 는 시간 바인드가 없어 구간 출처 줄을 쓸 수 없다.`);
    return out;
  };
}

/**
 * The starter document as the doc view shows it: each item with the tables
 * it reads, its kind (null without a ```sql fence), its binds and warnings.
 * `hidden` is the item's `숨김: 예` line: the view marks it 「숨김」, and the
 * first screen keeps it picked and shows no row for it. Two such lines are a
 * warning (BE refuses the document). `windowSources` is the ids of the
 * item's `구간 출처:` line: the view shows them beside the name. Two such
 * lines are a warning, and so is each {@link windowCheck} finding.
 * `warnings` is every warning in that order.
 * @param {string} markdown
 * @param {Map<string, string|undefined>} kinds
 * @param {() => Set<string>} [starterIds] the registered starters' item ids,
 *   this document left out ({@link windowCheck})
 * @returns {{
 *   items: {id: string, title: string|null, line: number, tables: string[], kind: "info"|"data"|null, binds: string[], hidden: boolean, windowSources: string[], warnings: string[]}[],
 *   warnings: string[],
 * }}
 */
export function starterView(markdown, kinds, starterIds = () => new Set()) {
  const read = skillDataIds(markdown);
  const windowWarnings = windowCheck(read, starterIds);
  const items = read.map((item) => {
    const tables = item.sql ? tablesOfSql(item.sql) : [];
    const kind = item.sql ? queryKind(tables, kinds) : null;
    const warnings = [];
    if (!item.sql) warnings.push(`항목 ${code(item.id)} 에 \`\`\`sql 펜스가 없다.`);
    if (item.hiddenLines > 1) warnings.push(`항목 ${code(item.id)} 의 숨김 줄은 하나다. BE 가 이 문서를 읽지 않는다.`);
    if (item.windowSourcesLines > 1) warnings.push(`항목 ${code(item.id)} 의 구간 출처 줄은 하나다. BE 가 이 문서를 읽지 않는다.`);
    for (const t of tables)
      if (!kinds.has(t)) warnings.push(`항목 ${code(item.id)} 가 읽는 표 ${code(t)} 에 활성 DB 스키마 문서가 없다. 이 표는 info 로 센다.`);
    const bind = infoBindWarning(item.id, item.sql, kind);
    if (bind) warnings.push(bind);
    warnings.push(...windowWarnings(item));
    return {
      id: item.id,
      title: item.title,
      line: item.line,
      tables,
      kind,
      binds: item.sql ? varsOf(item.sql) : [],
      hidden: item.hidden,
      windowSources: item.windowSources,
      warnings,
    };
  });
  return { items, warnings: items.flatMap((i) => i.warnings) };
}

/** The screen-map document type: its `data` names registered queries ({@link screenData}). */
export const SCREEN_MAP = "screen-map";

/**
 * A screen-map document's `data` as the doc view shows it: each id in run
 * order with the document that registers it, null when no registered query
 * has that id. `warnings` has one `screen_data_unknown` line per such id. The
 * save keeps the document: a screen may come in before its queries do.
 * @param {unknown} data the body's `data`
 * @param {Map<string, {type: string, id: string}>} queries registered query id → its document
 * @returns {{items: {id: string, doc: {type: string, id: string}|null}[], warnings: string[]}}
 */
export function screenData(data, queries) {
  const items = (Array.isArray(data) ? data : []).filter((id) => typeof id === "string").map((id) => ({ id, doc: queries.get(id) ?? null }));
  const warnings = items
    .filter((it) => it.doc === null)
    .map((it) => `screen_data_unknown: 화면 데이터 ${code(it.id)} 는 등재된 조회가 아니다. 활성 첫 선택 데이터 문서의 항목에도, 에이전트 문서의 조회에도 없다.`);
  return { items, warnings };
}

/**
 * The save warnings of a document's 조회: a starter's ({@link starterView}),
 * the info-bind one and the {@link windowCheck} ones for a domain-skill or
 * domain document's ```sql items, none for another type.
 * @param {() => Set<string>} [starterIds] the registered starters' item ids,
 *   a starter document's own left out
 * @returns {string[]}
 */
export function queryWarnings(type, markdown, kinds, starterIds = () => new Set()) {
  if (typeof markdown !== "string") return [];
  if (type === STARTER) return starterView(markdown, kinds, starterIds).warnings;
  if (!SKILL_TYPES.includes(type)) return [];
  const items = skillDataIds(markdown);
  const windowWarnings = windowCheck(items, starterIds);
  return items.flatMap((item) =>
    item.sql ? [infoBindWarning(item.id, item.sql, queryKind(tablesOfSql(item.sql), kinds)), ...windowWarnings(item)].filter(Boolean) : [],
  );
}
