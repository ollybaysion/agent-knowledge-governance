// 문서 목록(둘째 열)의 여러 문서 활성화 · 비활성화: 고를 수 있는 줄 · 머리 상자 ·
// 확인 창 이름 목록 · 보내는 요청 · 끝난 뒤 토스트. 화면 상태만 다룬다:
// 고른 것은 저장하지 않고, 타입 · 태그 · 거르기가 바뀌면 처음으로 돌아간다.
// A pick is a row key "type/id": a tag's list holds documents of several types.

/** 확인 창이 이름을 다 적는 문서 수. 넘으면 "… 외 m" 이다. */
export const DIALOG_NAMES = 8;

/** Most rows one POST /api/docs/:type/activate (or …/deactivate) carries — the server's ACTIVATE_MAX. More go in turns. */
export const ACTIVATE_CHUNK = 1000;

/** The two actions: the status a row leaves, the button's name, the state it ends in, what comes next. */
export const ACTIONS = {
  activate: { from: "inactive", label: "활성화", done: "활성", next: "다음 동기화부터 주입됩니다." },
  deactivate: { from: "active", label: "비활성화", done: "비활성", next: "다음 동기화부터 빠집니다." },
};

/** The key a pick is kept under: the row's type and id. */
export const rowKey = (d) => `${d.type}/${d.id}`;

/** True for a row the list lets the admin pick: an active or inactive document. */
export const pickable = (d) => d?.status === "inactive" || d?.status === "active";

/** The rows' pickable keys, in the list's order. */
export const pickableKeys = (rows) => (rows ?? []).filter(pickable).map(rowKey);

/**
 * The head box over `rows` with `picked` (a Set of keys): "none" · "some"
 * (indeterminate) · "all" (every pickable row picked). No pickable row = "none".
 */
export function headState(rows, picked) {
  const keys = pickableKeys(rows);
  const n = keys.filter((k) => picked.has(k)).length;
  if (!n) return "none";
  return n === keys.length ? "all" : "some";
}

/** A press on the head box: every pickable row, or none when all were picked. */
export function toggleAll(rows, picked) {
  return headState(rows, picked) === "all" ? new Set() : new Set(pickableKeys(rows));
}

/** `picked` with `key` added, or taken out when it is there; the input is left alone. */
export function togglePicked(picked, key) {
  const next = new Set(picked);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * `picked` kept to the keys still pickable in `rows` — the selection after
 * the list changed under it.
 */
export function keepPicked(rows, picked) {
  const keys = new Set(pickableKeys(rows));
  return new Set([...picked].filter((k) => keys.has(k)));
}

/**
 * The picks for column 2 now showing `scope` (a type id, or "#tag" for a
 * tag's documents across the types) with `rows`: {scope, keys}. Another scope
 * starts empty; the same scope keeps the keys still pickable in `rows`.
 */
export const picksFor = (prev, scope, rows) =>
  prev?.scope === scope ? { scope, keys: keepPicked(rows, prev.keys) } : { scope, keys: new Set() };

/** The picked rows, in the list's order; with `action`, the ones it changes. */
export const pickedRows = (rows, picked, action = null) =>
  (rows ?? []).filter((d) => pickable(d) && picked.has(rowKey(d)) && (!action || d.status === ACTIONS[action].from));

/** The band's buttons for the picks: 활성화 when one is inactive, 비활성화 when one is active. */
export const bulkActions = (rows, picked) =>
  Object.keys(ACTIONS).filter((action) => pickedRows(rows, picked, action).length > 0);

/**
 * The requests for the picked rows `action` changes: one
 * POST /api/docs/:type/<action> per type, in the list's order, each carrying
 * at most `max` items {id, rev}.
 * @returns {{type: string, items: {id: string, rev: string}[]}[]}
 */
export function activateRequests(rows, picked, action = "activate", max = ACTIVATE_CHUNK) {
  const byType = new Map();
  for (const d of pickedRows(rows, picked, action)) {
    if (!byType.has(d.type)) byType.set(d.type, []);
    byType.get(d.type).push({ id: d.id, rev: d.rev });
  }
  const out = [];
  for (const [type, items] of byType) {
    for (let i = 0; i < items.length; i += max) out.push({ type, items: items.slice(i, i + max) });
  }
  return out;
}

/** The rows' types with how many of each, in the list's order: the dialog's line under the title. */
export function typeCounts(rows) {
  const counts = new Map();
  for (const d of rows ?? []) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => ({ type, n }));
}

/** A row's name in the dialog: the id, then the title when it says more. */
export const dialogName = (d) => (d.title && d.title !== d.id ? `${d.id} · ${d.title}` : d.id);

/** The dialog's name list: the first DIALOG_NAMES names, and how many more. */
export function dialogNames(rows, cap = DIALOG_NAMES) {
  const names = rows.map(dialogName);
  return names.length > cap ? { names: names.slice(0, cap), more: names.length - cap } : { names, more: 0 };
}

const answered = (r) => r.status === 200 && Array.isArray(r.data?.results);

/**
 * The toast after the requests of `action`, from each one's status and answer.
 * @param {{status: number, data: any}[]} responses
 * @returns {{text: string, error: boolean}}
 */
export function activateToast(responses, action = "activate") {
  const { label, done, next } = ACTIONS[action];
  const list = Array.isArray(responses) ? responses : [responses];
  const n = list.filter(answered).reduce((sum, r) => sum + (r.data[`${action}d`] ?? 0), 0);
  const refused = list.find((r) => !answered(r));
  if (refused) {
    const why = refused.data?.message ?? refused.data?.error;
    return {
      text: `${label} 실패 (${refused.status})${why ? ` — ${why}` : ""}${n ? ` · ${n} 개는 ${done}` : ""}`,
      error: true,
    };
  }
  const results = list.flatMap((r) => r.data.results);
  const failed = results.filter((r) => r.status === "error");
  if (failed.length) {
    const stale = failed.some((r) => r.error === "unknown_base_rev");
    return {
      text: `${n} 개 ${done} · ${failed.length} 개 실패 — ${stale ? "다른 사람이 먼저 고쳤습니다. " : ""}목록을 다시 읽으세요`,
      error: true,
    };
  }
  const skipped = results.filter((r) => r.status === "skipped").length;
  return {
    text: `${n} 개 ${done}${skipped ? ` · ${skipped} 개는 이미 ${done}` : ""} — ${next}`,
    error: false,
  };
}
