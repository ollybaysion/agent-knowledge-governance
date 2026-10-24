// One section of the reading view: a title (17px) with a faint 편집, then the
// body (14.5px). No box around it. The section an FE answer used
// (?section=<title>) carries a left rule and "답 m_… 이 쓴 절".
import { el, icon } from "./dom.mjs";
import { answerId, answerSection } from "./state.mjs";

const norm = (t) => String(t ?? "").trim().replace(/[?？:：\s]+$/u, "").trim();

export const secId = (key) => `sec-${encodeURIComponent(key).replace(/%/g, "_")}`;

/** True when ?section= names this section. */
export const isAnswerSection = (title) => !!answerSection && norm(answerSection) === norm(title);

/**
 * @param {{key: string, title: string, onEdit?: Function, editLabel?: string,
 *   children: (Node|null)[], extra?: Node|null, cls?: string}} p
 */
export function sec({ key, title, onEdit, editLabel = "편집", children, extra = null, cls = "" }) {
  const marked = isAnswerSection(title);
  return el(
    "section",
    { class: `sec${marked ? " answered" : ""}${cls ? ` ${cls}` : ""}`, id: secId(key), "data-sec": key, "aria-label": title },
    [
      el("div", { class: "sec-h" }, [
        el("h2", { class: "sec-t", text: title }),
        onEdit
          ? el("button", { type: "button", class: "sec-edit", onclick: onEdit, "aria-label": `${title} ${editLabel}` }, [icon("pencil", 13), editLabel])
          : null,
        extra,
        marked ? el("span", { class: "answer-mark", text: answerId ? `답 ${answerId} 이 쓴 절` : "답이 쓴 절" }) : null,
      ]),
      el("div", { class: "sec-b" }, children),
    ],
  );
}

/** Scroll the main column to a section, below the sticky head. */
export function scrollToSec(key, { smooth = true } = {}) {
  const node = document.getElementById(secId(key));
  if (!node) return false;
  node.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1200);
  return true;
}
