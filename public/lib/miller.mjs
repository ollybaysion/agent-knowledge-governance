// The 문서 탭's column browser as plain data: which rows each column holds
// and where the arrow keys go. No DOM here; node tests it.

/** domain-skill shows in this tab only as the documents whose role is sub. */
export const inDocsTab = (d) => d.type !== "domain-skill" || d.role === "sub";

/** The 문서 탭 name of the domain-skill row: it holds the role sub domain-skill documents. */
export const SUB_LABEL = "도메인 스킬";

/**
 * Column 1's type rows, in the type list's order: label · colour · count
 * (domain-skill counts its subs only), tag 등록 (a registered md type) or 내장
 * (unclassified). A closed type stays only while it still holds documents;
 * the domain-skill row stands only while a sub is left.
 */
export function typeRows(types, docs) {
  const count = new Map();
  for (const d of docs) if (inDocsTab(d)) count.set(d.type, (count.get(d.type) ?? 0) + 1);
  return types
    .filter((t) => (t.id === "domain-skill" || t.status === "archived" ? count.get(t.id) : true))
    .map((t) => ({
      id: t.id,
      label: t.id === "domain-skill" ? SUB_LABEL : t.label,
      color: t.color,
      count: count.get(t.id) ?? 0,
      tag: t.id === "unclassified" ? "내장" : t.kind === "md" && !t.builtin ? "등록" : null,
      archived: t.status === "archived",
    }));
}

/** Column 2: one type's documents, the last changed first, then by id. */
export function docRows(docs, type) {
  return docs
    .filter((d) => d.type === type && inDocsTab(d))
    .sort(byChange);
}

const byChange = (a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.id.localeCompare(b.id);

/**
 * Column 2 with a tag picked and no type: the documents that carry the tag,
 * across the types, in the type list's order — one group per type, the last
 * changed first. A domain-skill main (an agent) gets a group of its own.
 */
export function tagGroups(types, docs, tag) {
  const tagged = docs.filter((d) => (d.tags ?? []).includes(tag));
  const groups = [];
  for (const t of types) {
    const of = tagged.filter((d) => d.type === t.id);
    const docsTab = of.filter(inDocsTab).sort(byChange);
    const agents = of.filter((d) => !inDocsTab(d)).sort(byChange);
    if (docsTab.length) groups.push({ type: t.id, label: t.id === "domain-skill" ? SUB_LABEL : t.label, color: t.color, rows: docsTab });
    if (agents.length) groups.push({ type: t.id, label: "에이전트", color: t.color, rows: agents });
  }
  return groups;
}

/** The confirm text of 삭제: the title, the type and how many documents point here. */
export function deleteConfirmText(title, typeName, backlinks) {
  return `"${title}"(${typeName}) 을 삭제합니다. 저장소에서 파일이 지워지고 git 이력에만 남습니다. 이 문서를 가리키는 문서 ${backlinks}개의 연결을 함께 지웁니다.`;
}

/** The tier a row shows: 추정 while any slot waits, else 확정, else 빈칸; null without slots. */
export function rowTier(tiers) {
  if (!tiers) return null;
  if (tiers.inferred) return "inferred";
  if (tiers.confirmed) return "confirmed";
  if (tiers.scaffold) return "scaffold";
  return null;
}

/**
 * One key in the browser. state = {col: 1|2, i1, i2}; sizes = {n1, n2(i1)}
 * where n2 is a function of the column-1 index. → {state, action}
 * action: "open" (↩ on a document) · "pick" (↩ on a column-1 row that is a
 * document, i.e. 즐겨찾기 · 최근) · null.
 */
export function move(state, key, { n1, n2, isDocRow = () => false }) {
  const s = { ...state };
  const clamp = (i, n) => Math.max(0, Math.min(n - 1, i));
  if (key === "ArrowDown" || key === "ArrowUp") {
    const d = key === "ArrowDown" ? 1 : -1;
    if (s.col === 1) {
      const next = clamp(s.i1 + d, n1);
      if (next !== s.i1) s.i2 = 0;
      s.i1 = next;
    } else s.i2 = clamp(s.i2 + d, n2(s.i1));
    return { state: s, action: null };
  }
  if (key === "ArrowRight") {
    if (s.col === 1 && !isDocRow(s.i1) && n2(s.i1) > 0) s.col = 2;
    return { state: s, action: null };
  }
  if (key === "ArrowLeft") {
    s.col = 1;
    return { state: s, action: null };
  }
  if (key === "Enter") {
    if (s.col === 2 && n2(s.i1) > 0) return { state: s, action: "open" };
    if (s.col === 1 && isDocRow(s.i1)) return { state: s, action: "pick" };
    if (s.col === 1 && n2(s.i1) > 0) {
      s.col = 2;
      return { state: s, action: null };
    }
  }
  return { state: s, action: null };
}
