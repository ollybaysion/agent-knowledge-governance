// 표 보기: 패싯(거르는 기준) · 정렬 · 주소 해시에 담는 보기 상태.
// 줄은 health.mjs 의 docFacts 가 낸 것이다. DOM 없이 계산만 한다.
import { LONG_CHARS, SHORT_CHARS, titleKey } from "./health.mjs";
import { STALE_DAYS } from "./freshness.mjs";

/**
 * 패싯 여섯. values = 값과 화면 글(타입 · 상태는 화면이 채운다),
 * of(row) = 그 줄이 가진 값들. 한 패싯 안에서 고른 값은 OR, 패싯끼리는 AND 다.
 */
export const FACETS = [
  { id: "type", label: "타입", of: (r) => [r.doc.type] },
  { id: "status", label: "상태", of: (r) => [r.doc.status] },
  {
    id: "age",
    label: "수정",
    values: [
      ["7", "7일 안"],
      ["30", "8 ~ 30일"],
      ["90", "31 ~ 90일"],
      ["180", `91 ~ ${STALE_DAYS}일`],
      ["old", `${STALE_DAYS}일 넘음`],
    ],
    of: (r) => (r.ageDays == null ? [] : [r.ageDays <= 7 ? "7" : r.ageDays <= 30 ? "30" : r.ageDays <= 90 ? "90" : r.ageDays <= STALE_DAYS ? "180" : "old"]),
  },
  {
    id: "links",
    label: "연결",
    values: [
      ["linked", "연결 있음"],
      ["none", "연결 없음"],
      ["broken", "끊긴 연결"],
    ],
    of: (r) => [r.in + r.out > 0 ? "linked" : "none", ...(r.broken.length ? ["broken"] : [])],
  },
  {
    id: "size",
    label: "크기",
    values: [
      ["short", `짧음 (${SHORT_CHARS}자 미만)`],
      ["mid", "보통"],
      ["long", `긺 (${LONG_CHARS.toLocaleString("en-US")}자 넘음)`],
    ],
    of: (r) => (r.size == null ? [] : [r.size < SHORT_CHARS ? "short" : r.size > LONG_CHARS ? "long" : "mid"]),
  },
  {
    id: "title",
    label: "제목",
    values: [
      ["none", "제목 없음"],
      ["dup", "겹친 제목"],
    ],
    of: (r) => [...(r.untitled ? ["none"] : []), ...(r.dup > 1 ? ["dup"] : [])],
  },
];

/** 정렬 열과 처음 누를 때의 방향. */
export const SORTS = {
  title: "asc",
  type: "asc",
  status: "asc",
  updated: "desc",
  size: "desc",
  links: "desc",
};
export const DEFAULT_SORT = "updated";

/** 빈 보기 상태: 패싯은 고른 값 없음, 수정 시각 내림차순. */
export function emptyState() {
  return { q: "", sort: DEFAULT_SORT, dir: SORTS[DEFAULT_SORT], ...Object.fromEntries(FACETS.map((f) => [f.id, []])) };
}

/** 해시의 ? 뒤 글 → 보기 상태. 모르는 정렬 · 방향은 기본값이 된다. */
export function parseState(query) {
  const p = new URLSearchParams(String(query ?? "").replace(/^\?/, ""));
  const state = emptyState();
  for (const f of FACETS) state[f.id] = [...new Set((p.get(f.id) ?? "").split(",").map((v) => v.trim()).filter(Boolean))];
  state.q = (p.get("q") ?? "").trim();
  if (Object.hasOwn(SORTS, p.get("sort") ?? "")) state.sort = p.get("sort");
  state.dir = p.get("dir") === "asc" || p.get("dir") === "desc" ? p.get("dir") : SORTS[state.sort];
  return state;
}

