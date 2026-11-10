// 정리 탭이 그리는 것: 중복 후보 줄 · 흡수 기록 줄 · 대상 문서의 바뀐 절.
// No DOM here; node tests it. The tab (js/tabs/curation.mjs) draws these.
import { splitBlocks } from "./sections.mjs";

export const PAIR_STATUS_LABEL = { open: "열림", dismissed: "그대로 둠", resolved: "처리함" };
/** The 상태 filter: value (the list's ?status=, "" for all) and its label. */
export const PAIR_FILTERS = [
  ["open", "열림"],
  ["dismissed", "그대로 둠"],
  ["resolved", "처리함"],
  ["", "전체"],
];
export const ABSORPTION_STATUS_LABEL = { applied: "반영됨", reverted: "되돌림" };
const REASON_LABEL = { deleted: "문서 삭제", retyped: "타입 바뀜" };

const pad = (n) => String(n).padStart(2, "0");
/** ISO 8601 → 내 시각 "2026-11-10 22:40", "—" for nothing. */
export function localAt(iso) {
  const d = new Date(iso ?? "");
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const scoreText = (n) => (typeof n === "number" ? n.toFixed(2) : "—");

/**
 * One side of a pair or record as a cell shows it: the link label, where it
 * goes, and a note when the document is gone or changed since the curator saw it.
 * @param {{type: string, id: string, title?: string|null, status?: string|null, exists?: boolean, rev?: string, currentRev?: string|null}} d
 * @param {string} [seenRev] the rev the curator saw (default d.rev)
 */
export function sideView(d, seenRev = d.rev) {
  return {
    type: d.type,
    id: d.id,
    label: d.title || d.id,
    exists: !!d.exists,
    status: d.exists ? d.status : null,
    note: !d.exists ? "지워졌거나 타입이 바뀌었습니다" : seenRev && d.currentRev && d.currentRev !== seenRev ? "본 뒤 바뀜" : null,
  };
}

/** What a pair's 상태 cell says: the status, and who decided when. */
export function pairStateText(pair) {
  const label = PAIR_STATUS_LABEL[pair.status] ?? pair.status;
  const d = pair.decision;
  if (!d) return { label, detail: null };
  if (d.reason) return { label, detail: `${REASON_LABEL[d.reason] ?? d.reason} · ${localAt(d.at)}` };
  return { label, detail: `${d.by} · ${localAt(d.at)}` };
}

/** One pair as a row: both sides, score, when seen, status. */
export function pairRow(pair) {
  return {
    key: pair.key,
    a: sideView(pair.a),
    b: sideView(pair.b),
    score: scoreText(pair.score),
    seenAt: localAt(pair.seenAt),
    state: pairStateText(pair),
    open: pair.status === "open",
  };
}

/** Whether 되돌리기 goes, and why not when it does not. */
export function revertState(rec) {
  if (rec.status === "reverted") return { can: false, reason: `${rec.revert?.by ?? ""} 가 ${localAt(rec.revert?.at)} 에 되돌렸습니다` };
  if (!rec.target?.exists) return { can: false, reason: "대상 문서가 그 자리에 없습니다(삭제 또는 타입 바뀜)" };
  if (rec.target.currentRev !== rec.target.toRev) return { can: false, reason: "흡수 뒤 대상 문서가 바뀌었습니다. 이력을 보고 손으로 되돌리세요" };
  return { can: true, reason: null };
}

/** One absorption record as a row. */
export function absorptionRow(rec) {
  return {
    id: rec.id,
    source: sideView(rec.source),
    target: sideView(rec.target, rec.target.toRev),
    summary: rec.summary,
    at: localAt(rec.at),
    model: rec.model,
    score: rec.score === undefined ? null : scoreText(rec.score),
    status: ABSORPTION_STATUS_LABEL[rec.status] ?? rec.status,
    revert: revertState(rec),
  };
}

const HEAD = "(첫 절 앞)";
const mdOf = (body) => (typeof body?.markdown === "string" ? body.markdown : body == null ? "" : JSON.stringify(body, null, 2));

/**
 * The `##` sections that differ between the target's two bodies, in the
 * after order, removed ones last: [{heading, before, after}] with "" for a
 * side that has no such section. The text before the first `##` counts as
 * one section.
 */
export function changedSections(beforeBody, afterBody) {
  const before = splitBlocks(mdOf(beforeBody));
  const after = splitBlocks(mdOf(afterBody));
  const out = [];
  if (before.head !== after.head) out.push({ heading: HEAD, before: before.head, after: after.head });
  const old = new Map(before.blocks.map((b) => [b.key, b]));
  for (const b of after.blocks) {
    const was = old.get(b.key);
    old.delete(b.key);
    if (was?.body !== b.body) out.push({ heading: b.heading, before: was?.body ?? "", after: b.body });
  }
  for (const b of old.values()) out.push({ heading: b.heading, before: b.body, after: "" });
  return out;
}

/**
 * Line LCS of two texts: [{t: "eq"|"del"|"add", line}]. A section is a few
 * dozen lines, so the table stays small.
 */
export function lineDiff(before, after) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ t: "eq", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: "del", line: a[i++] });
    else out.push({ t: "add", line: b[j++] });
  }
  while (i < a.length) out.push({ t: "del", line: a[i++] });
  while (j < b.length) out.push({ t: "add", line: b[j++] });
  return out;
}
