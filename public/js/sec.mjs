// One section of the reading view: a title (17px) with a faint 편집, then the
// body (14.5px). No box around it. The section an FE answer used
// (?section=<title>) carries a left rule and "답 m_… 이 쓴 절". A ?section=
// that names a heading path under ## 도메인 지식 marks that heading too.
import { el, icon } from "./dom.mjs";
import { answerId, answerSection } from "./state.mjs";
import { headingPaths, sameSection } from "/lib/sections.mjs";

export const secId = (key) => `sec-${encodeURIComponent(key).replace(/%/g, "_")}`;

/** True when ?section= names this section. */
export const isAnswerSection = (title) => !!answerSection && sameSection(answerSection, title);

const answerMark = () => el("span", { class: "answer-mark", text: answerId ? `답 ${answerId} 이 쓴 절` : "답이 쓴 절" });

/**
 * When ?section= is the path of a heading in `body` (a ## 도메인 지식 body
 * drawn into `node` by sec()), mark that heading and the section. → the
 * heading node, or null.
 */
export function markAnswerHeading(node, body) {
  if (!answerSection) return null;
  const i = headingPaths(body).findIndex((p) => p !== null && sameSection(p, answerSection));
  const heading = i < 0 ? null : node.querySelectorAll(":scope > .sec-b > .md-h")[i];
  if (!heading) return null;
  heading.classList.add("answered");
  node.classList.add("answered");
  node.querySelector(".sec-h")?.append(answerMark());
  return heading;
}

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
        marked ? answerMark() : null,
      ]),
      el("div", { class: "sec-b" }, children),
    ],
  );
}

/** Scroll the main column to a node, below the sticky head (its scroll-margin-top); block "center" for a table row. */
export function scrollToNode(node, { smooth = true, block = "start" } = {}) {
  if (!node) return false;
  node.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1200);
  return true;
}

/** Scroll the main column to a section. */
export const scrollToSec = (key, opts) => scrollToNode(document.getElementById(secId(key)), opts);
