// 문서 현황 진단: 문서 목록 응답(GET /api/docs 의 줄)만으로 세는 값들.
// 줄마다 연결 수 · 끊긴 연결 · 나이 · 크기를 붙이고(docFacts), 검사 여덟과
// 분포 둘, 타입 × 상태 표를 낸다. DOM 없이 계산만 한다.
import { STALE_DAYS, ageDays } from "./freshness.mjs";

/** 검사의 기준 값. 크기는 본문 글자 수다. */
export const SHORT_CHARS = 200;
export const LONG_CHARS = 12000;
export const RECENT_DAYS = 7;

export const keyOf = (d) => `${d.type}/${d.id}`;

/** 겹친 제목을 찾을 때의 제목 꼴: 앞뒤 공백을 떼고, 공백을 하나로, 소문자로. */
export const titleKey = (title) => String(title ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** 끊긴 연결의 종류와 화면 글. */
export const BROKEN_LABEL = {
  missing: "없는 문서",
  archived: "폐기된 문서",
  inactive: "비활성 문서",
  name: "없는 이름",
};

const BROKEN_ORDER = ["missing", "archived", "name", "inactive"];
/** 대상이 사라진 연결의 수(비활성 문서를 가리키는 연결은 뺀다). */
export const goneCount = (row) => row.broken.filter((b) => b.kind !== "inactive").length;

/**
 * 줄마다의 사실. `all` 은 폐기 문서까지 든 목록이다(폐기 문서는 연결 대상으로만 본다).
 * out = 이 문서가 가리키는 살아 있는 문서 수, in = 이 문서를 가리키는 살아 있는 문서 수.
 * links[] 와 본문 [[ ]] 를 합쳐 대상마다 한 번 센다.
 * broken = 끊긴 연결: 대상이 없음(missing) · 폐기됨(archived) · 활성 문서가 비활성
 * 문서를 가리킴(inactive) · 본문 [[ ]] 의 이름이 어느 문서도 아님(name).
 * untitled = 제목이 비었거나, md 타입(`mdTypes`)인데 제목이 id 와 같음 — `# 제목` 줄이
 * 없는 md 문서는 서버가 이름(id)을 제목으로 보낸다. dup = 같은 제목을 쓰는 문서 수.
 * @param {{mdTypes?: string[]}} [opts]
 * @returns {{doc: object, key: string, in: number, out: number, broken: {kind: string, target: string}[], ageDays: number|null, size: number|null, untitled: boolean, dup: number}[]}
 */
export function docFacts(all, now = Date.now(), { mdTypes = [] } = {}) {
  const md = new Set(mdTypes);
  const untitled = (d) => !titleKey(d.title) || (md.has(d.type) && String(d.title).trim() === d.id);
  const byKey = new Map(all.map((d) => [keyOf(d), d]));
  const live = all.filter((d) => d.status !== "archived");
  const inbound = new Map(live.map((d) => [keyOf(d), new Set()]));
  const titles = new Map();
  for (const d of live) {
    if (untitled(d)) continue;
    const t = titleKey(d.title);
    titles.set(t, (titles.get(t) ?? 0) + 1);
  }
  const rows = live.map((doc) => {
    const key = keyOf(doc);
    const out = new Set();
    const broken = [];
    const seen = new Set();
    const visit = (target) => {
      if (target === key || seen.has(target)) return;
      seen.add(target);
      const to = byKey.get(target);
      if (!to) broken.push({ kind: "missing", target });
      else if (to.status === "archived") broken.push({ kind: "archived", target });
      else {
        out.add(target);
        if (to.status === "inactive" && doc.status === "active") broken.push({ kind: "inactive", target });
      }
    };
    for (const l of doc.links ?? []) visit(`${l.type}/${l.id}`);
    for (const w of doc.wikilinks ?? []) {
      if (w.found && w.type) visit(`${w.type}/${w.id}`);
      else if (!seen.has(`[[${w.text}]]`)) {
        seen.add(`[[${w.text}]]`);
        broken.push({ kind: "name", target: w.text });
      }
    }
    for (const target of out) inbound.get(target).add(key);
    // 무거운 것부터: 없는 문서 · 폐기된 문서 · 없는 이름 · 비활성 문서.
    broken.sort((a, b) => BROKEN_ORDER.indexOf(a.kind) - BROKEN_ORDER.indexOf(b.kind));
    const noTitle = untitled(doc);
    return {
      doc,
      key,
      in: 0,
      out: out.size,
      broken,
      ageDays: ageDays(doc.updatedAt, now),
      size: Number.isFinite(doc.size) ? doc.size : null,
      untitled: noTitle,
      dup: noTitle ? 0 : titles.get(titleKey(doc.title)),
    };
  });
  for (const r of rows) r.in = inbound.get(r.key).size;
  return rows;
}

/** 검사 여덟: id · 카드 글 · 색조 · 줄이 걸리는 조건 · 목록 순서. */
export const CHECKS = [
  {
    id: "orphans",
    label: "연결 없음",
    hint: "가리키는 문서도, 가리켜 주는 문서도 없는 문서",
    tone: "warn",
    test: (r) => r.in === 0 && r.out === 0,
    order: (a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity),
  },
  {
    id: "broken",
    label: "끊긴 연결",
    hint: "없는 문서 · 폐기된 문서 · 없는 이름 · 비활성 문서를 가리키는 문서, 대상이 사라진 연결이 많은 순",
    tone: "bad",
    test: (r) => r.broken.length > 0,
    order: (a, b) => goneCount(b) - goneCount(a) || b.broken.length - a.broken.length || a.key.localeCompare(b.key),
  },
  {
    id: "stale",
    label: `${STALE_DAYS}일 넘게 그대로`,
    hint: `마지막으로 고친 지 ${STALE_DAYS}일이 넘은 문서, 오래된 순`,
    tone: "warn",
    test: (r) => r.ageDays != null && r.ageDays > STALE_DAYS,
    order: (a, b) => b.ageDays - a.ageDays,
  },
  {
    id: "short",
    label: "짧은 문서",
    hint: `본문이 ${SHORT_CHARS}자보다 짧은 문서 — 검색에 걸릴 글이 적습니다`,
    tone: "warn",
    test: (r) => r.size != null && r.size < SHORT_CHARS,
    order: (a, b) => a.size - b.size,
  },
  {
    id: "long",
    label: "긴 문서",
    hint: `본문이 ${LONG_CHARS.toLocaleString("en-US")}자를 넘는 문서 — 조각이 많아져 검색이 흐려집니다`,
    tone: "warn",
    test: (r) => r.size != null && r.size > LONG_CHARS,
    order: (a, b) => b.size - a.size,
  },
  {
    id: "untitled",
    label: "제목 없음",
    hint: "`# 제목` 줄이 없거나 제목이 id 와 같아서 목록과 검색에 id 로만 보이는 문서",
    tone: "warn",
    test: (r) => r.untitled,
    order: (a, b) => a.key.localeCompare(b.key),
  },
  {
    id: "dup",
    label: "겹친 제목",
    hint: "같은 제목을 둘 이상의 문서가 씁니다",
    tone: "warn",
    test: (r) => r.dup > 1,
    order: (a, b) => titleKey(a.doc.title).localeCompare(titleKey(b.doc.title)) || a.key.localeCompare(b.key),
  },
  {
    id: "recent",
    label: `최근 ${RECENT_DAYS}일`,
    hint: `지난 ${RECENT_DAYS}일 안에 바뀐 문서, 새 순`,
    tone: "info",
    test: (r) => r.ageDays != null && r.ageDays <= RECENT_DAYS,
    order: (a, b) => a.ageDays - b.ageDays || String(b.doc.updatedAt).localeCompare(String(a.doc.updatedAt)),
  },
];
export const checkOf = (id) => CHECKS.find((c) => c.id === id) ?? null;

/** 검사 하나에 걸린 줄, 그 검사의 순서로. */
export function checkRows(rows, id) {
  const c = checkOf(id);
  return c ? rows.filter(c.test).sort(c.order) : [];
}

/** 검사마다 걸린 문서 수: {orphans: 12, broken: 3, …}. */
export function checkCounts(rows) {
  return Object.fromEntries(CHECKS.map((c) => [c.id, rows.filter(c.test).length]));
}

/** 겹친 제목을 제목별 묶음으로: [{title, rows}] — 문서가 많은 묶음 먼저. */
export function dupGroups(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.dup < 2) continue;
    const k = titleKey(r.doc.title);
    if (!groups.has(k)) groups.set(k, { title: String(r.doc.title).trim(), rows: [] });
    groups.get(k).rows.push(r);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.title.localeCompare(b.title));
}

