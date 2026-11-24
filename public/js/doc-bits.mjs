// 문서 줄에 붙는 작은 조각: 신선도 배지 · 타입 표시 · 문서 링크 · 숫자 글.
import { el, icon } from "./dom.mjs";
import { ageDays, ageLabel, ageTitle, ageTone } from "/lib/freshness.mjs";
import { TYPE_LABEL, typeColor } from "./state.mjs";

/** "3일 전" 배지. 색조는 나이로 정한다. title 이 고친 시각을 그대로 보인다. */
export function freshBadge(updatedAt, now = Date.now()) {
  const days = ageDays(updatedAt, now);
  return el("span", { class: `fresh fresh-${ageTone(days)}`, title: ageTitle(updatedAt, days), text: ageLabel(days) });
}

/** 타입 색 점 + 타입 이름. */
export function typeTag(type) {
  return el("span", { class: "ttag" }, [el("span", { class: "tdot", style: { "--c": typeColor(type) } }), el("span", { text: TYPE_LABEL[type] ?? type })]);
}

export const docHref = (type, id) => `#/doc/${type}/${encodeURIComponent(id)}`;

/**
 * 문서로 가는 링크. data-key 를 가져서 가리키거나 초점이 오면 미리보기 카드가 뜬다.
 * 제목이 있으면 제목, 없으면 id(mono)를 보인다.
 */
export function docLink(doc, { cls = "" } = {}) {
  const title = String(doc.title ?? "").trim();
  return el("a", { class: `dlink${title && title !== doc.id ? "" : " mono"}${cls ? ` ${cls}` : ""}`, href: docHref(doc.type, doc.id), "data-key": `${doc.type}/${doc.id}`, text: title || doc.id });
}

/** 제목 옆에 적는 id(mono). 제목이 없거나 id 와 같으면 링크가 이미 id 를 보이므로 null. */
export function idNote(doc, cls = "") {
  const title = String(doc.title ?? "").trim();
  return title && title !== doc.id ? el("span", { class: `mono dim${cls ? ` ${cls}` : ""}`, text: doc.id }) : null;
}

/** 1234 → "1,234". */
export const num = (n) => Number(n).toLocaleString("en-US");

/** 글자 수: 950 → "950", 12400 → "12.4천". */
export function sizeText(chars) {
  if (chars == null) return "—";
  if (chars < 1000) return String(chars);
  const k = chars / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}천`;
}

/** 문서 탭의 보기 바꾸기: 열 브라우저(#/docs) · 표(#/table). `current` = "columns" | "table". */
export function viewSwitch(current) {
  const item = (id, label, href, ic) =>
    el("a", { class: current === id ? "on" : "", href, ...(current === id ? { "aria-current": "page" } : {}) }, [icon(ic, 13), label]);
  return el("nav", { class: "vsw", "aria-label": "문서 보기" }, [item("columns", "열", "#/docs", "columns"), item("table", "표", "#/table", "grid")]);
}
