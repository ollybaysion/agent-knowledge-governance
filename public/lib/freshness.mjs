// 신선도: 문서를 마지막으로 고친 뒤 며칠이 지났는지와 그 글 · 색조.
// DOM 없이 계산만 한다. node 가 그대로 시험한다.

export const DAY_MS = 86400000;

/** 색조가 바뀌는 날 수: 7 일까지 새 글, 90 일까지 보통, 180 일까지 묵음, 그 뒤 오래됨. */
export const FRESH_DAYS = 7;
export const AGING_DAYS = 90;
export const STALE_DAYS = 180;

/** 고친 뒤 지난 날 수(내림). 시각이 비었거나 읽히지 않으면 null, 앞날이면 0. */
export function ageDays(updatedAt, now = Date.now()) {
  if (!updatedAt) return null;
  const t = new Date(updatedAt).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/** "오늘" · "3일 전" · "4개월 전" · "2년 전". 날 수가 null 이면 "시각 없음". */
export function ageLabel(days) {
  if (days == null) return "시각 없음";
  if (days === 0) return "오늘";
  if (days < 60) return `${days}일 전`;
  if (days < 365) return `${Math.floor(days / 30)}개월 전`;
  return `${Math.floor(days / 365)}년 전`;
}

/** 색조 이름: fresh · ok · aging · stale · none. */
export function ageTone(days) {
  if (days == null) return "none";
  if (days <= FRESH_DAYS) return "fresh";
  if (days <= AGING_DAYS) return "ok";
  if (days <= STALE_DAYS) return "aging";
  return "stale";
}

/** 배지의 title: "2026-05-01 14:20 수정 · 207일 전". */
export function ageTitle(updatedAt, days) {
  if (days == null) return "수정 시각이 없습니다";
  const at = String(updatedAt);
  const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? `${at.slice(0, 10)} ${at.slice(11, 16)}` : at;
  return `${stamp} 수정 · ${days === 0 ? "오늘" : `${days}일 전`}`;
}
