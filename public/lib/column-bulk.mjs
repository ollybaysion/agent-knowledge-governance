// 열 표 · 필드 표의 여러 줄 확정 · 폐기, 머리의 추정 n 확정, 등급 거르기.
// 화면 상태만 다룬다: 고른 줄과 거르기는 저장하지 않고, 문서를 다시 읽으면
// 처음으로 돌아간다.

/** 등급 거르기 칩, 왼쪽부터: [거르기 키, 칩 글]. "all" = 모든 줄. */
export const TIER_FILTERS = [
  ["all", "전체"],
  ["scaffold", "빈칸"],
  ["inferred", "추정"],
  ["confirmed", "확정"],
];

/** True when the row of `slot` shows under `filter`; a row without a slot shows under 전체 only. */
export const tierShown = (filter, slot) =>
  filter === "all" || (!!slot && slot.tier === filter);

/** Rows per filter key, over the table's row slots (undefined = a row without a slot). */
export function tierCounts(slots) {
  const counts = Object.fromEntries(TIER_FILTERS.map(([k]) => [k, 0]));
  for (const s of slots ?? []) {
    counts.all += 1;
    if (s && s.tier !== "all" && s.tier in counts) counts[s.tier] += 1;
  }
  return counts;
}

/** `list` with `address` added at the end, or taken out when it is there; the input is left alone. */
export function togglePick(list, address) {
  const now = list ?? [];
  return now.includes(address)
    ? now.filter((a) => a !== address)
    : [...now, address];
}

/**
 * The column slots (columnDescs.<열>) still 추정, as [{name, address}] in
 * the table's order. `order` = the column names in the table's order; a name
 * it lacks (a column the catalog lost) follows, in the slots' order. Other
 * slots (purpose · queries) are left out.
 */
export function inferredColumns(slots, order = []) {
  const rows = [];
  for (const s of slots ?? []) {
    const m = /^columnDescs\.(.+)$/.exec(s.address);
    if (m && s.tier === "inferred")
      rows.push({ name: m[1], address: s.address });
  }
  const at = (name) => {
    const i = order.indexOf(name);
    return i < 0 ? order.length : i;
  };
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => at(a.row.name) - at(b.row.name) || a.i - b.i)
    .map((x) => x.row);
}

/** The noun with its object particle: 열 → 열을, 필드 → 필드를. */
export function withObject(noun) {
  const code = noun.charCodeAt(noun.length - 1) - 0xac00;
  const closed = code >= 0 && code < 11172 && code % 28 !== 0;
  return `${noun}${closed ? "을" : "를"}`;
}

/**
 * The toast after a refused promote · deprecate: the verb, the status, the
 * server's error and what it named (details · slots · overlap).
 */
export function slotFailText(verb, status, data) {
  const named = [data?.details, data?.slots, data?.overlap].find(
    (v) => Array.isArray(v) && v.length,
  );
  const why = [
    data?.error,
    named
      ?.map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(" · "),
  ]
    .filter(Boolean)
    .join(": ");
  return `${verb} 실패 (${status})${why ? ` — ${why}` : ""}`;
}
