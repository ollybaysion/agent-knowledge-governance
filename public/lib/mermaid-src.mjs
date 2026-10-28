// ```mermaid fences: which blocks are diagrams, the theme a diagram takes from
// the page's colour tokens, where a mermaid error points, and the wait before
// a redraw. No DOM here; node tests it.
import { parseBlocks } from "./md-parse.mjs";

/** A parsed block that is a ```mermaid fence. */
export const isMermaid = (block) => block?.type === "code" && String(block.lang).toLowerCase() === "mermaid";

/** The ```mermaid fences of an md text, in order. `line` is the 0-based line of the opening fence. */
export const mermaidFences = (markdown) => parseBlocks(markdown).filter(isMermaid).map((b) => ({ text: b.text, line: b.line }));

/** The diagram line (1-based) a mermaid error names ("Parse error on line 3:"), or null. */
export function errorLine(message) {
  const m = /\bon line (\d+)/i.exec(String(message ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * A mermaid error for the reader. `fenceLine` is the document line of the
 * opening fence: diagram line k is document line fenceLine + k, shown as
 * "N 줄". Without it the line is the diagram's own, shown as "도식 N 줄".
 * → {line, title, detail}: title is the first line of the message with the
 * line number in front, detail is the rest (mermaid's pointer and expectation).
 * mermaid names the line after the last for an error at the end of the text
 * (it adds a newline); with `text` given, that becomes the last line.
 */
export function mermaidError(message, fenceLine = null, text = null) {
  const lines = String(message ?? "").trim().split("\n");
  const named = errorLine(lines[0]);
  const k = named !== null && text !== null ? Math.min(named, String(text).split("\n").length) : named;
  const head = lines[0].replace(/\s+on line \d+/i, "").replace(/:\s*$/, "").trim() || "그리지 못했습니다";
  const line = k === null ? null : fenceLine === null ? k : fenceLine + k;
  const where = k === null ? "" : fenceLine === null ? `도식 ${line} 줄: ` : `${line} 줄: `;
  return { line, title: `${where}${head}`, detail: lines.slice(1).join("\n").trim() };
}

/**
 * mermaid's base-theme variables from the page's colour tokens.
 * `token(name)` gives a custom property's value ("#e9ebef").
 */
export function mermaidTheme(token, dark) {
  return {
    darkMode: !!dark,
    background: token("--field"),
    primaryColor: token("--surface-soft"),
    primaryTextColor: token("--ink"),
    primaryBorderColor: token("--primary"),
    secondaryColor: token("--surface-card"),
    tertiaryColor: token("--canvas"),
    lineColor: token("--muted"),
    textColor: token("--body"),
    noteBkgColor: token("--diff"),
    noteTextColor: token("--diff-ink"),
    noteBorderColor: token("--hairline"),
    fontFamily: token("--sans"),
    fontSize: "14px",
  };
}

export const INERT_STYLE = "akg-mmd-css";
export const INERT_ATTR = "data-akg-style";

/**
 * mermaid's SVG text with <style> renamed to <akg-mmd-css> and style="" to
 * data-akg-style="", so parsing it trips no style-src check. Only text inside
 * tags changes: attribute values escape `"` and `<`, labels escape `<`.
 */
export function inertSvg(svg) {
  return String(svg ?? "").replace(/<[^>]*>/g, (tag) =>
    tag.replace(/^<(\/?)style(?=[\s>/])/i, `<$1${INERT_STYLE}`).replace(/(\s)style=/g, `$1${INERT_ATTR}=`),
  );
}

/** The lines the reading view's code box shows under a figure: the fence text, its last newline dropped. */
export const codeLines = (text) => String(text ?? "").replace(/\n$/, "").split("\n");

/**
 * The reading view's figure after one event: a click, Enter or Space opens a
 * closed code box and closes an open one. → the new open state, or null when
 * the event leaves it as it is.
 */
export function foldNext(open, { type, key } = {}) {
  if (type === "click") return !open;
  if (type === "keydown" && (key === "Enter" || key === " ")) return !open;
  return null;
}

/** `fn` runs once, `ms` after the last call. `.cancel()` drops a waiting run. */
export function debounce(fn, ms) {
  let timer = null;
  const run = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  run.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return run;
}