/** 보기 상태 → 해시의 ? 뒤 글. 기본값과 같은 것은 적지 않는다. 빈 보기는 "". */
export function stateQuery(state) {
  const parts = [];
  for (const f of FACETS) if (state[f.id]?.length) parts.push(`${f.id}=${state[f.id].map(encodeURIComponent).join(",")}`);
  if (state.q) parts.push(`q=${encodeURIComponent(state.q)}`);
  if (state.sort !== DEFAULT_SORT || state.dir !== SORTS[DEFAULT_SORT]) {
    parts.push(`sort=${state.sort}`);
    if (state.dir !== SORTS[state.sort]) parts.push(`dir=${state.dir}`);
  }
  return parts.join("&");
}

/** 표 보기의 주소: #/table 또는 #/table?type=voc&links=none. */
export function tableHash(state) {
  const q = stateQuery({ ...emptyState(), ...state });
  return q ? `#/table?${q}` : "#/table";
}

/** 찾는 글: 공백으로 나눈 낱말이 모두 id · 제목 · 키워드 가운데 어딘가에 든 줄. */
function textHit(row, terms) {
  if (!terms.length) return true;
  const d = row.doc;
  const hay = [d.id, d.title ?? "", ...(d.keywords ?? []).map((k) => k.kw)].join("\n").toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** 보기 상태에 맞는 줄. `skip` = 보지 않을 패싯 id(그 패싯의 수를 셀 때). */
export function filterRows(rows, state, skip = null) {
  const terms = String(state.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const active = FACETS.filter((f) => f.id !== skip && state[f.id]?.length);
  return rows.filter((r) => textHit(r, terms) && active.every((f) => f.of(r).some((v) => state[f.id].includes(v))));
}

/**
 * 패싯마다 값별 문서 수: {type: Map(값 → 수), …}. 한 패싯의 수는 다른
 * 패싯과 찾는 글만 건 줄에서 센다 — 그 값을 고르면 남을 문서 수다.
 */
export function facetCounts(rows, state) {
  const out = {};
  for (const f of FACETS) {
    const counts = new Map();
    for (const r of filterRows(rows, state, f.id)) for (const v of f.of(r)) counts.set(v, (counts.get(v) ?? 0) + 1);
    out[f.id] = counts;
  }
  return out;
}

/** 패싯 값 하나를 켜거나 끈 새 상태. */
export function toggleFacet(state, facet, value) {
  const cur = state[facet] ?? [];
  return { ...state, [facet]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value] };
}

/** 열 머리를 누른 새 상태: 같은 열이면 방향을 뒤집고, 다른 열이면 그 열의 처음 방향. */
export function toggleSort(state, sort) {
  if (state.sort === sort) return { ...state, dir: state.dir === "asc" ? "desc" : "asc" };
  return { ...state, sort, dir: SORTS[sort] };
}

const name = (r) => (titleKey(r.doc.title) || r.doc.id).toLowerCase();
const KEYS = {
  title: (r) => name(r),
  type: (r) => r.doc.type,
  status: (r) => r.doc.status,
  updated: (r) => (r.doc.updatedAt ? String(r.doc.updatedAt) : null),
  size: (r) => r.size,
  links: (r) => r.in + r.out,
};

/**
 * 정렬한 새 목록. 값이 없는 줄(시각 · 크기 없음)은 방향과 상관없이 맨 뒤에 선다.
 * 값이 같으면 타입/id 순이다. `typeOrder` = 타입 열의 순서(타입 목록의 순서).
 */
export function sortRows(rows, sort = DEFAULT_SORT, dir = SORTS[sort], typeOrder = []) {
  const rank = new Map(typeOrder.map((t, i) => [t, i]));
  const key = sort === "type" ? (r) => rank.get(r.doc.type) ?? typeOrder.length : KEYS[sort] ?? KEYS[DEFAULT_SORT];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x == null || y == null) {
      if (x == null && y == null) return a.key.localeCompare(b.key);
      return x == null ? 1 : -1;
    }
    const c = typeof x === "number" ? x - y : String(x).localeCompare(String(y));
    return c ? c * sign : a.key.localeCompare(b.key);
  });
}

/** 고른 패싯 값의 수(찾는 글은 1 로 센다). */
export const activeCount = (state) => FACETS.reduce((n, f) => n + (state[f.id]?.length ?? 0), 0) + (state.q ? 1 : 0);
