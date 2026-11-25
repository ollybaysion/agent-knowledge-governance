// 표 보기의 일괄 동작: 고른 줄에 활성화 · 비활성화 · 태그 붙이기, 끝난 뒤 되돌리기.
// 서버에 이미 있는 길만 쓴다:
//   활성화   = POST /api/docs/:type/activate (타입마다 한 커밋, ACTIVATE_CHUNK 개씩)
//   비활성화 = POST /api/docs/:type/:id/deactivate (문서마다, If-Match)
//   태그     = PUT  /api/docs/:type/:id/tags       (문서마다, If-Match)
// 되돌리기는 반대 동작을 같은 길로 보낸다(활성화 ↔ 비활성화, 붙이기 ↔떼기).
// DOM 없이 계산만 한다. 한 줄의 key 는 "type/id" 다.
import { ACTIVATE_CHUNK, rowKey } from "./doc-bulk.mjs";
import { TAGS_MAX, TAG_RE } from "./tags.mjs";

/** 동작 이름: 띠의 단추 · 확인 창 · 토스트가 같이 쓴다. */
export const VERB = { activate: "활성화", deactivate: "비활성화", tag: "태그 붙이기", untag: "태그 떼기" };

/** 동작을 되돌리는 동작. */
export const UNDO = { activate: "deactivate", deactivate: "activate", tag: "untag", untag: "tag" };

