// md → DOM for the reading view: the blocks of /lib/md-parse.mjs drawn with
// el() (textContent only, never innerHTML). `[[id]]` becomes a chip in its
// type's colour, resolved through the server's wikilinks answer. A ```mermaid
// fence becomes a figure (mermaid.mjs). ![글](asset:<sha256>) alone on its
// line is a figure in the same frame, with the 글 as its caption; inside a
// line it is a picture one line high. A click opens the picture in a new tab.
import { el } from "./dom.mjs";
import { assetIndex, figureOf } from "/lib/doc-assets.mjs";
import { inlineRuns, parseBlocks } from "/lib/md-parse.mjs";
import { isMermaid } from "/lib/mermaid-src.mjs";
import { mermaidFig } from "./mermaid.mjs";
import { sqlCode } from "./sql.mjs";
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

// What stands where a picture failed to load — the manual's capture words.
const noPicture = (sha256) => el("span", { class: "md-nofig dim", text: `캡처를 불러오지 못했습니다 (${sha256.slice(0, 8)})` });

function pictureLink(f, cls, label) {
  return el("a", { class: `${cls}-a`, href: f.src, target: "_blank", rel: "noopener noreferrer", "aria-label": label }, [
    el("img", {
      class: cls,
      src: f.src,
      alt: f.alt,
      width: f.width,
      height: f.height,
      loading: "lazy",
      onerror: (e) => e.currentTarget.parentElement.replaceWith(noPicture(f.sha256)),
    }),
  ]);
}

/**
 * One picture as a figure: the mermaid figure's frame (body width), the
 * picture centred, its alt as the caption under it. `f` = figureOf().
 */
export function pictureFig(f) {
  return el("figure", { class: "mermaid-fig md-fig" }, [
    pictureLink(f, "md-img", `${f.alt || "그림"} — 새 탭에서 열기`),
    f.alt ? el("figcaption", { class: "md-fig-cap", text: f.alt }) : null,
  ]);
}

/**
 * Inline runs of one text. `wiki(inner)` returns the chip for a `[[ ]]`
 * (or null to leave the brackets as text). `assets` = the document's
 * assets[], for a picture's size and alt.
 */
export function inline(text, ctx = {}) {
  const byId = assetIndex(ctx.assets);
  return inlineRuns(text).map((r) => {
    if (r.code !== undefined) return el("code", { text: r.code });
    if (r.bold !== undefined) return el("b", { text: r.bold });
    if (r.wiki !== undefined) return ctx.wiki?.(r.wiki) ?? document.createTextNode(`[[${r.wiki}]]`);
    if (r.link !== undefined) return el("a", { href: r.href, target: "_blank", rel: "noopener noreferrer", text: r.link });
    if (r.img !== undefined) {
      const f = figureOf(r.img, { alt: r.alt, entry: byId.get(r.img) });
      return pictureLink(f, "md-inimg", `${f.alt || "그림"} — 새 탭에서 열기`);
    }
    return document.createTextNode(r.text);
  });
}

/**
 * The blocks of an md text as nodes. `ctx.wiki` resolves [[ ]].
 * `ctx.mermaid` (editor preview) shapes the ```mermaid figures: {key, lineBase
 * (document line of the text's first line), delay, source, flowNotes (the
 * flow check's lines for the first figure before any heading — the flow
 * fence of a 데이터 body)} — see mermaidFig. `ctx.assets` = the document's
 * assets[] (a picture's size and alt).
 */
export function mdNodes(markdown, ctx = {}) {
  const mm = ctx.mermaid ?? {};
  const byId = assetIndex(ctx.assets);
  let figNo = 0;
  let heading = false;
  return parseBlocks(markdown).map((b) => {
    if (isMermaid(b)) {
      const n = figNo++;
      return mermaidFig(b.text, {
        fenceLine: mm.lineBase == null ? null : mm.lineBase + b.line,
        source: mm.source ?? true,
        key: mm.key == null ? null : `${mm.key}#${n}`,
        delay: mm.delay ?? 0,
        notes: n === 0 && !heading ? mm.flowNotes ?? null : null,
        // The reading view (no editor ctx): a line under the figure opens the mermaid text and the full screen.
        code: !ctx.mermaid,
      });
    }
    if (b.type === "h") heading = true;
    switch (b.type) {
      case "h": {
        const tag = `h${Math.min(6, Math.max(3, b.level + 1))}`;
        return el(tag, { class: `md-h md-h${b.level}` }, inline(b.text, ctx));
      }
      case "ul":
      case "ol":
        return el(b.type, { class: "md-list" }, b.items.map((t) => el("li", {}, inline(t, ctx))));
      case "code":
        return el("pre", { class: `md-code${b.lang ? ` lang-${b.lang}` : ""}` }, b.lang === "sql" ? sqlCode(b.text) : el("code", {}, b.text));
      case "table":
        return el("div", { class: "tbl-wrap md-table" }, el("table", {}, [
          el("thead", {}, el("tr", {}, b.head.map((h) => el("th", { scope: "col" }, inline(h, ctx))))),
          el("tbody", {}, b.rows.map((r) => el("tr", {}, r.map((c) => el("td", {}, inline(c, ctx)))))),
        ]));
      case "quote":
        return el("blockquote", { class: "md-quote" }, inline(b.text, ctx));
      case "hr":
        return el("hr", { class: "md-hr" });
      case "img":
        return pictureFig(figureOf(b.sha256, { alt: b.alt, entry: byId.get(b.sha256) }));
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
