// 문서 목록(둘째 열)의 여러 문서 활성화: 고를 수 있는 줄 · 머리 상자 ·
// 확인 창 이름 목록 · 보내는 몸 · 끝난 뒤 토스트. 화면 상태만 다룬다:
// 고른 것은 저장하지 않고, 타입 · 태그 · 거르기가 바뀌면 처음으로 돌아간다.

/** 확인 창이 이름을 다 적는 문서 수. 넘으면 "… 외 m" 이다. */
export const DIALOG_NAMES = 8;

/** True for a row the list lets the admin pick: an inactive document. */
export const pickable = (d) => d?.status === "inactive";

/** The rows' pickable ids, in the list's order. */
export const pickableIds = (rows) =>
  (rows ?? []).filter(pickable).map((d) => d.id);

/**
 * The head box over `rows` with `picked` (a Set of ids): "none" · "some"
 * (indeterminate) · "all" (every pickable row picked). No pickable row = "none".
 */
export function headState(rows, picked) {
  const ids = pickableIds(rows);
  const n = ids.filter((id) => picked.has(id)).length;
  if (!n) return "none";
  return n === ids.length ? "all" : "some";
}

/** A press on the head box: every pickable row, or none when all were picked. */
export function toggleAll(rows, picked) {
  return headState(rows, picked) === "all"
    ? new Set()
    : new Set(pickableIds(rows));
}

/** `picked` with `id` added, or taken out when it is there; the input is left alone. */
export function togglePicked(picked, id) {
  const next = new Set(picked);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * `picked` kept to the ids still pickable in `rows` — the selection after
 * the list changed under it.
 */
export function keepPicked(rows, picked) {
  const ids = new Set(pickableIds(rows));
  return new Set([...picked].filter((id) => ids.has(id)));
}

/**
 * The picks for column 2 now showing `type` with `rows`: {type, ids}. Another
 * type starts empty; the same type keeps the ids still pickable in `rows`.
 */
export const picksFor = (prev, type, rows) =>
  prev?.type === type
    ? { type, ids: keepPicked(rows, prev.ids) }
    : { type, ids: new Set() };

/** The picked rows, in the list's order. */
export const pickedRows = (rows, picked) =>
  (rows ?? []).filter((d) => pickable(d) && picked.has(d.id));

/** POST /api/docs/:type/activate's body: each picked row's id and its list rev. */
export const activateBody = (rows, picked) => ({
  items: pickedRows(rows, picked).map((d) => ({ id: d.id, rev: d.rev })),
});

/** A row's name in the dialog: the id, then the title when it says more. */
export const dialogName = (d) =>
  d.title && d.title !== d.id ? `${d.id} · ${d.title}` : d.id;

/** The dialog's name list: the first DIALOG_NAMES names, and how many more. */
export function dialogNames(rows, cap = DIALOG_NAMES) {
  const names = rows.map(dialogName);
  return names.length > cap
    ? { names: names.slice(0, cap), more: names.length - cap }
    : { names, more: 0 };
}

/**
 * The toast after POST /api/docs/:type/activate, from its status and answer.
 * → {text, error}
 */
export function activateToast(status, data) {
  if (status !== 200 || !Array.isArray(data?.results)) {
    const why = data?.message ?? data?.error;
    return {
      text: `활성화 실패 (${status})${why ? ` — ${why}` : ""}`,
      error: true,
    };
  }
  const n = data.activated ?? 0;
  const failed = data.results.filter((r) => r.status === "error");
  if (failed.length) {
    const stale = failed.some((r) => r.error === "unknown_base_rev");
    return {
      text: `${n} 개 활성 · ${failed.length} 개 실패 — ${stale ? "다른 사람이 먼저 고쳤습니다. " : ""}목록을 다시 읽으세요`,
      error: true,
    };
  }
  const skipped = data.results.filter((r) => r.status === "skipped").length;
  return {
    text: `${n} 개 활성${skipped ? ` · ${skipped} 개는 이미 활성` : ""} — 다음 동기화부터 주입됩니다.`,
    error: false,
  };
}
