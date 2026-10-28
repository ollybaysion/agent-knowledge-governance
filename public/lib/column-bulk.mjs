// 열 표 · 필드 표의 여러 줄 확정 · 폐기. 화면 상태만 다룬다: 고른 줄은
// 저장하지 않고, 문서를 다시 읽으면 처음으로 돌아간다.

/** `list` with `address` added at the end, or taken out when it is there; the input is left alone. */
export function togglePick(list, address) {
  const now = list ?? [];
  return now.includes(address)
    ? now.filter((a) => a !== address)
    : [...now, address];
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