/** 나이 분포의 칸: 위 끝 날 수(포함)와 글. 마지막 칸은 끝이 없다. */
export const AGE_BUCKETS = [
  { max: 7, label: "7일 안", range: "오늘 ~ 7일 전" },
  { max: 30, label: "30일 안", range: "8 ~ 30일 전" },
  { max: 90, label: "90일 안", range: "31 ~ 90일 전" },
  { max: 180, label: "180일 안", range: "91 ~ 180일 전" },
  { max: 365, label: "1년 안", range: "181 ~ 365일 전" },
  { max: Infinity, label: "1년 넘음", range: "366일 전부터" },
];

/** 크기 분포의 칸: 위 끝 글자 수(미포함)와 글. 처음 칸 = 짧은 문서, 마지막 칸 = 긴 문서. */
export const SIZE_BUCKETS = [
  { max: SHORT_CHARS, label: "~ 200", range: `${SHORT_CHARS}자 미만` },
  { max: 500, label: "~ 500", range: "200 ~ 499자" },
  { max: 1000, label: "~ 1천", range: "500 ~ 999자" },
  { max: 2000, label: "~ 2천", range: "1,000 ~ 1,999자" },
  { max: 4000, label: "~ 4천", range: "2,000 ~ 3,999자" },
  { max: 8000, label: "~ 8천", range: "4,000 ~ 7,999자" },
  { max: LONG_CHARS + 1, label: "~ 1.2만", range: "8,000 ~ 12,000자" },
  { max: Infinity, label: "1.2만 ~", range: "12,000자 넘음" },
];

