// ```mermaid fences drawn as pictures. mermaidFig() hands back the figure at
// once; the picture comes from the hidden frame (/mermaid-frame.html, made the
// first time a page has a diagram), so a page without one loads no mermaid.
// The SVG comes in without its <style> and style="" (the page's style-src
// 'self' refuses both): the rules go into a constructed sheet and the
// attributes through node.style — CSSOM, which the policy leaves alone.
import { el, icon } from "./dom.mjs";
import { codeBox, openFull } from "./mermaid-full.mjs";
import { INERT_ATTR, INERT_STYLE, codeLines, codeToggle, debounce, figRowText, inertSvg, mermaidError, mermaidTheme } from "/lib/mermaid-src.mjs";

const FRAME = "/mermaid-frame.html";
const CACHE_MAX = 64;
let frame = null;
let ready = null;
let nextId = 1;
const waiting = new Map(); // render id -> resolve
const cache = new Map(); // theme + text -> {svg} | {error}
const last = new Map(); // figure key -> the last answer, shown dimmed while the next draws
const sheets = new Map(); // svg id -> its constructed sheet
const info = new WeakMap(); // figure -> {text, fenceLine, source, key, notes}
const pending = new Set();

const themeNow = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const cacheKey = (text) => `${themeNow()}\n${text}`;

function openFrame() {
  if (ready) return ready;
  ready = new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error("mermaid 를 불러오지 못했습니다")), 20000);
    addEventListener("message", (e) => {
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
      const m = e.data;
      if (m?.type === "ready") resolve();
      else if (m?.type === "done" || m?.type === "error") {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      }
    });
    frame = el("iframe", { class: "mmd-frame", src: FRAME, title: "mermaid", "aria-hidden": "true", tabindex: "-1" });
    document.body.append(frame);
  });
  return ready;
}

async function draw(text) {
  const key = cacheKey(text);
  if (cache.has(key)) return cache.get(key);
  try {
    await openFrame();
  } catch (err) {
    // Not cached, and the frame goes: the next figure tries again.
    frame?.remove();
    frame = null;
    ready = null;
    return { error: err.message };
  }
  const css = getComputedStyle(document.documentElement);
  const themeVariables = mermaidTheme((name) => css.getPropertyValue(name).trim(), themeNow() === "dark");
  const id = nextId++;
  const answer = await new Promise((resolve) => {
    waiting.set(id, resolve);
    frame.contentWindow.postMessage({ type: "render", id, text, config: { themeVariables } }, location.origin);
  });
  const out = answer.type === "done" ? { svg: answer.svg } : { error: answer.message };
  cache.set(key, out);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

/** The SVG text as a node, its <style> moved to a constructed sheet and its style="" to node.style. */
function svgNode(svgText) {
  // Even an inert DOMParser document checks style="" against the page's
  // policy, so the text is renamed before parsing (inertSvg).
  const root = new DOMParser().parseFromString(inertSvg(svgText), "image/svg+xml").documentElement;
  if (root.nodeName !== "svg") return null;
  let rules = "";
  for (const s of root.querySelectorAll(INERT_STYLE)) {
    rules += s.textContent;
    s.remove();
  }
  const svg = document.importNode(root, true);
  for (const n of [svg, ...svg.querySelectorAll(`[${INERT_ATTR}]`)]) {
    if (!n.hasAttribute(INERT_ATTR)) continue;
    n.style.cssText = n.getAttribute(INERT_ATTR);
    n.removeAttribute(INERT_ATTR);
  }
  if (rules && svg.id && !sheets.has(svg.id)) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rules);
    sheets.set(svg.id, sheet);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  return svg;
}

/** Drop the sheets of pictures no longer on the page. */
function pruneSheets() {
  const gone = [...sheets].filter(([id]) => !document.getElementById(id));
  if (!gone.length) return;
  for (const [id] of gone) sheets.delete(id);
  const drop = new Set(gone.map(([, s]) => s));
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => !drop.has(s));
}

// The flow check's lines under the figure, in the error box mermaid's own errors use.
const notesBox = (notes) =>
  notes?.length
    ? el("div", { class: "mmd-err", role: "status" }, [
        el("b", { text: `플로우 오류 ${notes.length}` }),
        el("pre", { class: "mmd-err-d", text: notes.join("\n") }),
      ])
    : null;

