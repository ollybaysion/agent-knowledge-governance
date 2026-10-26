// db-schema 목록의 묶음 · 거르기와 확정 커버리지, as plain data. The server
// gives each db-schema row `major` · `usedBy` · `coverage` · `kind`
// (GET /api/docs); no DOM here, node tests it.

/** 성격 labels; a row without kind is 미정. */
export const KIND_LABEL = { info: "info", data: "data", none: "미정" };
export const kindOf = (d) => (d?.kind === "info" || d?.kind === "data" ? d.kind : "none");

/** The two filter rows above the list: 중요도 and 성격, each with its choices. */
export const TABLE_FILTERS = {
  major: [
    ["all", "전체"],
    ["major", "주요"],
    ["other", "기타"],
  ],
  kind: [
    ["all", "전체"],
    ["info", "info"],
    ["data", "data"],
    ["none", "미정"],
  ],
};
export const DEFAULT_FILTER = { major: "all", kind: "all" };

/** A stored filter read back, unknown values falling to 전체. */
export function readFilter(raw) {
  let v = null;
  try {
    v = JSON.parse(raw);
  } catch {
    /* nothing stored */
  }
  const ok = (axis) => TABLE_FILTERS[axis].some(([k]) => k === v?.[axis]);
  return { major: ok("major") ? v.major : "all", kind: ok("kind") ? v.kind : "all" };
}

/**
 * Rows (already in list order) → 주요 then 기타, each kept in that order,
 * through the filter. A group with no row left is not returned.
 * @returns {{key: "major"|"other", label: string, rows: object[]}[]}
 */
export function tableGroups(rows, filter = DEFAULT_FILTER) {
  const kept = rows.filter((d) => filter.kind === "all" || kindOf(d) === filter.kind);
  return [
    { key: "major", label: "주요", rows: kept.filter((d) => d.major) },
    { key: "other", label: "기타", rows: kept.filter((d) => !d.major) },
  ].filter((g) => g.rows.length && (filter.major === "all" || filter.major === g.key));
}

/** "확정 12/40" — the short text beside the bar. */
export const coverageText = (c) => `확정 ${c?.confirmed ?? 0}/${c?.total ?? 0}`;
/** The bar's fill, 0–100. */
export const coveragePercent = (c) => Math.round((c?.ratio ?? 0) * 100);

/**
 * 개요의 "주요 테이블 확정 커버리지": the 주요 tables' sum and the tables, the
 * lowest coverage first (then by id).
 * @returns {{confirmed: number, total: number, ratio: number, rows: object[]}}
 */
export function majorCoverage(docs) {
  const rows = docs
    .filter((d) => d.type === "db-schema" && d.major)
    .sort((a, b) => (a.coverage?.ratio ?? 0) - (b.coverage?.ratio ?? 0) || a.id.localeCompare(b.id));
  const confirmed = rows.reduce((n, d) => n + (d.coverage?.confirmed ?? 0), 0);
  const total = rows.reduce((n, d) => n + (d.coverage?.total ?? 0), 0);
  return { confirmed, total, ratio: total ? confirmed / total : 0, rows };
}

/** 쓰는 스킬 수: the distinct documents among usedBy. */
export const userCount = (d) => new Set((d?.usedBy ?? []).map((u) => `${u.type}/${u.id}`)).size;