/** 나이 분포: 칸마다 {label, range, count, tone}, 그리고 시각이 없는 문서 수. */
export function ageHistogram(rows) {
  const bins = AGE_BUCKETS.map((b) => ({ label: b.label, range: b.range, count: 0, tone: b.max > STALE_DAYS ? "warn" : "plain" }));
  let unknown = 0;
  for (const r of rows) {
    if (r.ageDays == null) unknown += 1;
    else bins[AGE_BUCKETS.findIndex((b) => r.ageDays <= b.max)].count += 1;
  }
  return { bins, unknown };
}

/** 크기 분포: 칸마다 {label, range, count, tone}, 그리고 크기가 없는 문서 수. */
export function sizeHistogram(rows) {
  const last = SIZE_BUCKETS.length - 1;
  const bins = SIZE_BUCKETS.map((b, i) => ({ label: b.label, range: b.range, count: 0, tone: i === 0 || i === last ? "warn" : "plain" }));
  let unknown = 0;
  for (const r of rows) {
    if (r.size == null) unknown += 1;
    else bins[SIZE_BUCKETS.findIndex((b) => r.size < b.max)].count += 1;
  }
  return { bins, unknown };
}

/** 가운데 값(짝수 개면 아래쪽). 빈 목록은 null. */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * 타입 × 상태 표: 타입마다 {type, active, inactive, total}, `order` 의 순서로.
 * 목록에 없는 타입은 뒤에 이름순으로 선다. 문서가 없는 타입도 줄을 가진다.
 */
export function typeStatusMatrix(rows, order = []) {
  const by = new Map(order.map((t) => [t, { type: t, active: 0, inactive: 0, total: 0 }]));
  const extra = new Map();
  for (const r of rows) {
    const t = r.doc.type;
    let m = by.get(t) ?? extra.get(t);
    if (!m) extra.set(t, (m = { type: t, active: 0, inactive: 0, total: 0 }));
    if (r.doc.status === "inactive") m.inactive += 1;
    else m.active += 1;
    m.total += 1;
  }
  return [...by.values(), ...[...extra.values()].sort((a, b) => a.type.localeCompare(b.type))];
}

/**
 * 미리보기 카드의 첫 줄들: frontmatter · `# 제목` · 코드 울타리 · 표 줄 · HTML 주석 · 빈 줄을 건너뛰고
 * 글 줄을 `lines` 개까지, 줄마다 `width` 자에서 자른다. md 표시(#, -, >, **)는 뗀다.
 */
export function firstLines(markdown, { lines = 3, width = 90 } = {}) {
  const text = String(markdown ?? "").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  let fence = false;
  let titleSeen = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = raw.trim();
    if (!line || /^\|/.test(line) || /^[-=*_]{3,}$/.test(line) || /^!\[/.test(line)) continue;
    if (!titleSeen && /^#\s/.test(line)) {
      titleSeen = true;
      continue;
    }
    const plain = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^([-*+]|\d+\.)\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[\[([^[\]]+)\]\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .trim();
    if (!plain) continue;
    out.push(plain.length > width ? `${plain.slice(0, width - 1)}…` : plain);
    if (out.length === lines) break;
  }
  return out;
}
