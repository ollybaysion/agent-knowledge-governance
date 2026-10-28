// A reading-view flow chart in full screen: a <dialog> over the page (⌘K's
// way — showModal, Esc, ::backdrop) with the graph tab's zoom bar, a copy of
// the picture on a stage the pointer drags, and the code box under the stage.
// Also the code box itself, which the reading view puts under each figure.
import { el, icon, toast } from "./dom.mjs";
import { codeToggle, dragScroll, fitZoom, zoomKey, zoomStep } from "/lib/mermaid-src.mjs";

/** The mermaid text box: a head (mermaid · m 줄 · 복사 · `extra`) over the numbered lines. */
export function codeBox(lines, { id, hidden = false, extra = null, cls = "" } = {}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("복사했습니다");
    } catch {
      toast("복사하지 못했습니다 — 코드를 직접 골라 복사하세요", "error");
    }
  };
  return el("div", { class: `mcode${cls ? ` ${cls}` : ""}`, id, hidden }, [
    el("div", { class: "mcode-h" }, [
      el("span", { text: `mermaid · ${lines.length} 줄` }),
      el("span", { class: "sp" }),
      el("button", { type: "button", class: "btn sm ghost", onclick: copy }, [icon("copy", 13), "복사"]),
      extra,
    ]),
    el("pre", { class: "mcode-b" }, el("code", {}, lines.flatMap((l, i) => [el("span", { class: "ln", "aria-hidden": "true", text: String(i + 1) }), l, i < lines.length - 1 ? "\n" : null]))),
  ]);
}

let fullNo = 0;

/**
 * Opens the full-screen view.
 * - picture(): a fresh SVG node of the figure (the mermaid cache's answer), or null.
 * - lines: the code box lines. where: "<section> · <document>" beside the title.
 * - codeOpen: the code box starts open (as the reading view had it).
 * - opener: takes the focus back on close.
 */
export function openFull({ picture, lines, where = "", codeOpen = false, opener = null }) {
  let zoom = null; // null = 화면에 맞춤
  let svg = null;
  let natural = null;
  let drag = null;

  const zoomText = el("span", { class: "gzoom mono", "aria-live": "polite" });
  const inner = el("div", { class: "fs-inner" });
  const stage = el("div", { class: "fs-stage", tabindex: "0", "aria-label": "플로우 차트 — 끌거나 방향키로 옮깁니다" }, inner);
  const codeId = `mmd-full-${++fullNo}`;
  const foldBtn = el("button", { type: "button", class: "btn sm ghost", "aria-controls": codeId, onclick: () => setCode(!code.classList.contains("open")) });
  const code = codeBox(lines, { id: codeId, cls: "fs-code", extra: foldBtn });

  const now = () => zoom ?? fitZoom({ w: stage.clientWidth, h: stage.clientHeight }, natural);
  const setZoom = (z) => {
    zoom = z;
    layout();
  };
  const dlg = el("dialog", { class: "fsd", "aria-label": "플로우 차트 전체 화면" }, [
    el("div", { class: "gbar" }, [
      el("span", { class: "fs-title", text: "플로우 차트" }),
      where ? el("span", { class: "dim", text: where }) : null,
      el("span", { class: "sp" }),
      el("span", { class: "dim gbar-hint", text: "끌어 옮김" }),
      el("button", { type: "button", class: "btn sm", text: "화면에 맞춤", onclick: () => setZoom(null) }),
      zoomText,
      el("button", { type: "button", class: "btn sm ghost", "aria-label": "작게", onclick: () => setZoom(zoomStep(now(), -1)) }, "−"),
      el("button", { type: "button", class: "btn sm ghost", "aria-label": "크게", onclick: () => setZoom(zoomStep(now(), 1)) }, "+"),
      el("button", { type: "button", class: "btn sm ghost", text: "100%", onclick: () => setZoom(1) }),
      el("span", { class: "fs-sep", "aria-hidden": "true" }),
      el("button", { type: "button", class: "btn sm ghost", onclick: () => dlg.close() }, [icon("x", 14), "닫기", el("kbd", { text: "esc" })]),
    ]),
    stage,
    code,
  ]);

  // The picture at natural size × zoom (width and height, so the text stays sharp); the middle of the view stays put.
  function layout() {
    if (!svg || !natural) {
      zoomText.textContent = "";
      return;
    }
    const s = now();
    const mx = (stage.scrollLeft + stage.clientWidth / 2) / Math.max(1, stage.scrollWidth);
    const my = (stage.scrollTop + stage.clientHeight / 2) / Math.max(1, stage.scrollHeight);
    svg.setAttribute("width", String(Math.round(natural.w * s)));
    svg.setAttribute("height", String(Math.round(natural.h * s)));
    stage.scrollLeft = mx * stage.scrollWidth - stage.clientWidth / 2;
    stage.scrollTop = my * stage.scrollHeight - stage.clientHeight / 2;
    zoomText.textContent = `${Math.round(s * 100)}%`;
  }

  function setCode(open) {
    const t = codeToggle(open);
    code.classList.toggle("open", open);
    foldBtn.setAttribute("aria-expanded", t.expanded);
    foldBtn.replaceChildren(icon(open ? "down" : "up", 13), t.label);
    if (zoom === null) layout();
  }

  async function paint() {
    const node = await picture();
    if (!dlg.open) return;
    const box = node?.viewBox?.baseVal;
    if (box?.width && box?.height) {
      node.style.maxWidth = "none";
      svg = node;
      natural = { w: box.width, h: box.height };
      inner.replaceChildren(node);
    } else {
      svg = null;
      natural = null;
      inner.replaceChildren(el("p", { class: "dim", text: "그림을 그리지 못했습니다 — 아래 코드 칸에서 원문을 봅니다" }));
    }
    layout();
  }

  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stage.focus();
    drag = { id: e.pointerId, from: { x: e.clientX, y: e.clientY }, start: { left: stage.scrollLeft, top: stage.scrollTop } };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", (e) => {
    if (drag?.id !== e.pointerId) return;
    const s = dragScroll(drag.start, drag.from, { x: e.clientX, y: e.clientY });
    stage.scrollLeft = s.left;
    stage.scrollTop = s.top;
  });
  const endDrag = (e) => {
    if (drag?.id !== e.pointerId) return;
    drag = null;
    stage.classList.remove("dragging");
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  dlg.addEventListener("keydown", (e) => {
    const k = zoomKey(e);
    if (!k) return;
    e.preventDefault();
    if (k === "in") setZoom(zoomStep(now(), 1));
    else if (k === "out") setZoom(zoomStep(now(), -1));
    else if (k === "one") setZoom(1);
    else if (k === "fit") setZoom(null);
    else {
      stage.scrollLeft += k.dx;
      stage.scrollTop += k.dy;
    }
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) dlg.close();
  });
  const onResize = () => {
    if (zoom === null) layout();
  };
  // The theme switch redraws the copy too, as mermaid.mjs does the page's figures.
  const theme = new MutationObserver(() => paint());
  dlg.addEventListener("close", () => {
    theme.disconnect();
    removeEventListener("resize", onResize);
    dlg.remove();
    opener?.focus?.();
  });

  setCode(codeOpen);
  document.body.append(dlg);
  dlg.showModal();
  stage.focus();
  addEventListener("resize", onResize);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  paint();
  return dlg;
}