/** 붙일 태그 글을 고친 값: 앞뒤 공백 · "#" 을 떼고 작은 글자로. 규칙에 맞지 않으면 null. */
export function cleanTag(typed) {
  const t = String(typed ?? "").trim().replace(/^#/, "").toLowerCase();
  return TAG_RE.test(t) ? t : null;
}

/** 고른 key 가운데 지금 표에 보이는 줄의 것만: 거르기가 숨긴 줄은 고른 것에서 빠진다. */
export function keepVisible(rows, picked) {
  const keys = new Set(rows.map((r) => rowKey(r.doc)));
  return new Set([...picked].filter((k) => keys.has(k)));
}

/** 머리 상자: 보이는 줄 가운데 고른 것이 "none" · "some" · "all". */
export function headOf(rows, picked) {
  const n = rows.filter((r) => picked.has(rowKey(r.doc))).length;
  if (!n) return "none";
  return n === rows.length ? "all" : "some";
}

/**
 * 고른 문서 가운데 동작이 바꾸는 문서(change)와 건너뛰는 문서(skip, 까닭과 함께).
 * 폐기된 문서는 어느 동작도 건드리지 않는다.
 * → { change: [doc], skip: [{ doc, why }] }
 */
export function plan(docs, action, { tag = null } = {}) {
  const change = [];
  const skip = [];
  for (const d of docs) {
    const tags = d.tags ?? [];
    const why =
      d.status === "archived" ? "폐기된 문서"
      : action === "activate" ? (d.status === "active" ? "이미 활성" : null)
      : action === "deactivate" ? (d.status === "inactive" ? "이미 비활성" : null)
      : action === "tag" ? (tags.includes(tag) ? "이미 붙음" : tags.length >= TAGS_MAX ? `태그가 이미 ${TAGS_MAX} 개` : null)
      : action === "untag" ? (tags.includes(tag) ? null : "붙어 있지 않음")
      : "모르는 동작";
    if (why) skip.push({ doc: d, why });
    else change.push(d);
  }
  return { change, skip };
}

const enc = encodeURIComponent;

/**
 * plan 의 change 문서에 보낼 요청들. 활성화는 타입마다 `max` 개씩 묶고, 나머지는
 * 문서마다 하나다. 문서의 rev 는 목록 응답의 rev 다.
 * → [{ method, path, body, ifMatch, keys: [key] }]
 */
export function requests(action, docs, { tag = null, max = ACTIVATE_CHUNK } = {}) {
  if (action === "activate") {
    const byType = new Map();
    for (const d of docs) {
      if (!byType.has(d.type)) byType.set(d.type, []);
      byType.get(d.type).push(d);
    }
    const out = [];
    for (const [type, list] of byType)
      for (let i = 0; i < list.length; i += max) {
        const part = list.slice(i, i + max);
        out.push({ method: "POST", path: `/api/docs/${enc(type)}/activate`, body: { items: part.map((d) => ({ id: d.id, rev: d.rev })) }, ifMatch: null, keys: part.map(rowKey) });
      }
    return out;
  }
  return docs.map((d) => {
    const base = `/api/docs/${enc(d.type)}/${enc(d.id)}`;
    const keys = [rowKey(d)];
    if (action === "deactivate") return { method: "POST", path: `${base}/deactivate`, body: undefined, ifMatch: d.rev, keys };
    const tags = d.tags ?? [];
    const next = action === "tag" ? [...tags, tag] : tags.filter((t) => t !== tag);
    return { method: "PUT", path: `${base}/tags`, body: { tags: next }, ifMatch: d.rev, keys };
  });
}

/** 서버의 오류 이름 → 화면 글. */
const WHY = {
  unknown_base_rev: "다른 사람이 먼저 고쳤습니다",
  doc_archived: "폐기된 문서",
  not_found: "문서가 없습니다",
  validation_failed: "검사에 걸렸습니다",
  flow_rejected: "흐름 검사가 거부했습니다",
  type_archived: "닫힌 타입",
  if_match_required: "rev 가 없습니다",
  invalid_body: "요청이 맞지 않습니다",
};
export const whyText = (error, status) => WHY[error] ?? (status === 0 ? "서버에 닿지 않았습니다" : error ? `${error}` : `HTTP ${status}`);

/**
 * 응답들 → 문서마다의 결과. responses = [{ req, status, data }] (req = requests() 의 하나).
 * done = 바뀐 문서, same = 이미 그 상태라 그대로인 문서, failed = 바뀌지 않은 문서와 까닭.
 * → { done: [key], same: [key], failed: [{ key, why }] }
 */
export function outcome(responses) {
  const done = [];
  const same = [];
  const failed = [];
  for (const { req, status, data } of responses) {
    if (req.body?.items) {
      if (status !== 200 || !Array.isArray(data?.results)) {
        for (const key of req.keys) failed.push({ key, why: whyText(data?.error, status) });
        continue;
      }
      const type = req.keys[0].slice(0, req.keys[0].indexOf("/"));
      for (const r of data.results) {
        const key = `${type}/${r.id}`;
        if (r.status === "error") failed.push({ key, why: whyText(r.error, 200) });
        else if (r.status === "skipped") same.push(key);
        else done.push(key);
      }
      continue;
    }
    const [key] = req.keys;
    if (status === 200) (data?.unchanged ? same : done).push(key);
    else failed.push({ key, why: whyText(data?.error, status) });
  }
  return { done, same, failed };
}

/**
 * 끝난 뒤의 토스트 글. `undo` = 되돌리기로 보낸 요청이었다.
 * → { text, error }
 */
export function runToast(action, { done, same, failed }, { tag = null, undo = false } = {}) {
  const what = { activate: "활성", deactivate: "비활성", tag: `#${tag} 붙임`, untag: `#${tag} 뗌` }[action];
  const parts = [`${done.length} 개 ${what}`];
  if (same.length) parts.push(`${same.length} 개는 이미 그 상태`);
  if (failed.length) {
    const why = [...new Set(failed.map((f) => f.why))].slice(0, 2).join(" · ");
    parts.push(`${failed.length} 개 실패 — ${why}`);
  }
  const tail = !failed.length && action === "activate" ? " — 다음 동기화부터 주입됩니다." : "";
  return { text: `${undo ? "되돌림: " : ""}${parts.join(" · ")}${tail}`, error: failed.length > 0 };
}
