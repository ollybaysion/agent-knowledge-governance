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

const OPEN = { "[": "]", "(": ")", "{": "}" };
const SKIP = /^(flowchart|graph|subgraph|end|classDef|class|style|linkStyle|click|direction|%%)\b/;

/**
 * The nodes a flowchart declares: the ids written with a shape after them
 * (`id[…]`, `id(…)`, `id{…}`, `id[[…]]`, `id([…])`), each counted once.
 * Edge labels (`-->|…|`) and the text inside a shape are skipped. → null for
 * a diagram that is no flowchart (first line not `flowchart` · `graph`).
 */
export function flowNodeCount(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  if (!/^(flowchart|graph)\b/.test(lines[0] ?? "")) return null;
  const ids = new Set();
  for (const raw of lines.slice(1)) {
    if (SKIP.test(raw)) continue;
    const line = raw.replace(/\|[^|]*\|/g, " ");
    for (let i = 0; i < line.length; i++) {
      const m = /^[A-Za-z_][\w-]*/.exec(line.slice(i));
      if (!m || (i > 0 && /[\w-]/.test(line[i - 1]))) continue;
      const after = line[i + m[0].length];
      i += m[0].length - 1;
      if (!(after in OPEN)) continue;
      ids.add(m[0]);
      // Past the shape: its text may hold brackets and words of its own.
      let depth = 0;
      for (i += 1; i < line.length; i++) {
        if (line[i] in OPEN) depth++;
        else if (Object.values(OPEN).includes(line[i]) && --depth === 0) break;
      }
    }
  }
  return ids.size;
}

/** The line under a reading-view figure: "플로우 차트 · 노드 n · mermaid m 줄", the node count left out when it is unknown. */
export function figRowText(text) {
  const nodes = flowNodeCount(text);
  return ["플로우 차트", nodes ? `노드 ${nodes}` : null, `mermaid ${codeLines(text).length} 줄`].filter(Boolean).join(" · ");
}

/** The 코드 보기 button of an open or a closed code box: its label and aria-expanded. */
export const codeToggle = (open) => ({ label: open ? "코드 접기" : "코드 보기", expanded: String(!!open) });

/** The full-screen view's zoom: the graph tab's step and bounds, the stage's inner margin. */
export const ZOOM = { min: 0.25, max: 3, step: 1.15, pad: 24, pan: 32 };

const clampZoom = (z) => Math.max(ZOOM.min, Math.min(ZOOM.max, z));

/** The zoom that fills the stage (the smaller of the two ratios, inside its margin). */
export function fitZoom(stage, natural) {
  if (!natural?.w || !natural?.h) return 1;
  return clampZoom(Math.min((stage.w - 2 * ZOOM.pad) / natural.w, (stage.h - 2 * ZOOM.pad) / natural.h));
}

/** One step in (+1) or out (−1). */
export const zoomStep = (zoom, dir) => clampZoom(zoom * ZOOM.step ** dir);

/** The full-screen view's key: "in" · "out" · "one" (100%) · "fit", or a pan {dx, dy}. → null for any other key. */
export function zoomKey({ key, ctrlKey, metaKey, altKey } = {}) {
  if (ctrlKey || metaKey || altKey) return null;
  if (key === "+" || key === "=") return "in";
  if (key === "-" || key === "_") return "out";
  if (key === "0") return "one";
  if (key === "f" || key === "F") return "fit";
  const pan = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  return pan ? { dx: pan[0] * ZOOM.pan, dy: pan[1] * ZOOM.pan } : null;
}

/** The stage's scroll while a drag moves the pointer from `from` to `to`: the picture follows the pointer. */
export const dragScroll = (start, from, to) => ({ left: start.left - (to.x - from.x), top: start.top - (to.y - from.y) });

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