function paint(fig, answer) {
  const { text, fenceLine, source, notes } = info.get(fig);
  fig.classList.remove("waiting", "failed");
  const flow = notesBox(notes);
  const svg = answer.svg ? svgNode(answer.svg) : null;
  if (svg) fig.replaceChildren(...[svg, flow].filter(Boolean));
  else {
    const e = mermaidError(answer.error ?? "SVG 를 읽지 못했습니다", fenceLine, text);
    fig.classList.add("failed");
    const box = el("div", { class: "mmd-err", role: "status" }, [
      el("b", { text: e.title }),
      e.detail ? el("pre", { class: "mmd-err-d", text: e.detail }) : null,
    ]);
    if (source) fig.replaceChildren(...[box, flow, el("pre", { class: "md-code lang-mermaid" }, el("code", {}, text))].filter(Boolean));
    else fig.replaceChildren(...[box, flow].filter(Boolean));
  }
}

let foldNo = 0;

/**
 * The reading view's figure with a line under it (플로우 차트 · 노드 n ·
 * mermaid m 줄): 코드 보기 opens the mermaid text under the line and closes
 * it, 전체 화면 opens the figure in full screen (mermaid-full.mjs).
 */
function withCode(fig, text) {
  const id = `mmd-code-${++foldNo}`;
  const lines = codeLines(text);
  const code = codeBox(lines, { id, hidden: true });
  const codeBtn = el("button", { type: "button", class: "btn sm ghost", "aria-controls": id, onclick: () => set(code.hidden) });
  const fullBtn = el("button", { type: "button", class: "btn sm ghost", "aria-haspopup": "dialog", onclick: () => full() }, [icon("expand", 13), "전체 화면"]);
  const wrap = el("div", { class: "mmd-fold" }, [
    fig,
    el("div", { class: "fig-row" }, [el("span", { text: figRowText(text) }), el("span", { class: "sp" }), codeBtn, fullBtn]),
    code,
  ]);
  const set = (open) => {
    const t = codeToggle(open);
    wrap.classList.toggle("open", open);
    code.hidden = !open;
    codeBtn.setAttribute("aria-expanded", t.expanded);
    codeBtn.replaceChildren(icon("code", 13), t.label);
  };
  const full = () => {
    const where = [wrap.closest("section.sec")?.getAttribute("aria-label"), document.querySelector(".doc-title")?.textContent]
      .filter(Boolean)
      .join(" · ");
    const picture = async () => {
      const answer = await draw(text);
      return answer.svg ? svgNode(answer.svg) : null;
    };
    openFull({ picture, lines, where, codeOpen: !code.hidden, opener: fullBtn });
  };
  set(false);
  return wrap;
}

function fill(fig, answer) {
  const { key } = info.get(fig);
  if (key) last.set(key, answer);
  fig.classList.remove("stale");
  paint(fig, answer);
}

async function flush() {
  soon = false;
  const now = [...pending];
  pending.clear();
  pruneSheets();
  for (const fig of now) {
    // A keyed figure off the page is an editor preview typed past: skip it.
    if (!fig.isConnected && info.get(fig).key) continue;
    fill(fig, await draw(info.get(fig).text));
  }
}
let soon = false;
function flushSoon() {
  if (soon) return;
  soon = true;
  setTimeout(flush, 0);
}
const flushLater = debounce(flush, 300);

/**
 * The figure for one ```mermaid text.
 * - fenceLine: document line of the opening fence, for "N 줄" in errors.
 * - source: under an error, the text itself as a code block.
 * - key: the same figure across repaints (editor). Until its picture comes,
 *   it shows the last one dimmed instead of an empty box.
 * - delay: wait this long after the last request before drawing (300 = typing).
 * - notes: lines under the picture in the error box (the editor's flow check).
 * - code: the reading view's figure — a line under it opens the mermaid text
 *   and the full screen (withCode). The node handed back is then the figure,
 *   the line and the code box.
 */
export function mermaidFig(text, { fenceLine = null, source = true, key = null, delay = 0, notes = null, code = false } = {}) {
  const fig = el("div", { class: "mermaid-fig", role: "figure", "aria-label": "mermaid 도식" });
  info.set(fig, { text, fenceLine, source, key, notes });
  const hit = cache.get(cacheKey(text));
  if (hit) fill(fig, hit);
  else {
    const prev = key ? last.get(key) : null;
    if (prev) {
      paint(fig, prev);
      fig.classList.add("stale");
    } else fig.classList.add("waiting");
    pending.add(fig);
    if (delay) flushLater();
    else flushSoon();
  }
  return code ? withCode(fig, text) : fig;
}

// The theme switch redraws every picture on the page in the new colours.
new MutationObserver(() => {
  for (const fig of document.querySelectorAll(".mermaid-fig")) if (info.has(fig)) pending.add(fig);
  if (pending.size) flushSoon();
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
