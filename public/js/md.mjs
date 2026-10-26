// md → DOM for the reading view: the blocks of /lib/md-parse.mjs drawn with
// el() (textContent only, never innerHTML). `[[id]]` becomes a chip in its
// type's colour, resolved through the server's wikilinks answer. A ```mermaid
// fence becomes a figure (mermaid.mjs).
import { el } from "./dom.mjs";
import { inlineRuns, parseBlocks } from "/lib/md-parse.mjs";
import { isMermaid } from "/lib/mermaid-src.mjs";
import { mermaidFig } from "./mermaid.mjs";
import { TYPE_LABEL, typeColor } from "./state.mjs";

/** The short tag a chip carries: 표 · msg · 메인 · 도메인 · 매뉴얼 … */
export function kindTag(type, role) {
  if (type === "domain-skill") return role === "sub" ? "도메인" : "메인";
  return (
    {
      "db-schema": "표",
      "msg-format": "msg",
      manual: "매뉴얼",
      "screen-map": "화면",
      voc: "VOC",
      "fab-line": "라인",
      unclassified: "미분류",
    }[type] ?? TYPE_LABEL[type] ?? type
  );
}

/**
 * A document chip: tag + id, a link to the doc. `roleOf(type, id)` gives a
 * skill's role. Missing targets are red text with the reason as a title.
 */
export function docChip({ type, id, label, role, href, found = true, title }) {
  if (!found)
    return el("span", { class: "wchip missing", title: title ?? "store 에 없는 문서입니다 — 연결에 들어가지 않습니다" }, [
      el("span", { class: "wchip-t", text: "없음" }),
      label ?? id,
    ]);
  return el(
    "a",
    {
      class: `wchip${type === "domain-skill" ? ` role-${role ?? "main"}` : ""}`,
      href: href ?? `#/doc/${type}/${encodeURIComponent(id)}`,
      "data-key": `${type}/${id}`,
      style: { "--c": typeColor(type) },
    },
    [el("span", { class: "wchip-t", text: kindTag(type, role) }), label ?? id],
  );
}

const SQL_WORDS =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|ORDER|GROUP|BY|DESC|ASC|IS|NULL|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|IN|LIMIT|HAVING|DISTINCT|COUNT|SUM|MAX|MIN|AVG|CASE|WHEN|THEN|ELSE|END|BETWEEN|LIKE|UNION|ALL|WITH|FETCH|FIRST|ROWS|ONLY)\b|('(?:[^']|'')*')|(:[A-Za-z_]\w*)/gi;
function sqlNodes(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(SQL_WORDS)) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)));
    out.push(el("span", { class: m[1] ? "sql-k" : m[2] ? "sql-s" : "sql-b", text: m[0] }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

/**
 * Inline runs of one text. `wiki(inner)` returns the chip for a `[[ ]]`
 * (or null to leave the brackets as text).
 */
export function inline(text, ctx = {}) {
  return inlineRuns(text).map((r) => {
    if (r.code !== undefined) return el("code", { text: r.code });
    if (r.bold !== undefined) return el("b", { text: r.bold });
    if (r.wiki !== undefined) return ctx.wiki?.(r.wiki) ?? document.createTextNode(`[[${r.wiki}]]`);
    if (r.link !== undefined) return el("a", { href: r.href, target: "_blank", rel: "noopener noreferrer", text: r.link });
    return document.createTextNode(r.text);
  });
}

/**
 * The blocks of an md text as nodes. `ctx.wiki` resolves [[ ]].
 * `ctx.mermaid` (editor preview) shapes the ```mermaid figures: {key, lineBase
 * (document line of the text's first line), delay, source} — see mermaidFig.
 */
export function mdNodes(markdown, ctx = {}) {
  const mm = ctx.mermaid ?? {};
  let figNo = 0;
  return parseBlocks(markdown).map((b) => {
    if (isMermaid(b)) {
      const n = figNo++;
      return mermaidFig(b.text, {
        fenceLine: mm.lineBase == null ? null : mm.lineBase + b.line,
        source: mm.source ?? true,
        key: mm.key == null ? null : `${mm.key}#${n}`,
        delay: mm.delay ?? 0,
      });
    }
    switch (b.type) {
      case "h": {
        const tag = `h${Math.min(6, Math.max(3, b.level + 1))}`;
        return el(tag, { class: `md-h md-h${b.level}` }, inline(b.text, ctx));
      }
      case "ul":
      case "ol":
        return el(b.type, { class: "md-list" }, b.items.map((t) => el("li", {}, inline(t, ctx))));
      case "code":
        if (b.lang === "ask")
          return el("div", { class: "md-ask" }, [el("span", { class: "md-ask-t", text: "물음" }), el("span", { text: b.text })]);
        return el("pre", { class: `md-code${b.lang ? ` lang-${b.lang}` : ""}` }, el("code", {}, b.lang === "sql" ? sqlNodes(b.text) : b.text));
      case "table":
        return el("div", { class: "tbl-wrap md-table" }, el("table", {}, [
          el("thead", {}, el("tr", {}, b.head.map((h) => el("th", { scope: "col" }, inline(h, ctx))))),
          el("tbody", {}, b.rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, inline(c, ctx)))))),
        ]));
      case "quote":
        return el("blockquote", { class: "md-quote" }, inline(b.text, ctx));
      case "hr":
        return el("hr", { class: "md-hr" });
      default:
        return el("p", { class: "md-p" }, inline(b.text, ctx));
    }
  });
}

/**
 * The [[ ]] resolver for one document: the server's wikilinks rows
 * ({text, found, type, id, types?}) and the doc list (for a skill's role).
 */
export function wikiResolver(wikilinks, docs) {
  const byText = new Map((wikilinks || []).map((w) => [w.text, w]));
  const roleOf = new Map((docs || []).filter((d) => d.type === "domain-skill").map((d) => [d.id, d.role ?? "main"]));
  return (inner) => {
    const w = byText.get(inner);
    if (w?.found) return docChip({ type: w.type, id: w.id, role: roleOf.get(w.id) });
    return docChip({
      id: inner,
      found: false,
      title: w?.types
        ? `여러 타입에 있습니다(${w.types.join(" · ")}) — [[타입/id]] 로 적으세요`
        : undefined,
    });
  };
}
