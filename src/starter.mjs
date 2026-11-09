// The 첫 선택 데이터 (starter) document and the save warnings on 조회.
//
// A starter document writes its items in the agent md's grammar: each
// `### <id> — <title>` of `## 데이터` with its first ```sql fence
// (src/skill-data-ids.mjs). `## 프리셋` holds `- <name>: <id>, <id>` lines.
// An item's kind is not written in the document. It comes from the tables
// the query reads (FROM · JOIN, src/table-class.mjs): data when one of them
// has an active db-schema document of kind data, info otherwise — an empty
// kind and a table without a document read as info (user decision
// 2026-11-10). The consumer (fdc-agent-be-spring) runs an info query once per
// 설비 and reuses that table whatever the binds, so an info query that takes
// a bind other than 설비 · 라인 is warned about, in every type with 조회.
// Pure: the caller passes the kinds (server/data-ids.mjs tableKinds).
import { normalizeHeading, scan } from "./skill-sections.mjs";
import { skillDataIds } from "./skill-data-ids.mjs";
import { isEqpBind, isLineBind, varsOf } from "./sql-bind.mjs";
import { tablesOfSql } from "./table-class.mjs";

export const STARTER = "starter";
const SKILL_TYPES = ["domain-skill", "domain"];
const PRESET_SECTION = "프리셋";
const PRESET_LINE = /^\s*[-*+]\s+(.+?)\s*:\s*(.*?)\s*$/;

const code = (s) => `\`${s}\``;

/**
 * The `## 프리셋` list lines, skipping fenced code: the text before the first
 * `:` is the name, the comma-separated rest the item ids. Another line is
 * prose. No section, no presets.
 * @returns {{name: string, items: string[], line: number}[]} line is 1-based
 */
export function starterPresets(markdown) {
  const out = [];
  let inPresets = false;
  scan(markdown).forEach(({ line, heading, fenced }, i) => {
    if (heading !== null) {
      inPresets = normalizeHeading(heading) === PRESET_SECTION;
      return;
    }
    if (!inPresets || fenced) return;
    const m = PRESET_LINE.exec(line);
    if (m) out.push({ name: m[1], items: m[2].split(",").map((s) => s.trim()).filter(Boolean), line: i + 1 });
  });
  return out;
}

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
 * The starter document as the doc view shows it: each item with the tables
 * it reads, its kind (null without a ```sql fence), its binds and warnings,
 * then the presets. `warnings` is every warning in that order.
 * @param {string} markdown
 * @param {Map<string, string|undefined>} kinds
 * @returns {{
 *   items: {id: string, title: string|null, line: number, tables: string[], kind: "info"|"data"|null, binds: string[], warnings: string[]}[],
 *   presets: {name: string, items: string[], line: number, warnings: string[]}[],
 *   warnings: string[],
 * }}
 */
export function starterView(markdown, kinds) {
  const items = skillDataIds(markdown).map((item) => {
    const tables = item.sql ? tablesOfSql(item.sql) : [];
    const kind = item.sql ? queryKind(tables, kinds) : null;
    const warnings = [];
    if (!item.sql) warnings.push(`항목 ${code(item.id)} 에 \`\`\`sql 펜스가 없다.`);
    for (const t of tables)
      if (!kinds.has(t)) warnings.push(`항목 ${code(item.id)} 가 읽는 표 ${code(t)} 에 활성 DB 스키마 문서가 없다. 이 표는 info 로 센다.`);
    const bind = infoBindWarning(item.id, item.sql, kind);
    if (bind) warnings.push(bind);
    return { id: item.id, title: item.title, line: item.line, tables, kind, binds: item.sql ? varsOf(item.sql) : [], warnings };
  });
  const known = new Set(items.map((i) => i.id));
  const presets = starterPresets(markdown).map((p) => ({
    ...p,
    warnings: p.items.filter((id) => !known.has(id)).map((id) => `프리셋 ${code(p.name)} 이 없는 항목 ${code(id)} 를 가리킨다.`),
  }));
  return { items, presets, warnings: [...items.flatMap((i) => i.warnings), ...presets.flatMap((p) => p.warnings)] };
}

/**
 * The save warnings of a document's 조회: a starter's four kinds
 * ({@link starterView}), the info-bind one for a domain-skill or domain
 * document's ```sql items, none for another type.
 * @returns {string[]}
 */
export function queryWarnings(type, markdown, kinds) {
  if (typeof markdown !== "string") return [];
  if (type === STARTER) return starterView(markdown, kinds).warnings;
  if (!SKILL_TYPES.includes(type)) return [];
  return skillDataIds(markdown)
    .map((item) => (item.sql ? infoBindWarning(item.id, item.sql, queryKind(tablesOfSql(item.sql), kinds)) : null))
    .filter(Boolean);
}
