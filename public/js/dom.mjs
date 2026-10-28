// ---------- DOM helper ----------
export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    // CSS custom properties and style go through CSSOM: style-src 'self'
    // refuses a style="" attribute, not node.style.
    else if (k === "style" && v && typeof v === "object")
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith("--")) node.style.setProperty(p, val);
        else node.style[p] = val;
      }
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null)
      node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
export const $ = (id) => document.getElementById(id);

// Save an in-memory string as a client-side download. No server round-trip: it
// reuses text api() already fetched. CSP-safe: a `download` anchor is not a
// fetch the `default-src 'self'` policy governs.
export function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---------- toast (prototype pattern — reused for notices/errors) ----------
export let toastTimer = null;
export function toast(message, klass) {
  const t = $("toast");
  t.replaceChildren(el("div", { class: klass || "", text: message }));
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

// ---------- JSON 보기 패널 (승인자 전용 — 문서를 좌우로 갈라 원본 store JSON) ----------
// 모달로 문서를 덮지 않고, 문서 뷰를 좌우로 갈라 오른쪽에 붙인다 — 렌더된 문서와
// 원본 JSON 을 나란히 대조하며 승격을 판단하게. renderInner 가 다시 그릴 때마다
// 최신 doc 으로 새로 만들어지므로 편집·승격 직후 JSON 도 즉시 갱신된다(상태는
// 여는 여부뿐). CSP(script-src 'self') 아래라 인라인 없이 el/addEventListener 로만.
export function jsonPane(title, obj, onClose) {
  const pretty = JSON.stringify(obj, null, 2);
  return el("aside", { class: "json-pane", "aria-label": "원본 JSON" }, [
    el("div", { class: "jm-head" }, [
      el("span", { class: "jm-title", text: title }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        text: "복사",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            toast("JSON 을 복사했습니다.");
          } catch {
            toast("복사할 수 없습니다 — 텍스트를 직접 선택해 복사하세요.", "error");
          }
        },
      }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        "aria-label": "JSON 패널 닫기",
        text: "✕",
        onclick: onClose,
      }),
    ]),
    el("pre", { class: "jm-body", text: pretty }),
  ]);
}

export const SVG_NS = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else if (k === "class") node.setAttribute("class", v);
    else if (k === "style" && v && typeof v === "object")
      for (const [p, val] of Object.entries(v)) node.style.setProperty(p, val);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) if (c) node.appendChild(c);
  return node;
}

// Line icons (24 grid, stroke), drawn inline: the page loads nothing from outside.
const ICONS = {
  chat: [["path", { d: "M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.5-4.6a8.4 8.4 0 0 1-.9-3.9 8.5 8.5 0 0 1 8.4-8.5 8.4 8.4 0 0 1 9 8z" }]],
  book: [["path", { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" }], ["path", { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" }]],
  admin: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
  sun: [["circle", { cx: 12, cy: 12, r: 4 }], ["path", { d: "M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" }]],
  moon: [["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" }]],
  grid: [["rect", { x: 3, y: 3, width: 7, height: 7, rx: 1 }], ["rect", { x: 14, y: 3, width: 7, height: 7, rx: 1 }], ["rect", { x: 14, y: 14, width: 7, height: 7, rx: 1 }], ["rect", { x: 3, y: 14, width: 7, height: 7, rx: 1 }]],
  search: [["circle", { cx: 11, cy: 11, r: 8 }], ["path", { d: "m21 21-4.3-4.3" }]],
  back: [["path", { d: "m12 19-7-7 7-7" }], ["path", { d: "M19 12H5" }]],
  plus: [["path", { d: "M5 12h14" }], ["path", { d: "M12 5v14" }]],
  star: [["polygon", { points: "12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" }]],
  clock: [["circle", { cx: 12, cy: 12, r: 10 }], ["path", { d: "M12 6v6l4 2" }]],
  right: [["path", { d: "m9 18 6-6-6-6" }]],
  left: [["path", { d: "m15 18-6-6 6-6" }]],
  down: [["path", { d: "m6 9 6 6 6-6" }]],
  up: [["path", { d: "m18 15-6-6-6 6" }]],
  pencil: [["path", { d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" }]],
  external: [["path", { d: "M15 3h6v6" }], ["path", { d: "M10 14 21 3" }], ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }]],
  graph: [["circle", { cx: 12, cy: 18, r: 3 }], ["circle", { cx: 6, cy: 6, r: 3 }], ["circle", { cx: 18, cy: 6, r: 3 }], ["path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" }], ["path", { d: "M12 12v3" }]],
  upload: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }], ["path", { d: "M17 8 12 3 7 8" }], ["path", { d: "M12 3v12" }]],
  x: [["path", { d: "M18 6 6 18" }], ["path", { d: "m6 6 12 12" }]],
  pin: [["path", { d: "M12 17v5" }], ["path", { d: "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" }]],
  lock: [["rect", { x: 3, y: 11, width: 18, height: 11, rx: 2 }], ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }]],
  grip: [9, 15].flatMap((x) => [5, 12, 19].map((y) => ["circle", { cx: x, cy: y, r: 1.2 }])),
  columns: [["rect", { x: 3, y: 3, width: 18, height: 18, rx: 2 }], ["path", { d: "M9 3v18" }], ["path", { d: "M15 3v18" }]],
  file: [["path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }], ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }], ["path", { d: "M16 13H8" }], ["path", { d: "M16 17H8" }]],
  check: [["path", { d: "M20 6 9 17l-5-5" }]],
  copy: [["rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }], ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }]],
  code: [["path", { d: "m16 18 6-6-6-6" }], ["path", { d: "m8 6-6 6 6 6" }]],
  expand: [["path", { d: "m15 15 6 6" }], ["path", { d: "m15 9 6-6" }], ["path", { d: "M21 16v5h-5" }], ["path", { d: "M21 8V3h-5" }], ["path", { d: "M3 16v5h5" }], ["path", { d: "m3 21 6-6" }], ["path", { d: "M3 8V3h5" }], ["path", { d: "M9 9 3 3" }]],
  "up-line": [["path", { d: "M5 3h14" }], ["path", { d: "m18 13-6-6-6 6" }], ["path", { d: "M12 7v14" }]],
  "down-line": [["path", { d: "M19 21H5" }], ["path", { d: "m18 11-6 6-6-6" }], ["path", { d: "M12 17V3" }]],
  command: [["path", { d: "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" }]],
};

/** An inline line icon, hidden from assistive tech (the button carries the name). */
export function icon(name, size = 16) {
  return svgEl(
    "svg",
    {
      class: `ic ic-${name}`,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.8,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    (ICONS[name] ?? []).map(([tag, attrs]) => svgEl(tag, attrs)),
  );
}
