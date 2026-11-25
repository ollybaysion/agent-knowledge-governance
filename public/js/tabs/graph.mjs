// 그래프 탭(5-v4). Four pictures of the same graph:
//   둘레 — one doc in the middle as a card, the docs that point at it on the
//          left, the docs it points at on the right (graph-model egoView),
//          at reading size. A neighbour's card re-centers; the trail goes back.
//   전체 — every linked doc as a dot (layoutColumns wrapped by wrapRows), a
//          long run of one type folded into one "+N 문서" node (groupColumns ·
//          mergeEdges) that opens on a press, wheel to zoom, drag to move,
//          names thinned by declutter, a minimap.
//   행렬 — links counted type by type (typeMatrix): rows point, columns are
//          pointed at, an empty cell is drawn as empty. A cell lists its links
//          and the docs of the row that link no doc of the column (matrixCell).
//   경로 — the fewest links between two docs (shortestPaths), as columns of
//          cards like 둘레. 출발 · 도착 come from two search boxes, or from a
//          Shift+click on another doc while one is picked.
// With no doc picked, 둘레 is the start screen: 메인 에이전트 and 허브 lists.
// Top: 문서 찾기 (id · title · keyword). Left: 고른 문서 · 범례 = 타입 필터 ·
// 목록(허브 · 연결 없음 · 끊긴 연결). Address: #/graph · #/graph/<type>/<id> ·
// #/graph/matrix · #/graph/path?from=<key>&to=<key>[&dir=1].
import { allDocs, docsVersion, lastScore } from "../api.mjs";
import { el, icon, svgEl } from "../dom.mjs";
import { kindTag } from "../md.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPES, TYPE_LABEL, setLastDoc, typeColor } from "../state.mjs";
import { openDocWithPanel } from "./doc-view.mjs";
import { searchDocs } from "/lib/search.mjs";

const graphLib = import("/lib/shared/graph-model.mjs");
const enc = encodeURIComponent;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (n) => n.toLocaleString("ko-KR");

// Kept while the page lives: the picture, the filter, the docs walked through.
const view = {
  mode: "ego", // "ego" 둘레 | "all" 전체 | "matrix" 행렬 | "path" 경로
  depth: 1,
  hidden: new Set(),
  roles: new Set(["main", "sub"]),
  trail: [],
  open: { hubs: false, orphans: false, broken: false },
  groups: new Set(), // 전체: the folded runs opened
  cell: null, // 행렬: the picked cell { from, to } (a kind, or null for the side row · column)
  path: { from: null, to: null, directed: false },
};
const MODES = ["matrix", "path"]; // the modes with an address of their own
let live = null; // the mounted screen: { root, version, route }

// 둘레 · 경로: a card per doc.
const CARD_W = 188;
const CARD_H = 46;
const CARD_ROW = 58;
const EGO_HEAD = 30;
const EGO_PAD = 20;
const EGO_CAP = 10;
const EGO_MIN_SCALE = 0.96; // the name stays 13px or more on screen
const PATH_LIMIT = 6; // 경로: the shortest paths drawn
const PATH_MIN_SCALE = 0.8; // 경로: both ends on screen matter more than 14px names (11px or more)
// 전체: a dot per doc, one cell each.
const CELL_W = 210;
const CELL_H = 30;
const COL_GAP = 90;
const ALL_PAD = 32;
const ALL_HEAD = 34;
const NAME_FONT = "13.5px";
const GROUP_FONT = "700 13.5px";
const REST_NAMES_FROM = 0.3; // 전체: below this scale only the picked · pointed-at · main · hub names show
const GROUP_AT = 12; // 전체: a column's run of one type longer than this folds into one node
const TRAIL_SHOWN = 4;
const LIST_STEP = 80;

let ticket = 0;
/** `mode` = "matrix" · "path" when the address names one (#/graph/matrix · #/graph/path?…). */
export async function renderGraph(selKey, { mode = null } = {}) {
  setActiveTab("graph");
  setCrumbs([{ label: "그래프" }]);
  if (live?.root.isConnected && live.version === docsVersion) return live.route(selKey, mode);
  const my = ++ticket;
  const [lib, docs] = await Promise.all([graphLib, allDocs()]);
  if (my !== ticket) return;
  const graphTypes = DOC_TYPES.filter((t) => t !== "fab-line");
  const full = lib.buildGraph(docs, graphTypes);
  const byKey = new Map(docs.map((d) => [`${d.type}/${d.id}`, d]));
  // Edges a body's [[ ]] made, and the [[ ]] that point nowhere.
  const bodyEdge = new Set();
  const broken = [];
  for (const d of docs) {
    const from = `${d.type}/${d.id}`;
    if (!full.nodes.has(from)) continue;
    for (const w of d.wikilinks ?? []) {
      if (w.found) bodyEdge.add(`${from}>${w.type}/${w.id}`);
      else broken.push({ from, text: w.text });
    }
  }
  let sel = selKey && full.nodes.has(selKey) ? selKey : null;
  takeMode(mode);
  if (sel) view.mode = "ego";
  walk(sel);
  let more = {}; // 둘레: level → the cap 더 보기 raised
  let g = full; // the graph after the filter
  let deg = new Map();
  let listsFor = null; // the filter the 목록 were last made for

  const typeName = (t) => (t === "domain-skill" ? "스킬 문서" : TYPE_LABEL[t] ?? t);
  /** 행렬 · 묶음의 종류 이름: domain-skill 은 main · sub 로 갈린다. */
  const kindName = (k) => (k === "main" ? "main 스킬" : k === "sub" ? "sub 스킬" : typeName(k));
  const labelName = (n) => (n.type === "db-schema" || n.type === "msg-format" ? n.id : n.name);
  const openDoc = (n) => openDocWithPanel(n.type, n.id, "links");
  function shown(n) {
    if (view.hidden.has(n.type)) return false;
    if (n.type === "domain-skill" && !view.roles.has(n.kind)) return false;
    return true;
  }
  /** The mode the address names; any other address is 둘레 · 전체. */
  function takeMode(m) {
    if (m === "path") {
      const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
      const key = (k) => (k && full.nodes.has(k) ? k : null);
      view.path = { from: key(q.get("from")), to: key(q.get("to")), directed: q.get("dir") === "1" };
    }
    if (MODES.includes(m)) view.mode = m;
    else if (MODES.includes(view.mode)) view.mode = "ego";
  }

  // ---------- 글자 폭 · 모양 ----------
  const ctx2 = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(document.body).fontFamily;
  const widths = new Map();
  function textW(s, font) {
    const k = `${font}|${s}`;
    if (!widths.has(k)) {
      ctx2.font = `${font} ${family}`;
      widths.set(k, ctx2.measureText(s).width);
    }
    return widths.get(k);
  }
  /** `s` cut to `max` px, with … where it was cut. */
  function clip(s, font, max) {
    if (textW(s, font) <= max) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textW(`${s.slice(0, mid)}…`, font) <= max) lo = mid;
      else hi = mid - 1;
    }
    return `${s.slice(0, lo)}…`;
  }
  /** A doc's mark: shape = type, color = type, hollow = 비활성, ring = main, small = sub. */
  function shapeNodes(n, r) {
    const c = typeColor(n.type);
    const path = svgEl("path", {
      d: lib.shapePath(lib.shapeOf(n.type, graphTypes), n.kind === "sub" ? r * 0.7 : r),
      class: `gshape${n.status === "inactive" ? " hollow" : ""}`,
      style: { "--c": c },
    });
    return n.kind === "main" ? [svgEl("circle", { r: r + 3.5, class: "gring", style: { "--c": c } }), path] : [path];
  }
  /** The same mark as a small picture of its own, for a list row. */
  const glyph = (n, size = 18) =>
    svgEl("svg", { class: "gglyph", width: size, height: size, viewBox: "-10 -10 20 20", "aria-hidden": "true" }, shapeNodes(n, n.kind === "main" ? 5 : 6.5));
  const sample = (type, more) => ({ type, kind: type, status: "active", ...more });
  /** A kind's mark: main · sub are domain-skill's two, any other kind is its type. */
  const kindSample = (k) => (k === "main" || k === "sub" ? sample("domain-skill", { kind: k }) : sample(k));
  /** A list row for a doc: mark · name · what stands at the right. */
  function docRow(n, right, attrs) {
    const name = labelName(n);
    return el("button", { type: "button", class: "grow", title: name === n.id ? `${typeName(n.type)} · ${n.id}` : `${typeName(n.type)} · ${n.id}\n${name}`, ...attrs }, [
      glyph(n),
      el("span", { class: "grow-name", text: name }),
      n.status === "inactive" ? el("span", { class: "grow-off", text: "비활성" }) : null,
      right != null ? el("span", { class: "grow-n", text: right }) : null,
    ]);
  }
  const linkCounts = (key) => `← ${deg.get(key)?.in ?? 0} · → ${deg.get(key)?.out ?? 0}`;

  // ---------- 문서 찾기 칸: 위 띠 하나 · 경로의 출발 · 도착 둘 ----------
  const order = TYPES.map((t) => t.id);
  /**
   * A search box over the docs (id · title · keyword), 8 results with ↑ ↓ ↩.
   * `keep` = the box shows the picked doc's name afterwards (출발 · 도착).
   */
  function docPicker({ id, placeholder, label, onPick, keep = false }) {
    const input = el("input", {
      type: "search",
      class: "psearch",
      placeholder,
      "aria-label": label,
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": `${id}-list`,
      "aria-autocomplete": "list",
      autocomplete: "off",
      spellcheck: "false",
    });
    const list = el("ul", { class: "gsearch-list", id: `${id}-list`, role: "listbox", "aria-label": "찾은 문서", hidden: true });
    let found = [];
    let active = -1;
    let picked = null;
    const close = () => {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    };
    function paint() {
      const q = input.value.trim();
      if (!q || (keep && picked && q === labelName(picked))) {
        found = [];
        return close();
      }
      const low = q.toLowerCase();
      const head = (d) => d.id.toLowerCase().startsWith(low) || (d.title ?? "").toLowerCase().startsWith(low);
      const weight = (d) => {
        const x = deg.get(`${d.type}/${d.id}`);
        return x ? x.in + x.out : 0;
      };
      const all = searchDocs(docs, { q, order })
        .flatMap((grp) => grp.docs)
        .filter((d) => full.nodes.has(`${d.type}/${d.id}`))
        .sort((a, b) => head(b) - head(a) || weight(b) - weight(a) || a.id.localeCompare(b.id));
      found = all.slice(0, 8).map((d) => full.nodes.get(`${d.type}/${d.id}`));
      active = found.length ? 0 : -1;
      // replaceChildren writes a null as the text "null": the note row goes in only when there is one.
      const note = found.length
        ? all.length > found.length
          ? el("li", { class: "gsearch-note", role: "presentation", text: `${num(all.length)} 문서 가운데 ${found.length} — 글자를 더 넣으면 좁혀집니다` })
          : null
        : el("li", { class: "gsearch-note", role: "presentation", text: "맞는 문서가 없습니다" });
      list.replaceChildren(
        ...found.map((n, i) => {
          const name = labelName(n);
          const li = el("li", { class: "gsearch-opt", id: `${id}-opt-${i}`, role: "option", "aria-selected": String(i === active) }, [
            glyph(n),
            el("span", { class: "grow-name" }, [name, name === n.id ? null : el("span", { class: "gsearch-id mono", text: ` ${n.id}` })]),
            el("span", { class: "grow-n", text: `연결 ${weight(n)}` }),
          ]);
          // mousedown keeps the caret in the input; the click then picks.
          li.addEventListener("mousedown", (e) => e.preventDefault());
          li.addEventListener("click", () => pick(i));
          return li;
        }),
        ...(note ? [note] : []),
      );
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      mark();
    }
    function mark() {
      [...list.querySelectorAll(".gsearch-opt")].forEach((li, i) => li.setAttribute("aria-selected", String(i === active)));
      if (active >= 0) input.setAttribute("aria-activedescendant", `${id}-opt-${active}`);
      else input.removeAttribute("aria-activedescendant");
    }
    function pick(i) {
      const n = found[i];
      if (!n) return;
      picked = keep ? n : null;
      input.value = keep ? labelName(n) : "";
      found = [];
      close();
      onPick(n);
    }
    input.addEventListener("input", paint);
    input.addEventListener("focus", () => {
      if (keep && picked) input.select();
      paint();
    });
    input.addEventListener("blur", () => {
      close();
      // A box left half-typed shows the doc it holds again.
      if (keep) input.value = picked ? labelName(picked) : "";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!found.length) return;
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + found.length) % found.length;
        mark();
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(active);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault();
        found = [];
        close();
      }
    });
    const box = el("div", { class: "gsearch" }, [el("label", { class: "psearch-w" }, [icon("search", 15), input]), list]);
    return {
      box,
      input,
      /** The doc the box holds (keep boxes): its name stands in the box. */
      set(n) {
        picked = n ?? null;
        if (document.activeElement !== input) input.value = picked ? labelName(picked) : "";
      },
    };
  }
  const search = docPicker({
    id: "gsearch",
    placeholder: "문서 찾기 — id · 제목 · 키워드",
    label: "그래프에서 문서 찾기",
    onPick: (n) => {
      view.mode = "ego";
      go(n.key, { focus: true });
    },
  });

  // ---------- 왼쪽: 고른 문서 · 범례 = 필터 · 목록 ----------
  const counts = new Map();
  for (const n of full.nodes.values()) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const toggle = (on, onclick, children, label) => el("button", { type: "button", class: "gleg-row", "aria-pressed": String(on), "aria-label": label, onclick }, children);
  const flip = (set, id) => (e) => {
    if (set.has(id)) set.delete(id);
    else set.add(id);
    e.currentTarget.setAttribute("aria-pressed", String(!e.currentTarget.matches("[aria-pressed=true]")));
    refresh();
  };
  const legendBox = el("div", { class: "psec gleg" }, [
    el("div", { class: "plabel prow" }, [el("span", { text: "범례 · 타입 필터" }), el("span", { class: "gleg-hint", text: "누르면 켜고 끕니다" })]),
    el("ul", { class: "gleg-list" }, TYPES.filter((t) => graphTypes.includes(t.id)).map((t) =>
      el("li", {}, toggle(!view.hidden.has(t.id), (e) => {
        const on = view.hidden.has(t.id);
        if (on) view.hidden.delete(t.id);
        else view.hidden.add(t.id);
        e.currentTarget.setAttribute("aria-pressed", String(on));
        refresh();
      }, [glyph(sample(t.id)), el("span", { class: "grow-name", text: typeName(t.id) }), el("span", { class: "grow-n", text: num(counts.get(t.id) ?? 0) })], `${typeName(t.id)} ${counts.get(t.id) ?? 0} 문서 보이기`)),
    )),
    el("div", { class: "gleg-roles" }, [
      toggle(view.roles.has("main"), flip(view.roles, "main"), [glyph(sample("domain-skill", { kind: "main" })), el("span", { class: "grow-name", text: "main 스킬" })], "main 스킬 보이기"),
      toggle(view.roles.has("sub"), flip(view.roles, "sub"), [glyph(sample("domain-skill", { kind: "sub" })), el("span", { class: "grow-name", text: "sub 스킬" })], "sub 스킬 보이기"),
    ]),
  ]);
  const line = (cls, label) =>
    el("span", { class: "gl-item" }, [
      svgEl("svg", { width: 30, height: 14, viewBox: "0 0 30 14", "aria-hidden": "true" }, [
        svgEl("line", { x1: 1, y1: 7, x2: 22, y2: 7, class: `ge ${cls}` }),
        svgEl("path", { d: "M21 3L29 7L21 11Z", class: `gmk ${cls}` }),
      ]),
      label,
    ]);
  const keyBox = el("div", { class: "psec glegend" }, [
    el("div", { class: "plabel", text: "선 · 상태" }),
    el("div", { class: "gl-grid" }, [
      line("", "links"),
      line("body", "본문 [[ ]]"),
      line("scr", "rel screen"),
      line("broken", "끊긴 연결"),
      el("span", { class: "gl-item" }, [glyph(sample("db-schema")), "활성"]),
      el("span", { class: "gl-item" }, [glyph(sample("db-schema", { status: "inactive" })), "비활성"]),
    ]),
    el("p", { class: "dim gl-note", text: "화살표는 가리키는 쪽입니다. ← 수 = 가리켜짐, → 수 = 가리킴. 전체 보기의 굵은 선은 묶음으로 가는 선 여럿입니다." }),
  ]);
  const summary = el("div", { class: "psec gsum" });
  const lists = el("div", { class: "psec glists" });
  const left = panel("left graph-panel", [el("div", { class: "panel-scroll gpanel" }, [summary, lists, legendBox, keyBox])], "그래프 — 고른 문서 · 목록 · 범례");

  // ---------- 가운데: 띠 · 지나온 문서 · 경로 띠 · 그림 ----------
  const seg = (label, items, current, onpick) => {
    const box = el("div", { class: "seg", role: "group", "aria-label": label }, items.map(([text, v, title]) =>
      el("button", { type: "button", "aria-pressed": String(v === current()), text, title, onclick: () => onpick(v) })));
    box.sync = () => [...box.children].forEach((b, i) => b.setAttribute("aria-pressed", String(items[i][1] === current())));
    return box;
  };
  const modeSeg = seg(
    "보기",
    [
      ["둘레", "ego", "고른 문서와 그 이웃만"],
      ["전체", "all", "연결된 문서 전부"],
      ["행렬", "matrix", "타입 사이 연결 수"],
      ["경로", "path", "두 문서 사이의 가장 짧은 길"],
    ],
    () => view.mode,
    (v) => setMode(v),
  );
  const depthSeg = seg("깊이", [["1", 1], ["2", 2], ["3", 3]], () => view.depth, (v) => {
    view.depth = v;
    more = {};
    refresh();
  });
  const depthBox = el("span", { class: "gdepth" }, [el("span", { class: "dim", text: "깊이" }), depthSeg]);
  const hint = el("span", { class: "dim gbar-hint" });
  const zoomText = el("span", { class: "gzoom mono", "aria-live": "polite" });
  const regroup = el("button", { type: "button", class: "btn sm ghost", text: "묶음 다시 접기", title: "펼친 묶음을 모두 다시 접습니다", onclick: () => {
    view.groups.clear();
    refresh();
  } });
  const zoomBox = el("span", { class: "gzoom-box" }, [
    regroup,
    el("button", { type: "button", class: "btn sm", text: "화면에 맞춤", onclick: () => fit() }),
    zoomText,
    el("button", { type: "button", class: "btn sm ghost", "aria-label": "작게", onclick: () => zoomBy(1 / 1.25) }, "−"),
    el("button", { type: "button", class: "btn sm ghost", "aria-label": "크게", onclick: () => zoomBy(1.25) }, "+"),
  ]);
  const marker = (id, cls) =>
    svgEl("marker", { id, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: "userSpaceOnUse", orient: "auto-start-reverse" }, svgEl("path", { d: "M0 1L10 5L0 9Z", class: `gmk ${cls}` }));
  const world = svgEl("g", { class: "gworld" });
  const svg = svgEl("svg", { class: "gsvg", role: "group" }, [svgEl("defs", {}, [marker("gmk", ""), marker("gmk-on", "on"), marker("gmk-scr", "scr"), marker("gmk-broken", "broken")]), world]);
  const canvas = el("div", { class: "gcanvas", tabindex: "0", role: "application", "aria-label": "그래프 그림 — 화살표 키로 옮기고 + − 로 확대, 0 으로 맞춤" }, svg);
  const start = el("div", { class: "gstart" });
  const matrixBox = el("div", { class: "gstart gmatrix" });
  const trailBox = el("nav", { class: "gtrail", "aria-label": "지나온 문서" });
  // 경로: 출발 · 도착 · 방향
  const fromPick = docPicker({ id: "gpath-from", placeholder: "출발 문서", label: "경로의 출발 문서", keep: true, onPick: (n) => setPath({ from: n.key }) });
  const toPick = docPicker({ id: "gpath-to", placeholder: "도착 문서", label: "경로의 도착 문서", keep: true, onPick: (n) => setPath({ to: n.key }) });
  const dirBtn = el("button", { type: "button", class: "btn sm gdir", "aria-pressed": "false", title: "켜면 선을 가리키는 쪽으로만 따라갑니다", onclick: () => setPath({ directed: !view.path.directed }) }, [icon("right", 13), "가리키는 방향만"]);
  const pathNote = el("span", { class: "gpath-note", role: "status" });
  const pathBar = el("div", { class: "gpathbar", role: "group", "aria-label": "두 문서 사이 경로" }, [
    el("span", { class: "gpath-k", text: "출발" }),
    fromPick.box,
    el("button", { type: "button", class: "btn sm ghost gswap", "aria-label": "출발과 도착 바꾸기", title: "출발과 도착 바꾸기", onclick: () => setPath({ from: view.path.to, to: view.path.from }) }, "⇄"),
    el("span", { class: "gpath-k", text: "도착" }),
    toPick.box,
    dirBtn,
    pathNote,
  ]);
  const mini = el("div", { class: "gmini" });
  const stage = el("div", { class: "gstage" }, [trailBox, pathBar, el("div", { class: "gview" }, [canvas, start, matrixBox, mini])]);
  const main = el("main", { class: "main wide gmain", "aria-label": "문서 관계 그래프" }, [
    el("div", { class: "gbar" }, [search.box, modeSeg, depthBox, el("span", { class: "sp" }), hint, zoomBox]),
    stage,
  ]);
  const root = cols({ left, main, className: "graph-cols" });
  screen().appendChild(root);

  // ---------- 보는 자리: 확대 · 옮기기 ----------
  const cam = { s: 1, tx: 0, ty: 0, fitted: true };
  let drawn = null; // { kind: "cards" | "all", w, h, nodes: Map<key, {g, x, y, lw}>, edges: [{path, from, to, idx, base}], anchor, quiet }
  const sizeOf = () => ({ cw: canvas.clientWidth, ch: canvas.clientHeight });
  const dotScale = (s) => clamp(s, 0.5, 1.4); // 전체: a dot is 5px or more on screen
  const nameScale = (s) => clamp(s, 0.93, 1.3); // 전체: a shown name is 12.5px or more
  let labelFrame = 0;
  function apply() {
    world.setAttribute("transform", `translate(${cam.tx} ${cam.ty}) scale(${cam.s})`);
    zoomText.textContent = `${Math.round(cam.s * 100)}%`;
    if (drawn?.kind !== "all") return;
    svg.style.setProperty("--kg", String(dotScale(cam.s) / cam.s));
    svg.style.setProperty("--kl", String(nameScale(cam.s) / cam.s));
    if (!labelFrame)
      labelFrame = requestAnimationFrame(() => {
        labelFrame = 0;
        relabel();
        paintMiniView();
      });
  }
  const scaleRange = () => {
    const { cw, ch } = sizeOf();
    const whole = Math.min(cw / drawn.w, ch / drawn.h);
    return drawn.kind === "cards" ? [Math.min(0.5, whole), 2] : [Math.min(whole, 1) * 0.8, 3];
  };
  function fit() {
    if (!drawn) return;
    const { cw, ch } = sizeOf();
    const whole = Math.min(cw / drawn.w, ch / drawn.h);
    // Centered. A picture larger than the canvas keeps the picked doc in the middle.
    const place = (size, room, at) => (size <= room ? (room - size) / 2 : clamp(room / 2 - at, room - size, 0));
    if (drawn.kind === "cards") {
      cam.s = clamp(whole, drawn.minScale, 1.15);
      cam.tx = place(drawn.w * cam.s, cw, drawn.anchor.x * cam.s);
    } else {
      // 전체: a name keeps its size below 93%, so the last column's names need room of their own.
      const spill = (s) => Math.max(0, (CELL_W - 34) * nameScale(s) - (CELL_W - 16) * s);
      cam.s = Math.min(whole, 1.2);
      cam.s = Math.min((cw - spill(cam.s)) / drawn.w, ch / drawn.h, 1.2);
      cam.tx = (cw - spill(cam.s) - drawn.w * cam.s) / 2;
    }
    cam.ty = place(drawn.h * cam.s, ch, drawn.anchor.y * cam.s);
    cam.fitted = true;
    apply();
  }
  function zoomAt(px, py, factor) {
    if (!drawn) return;
    const [lo, hi] = scaleRange();
    const s = clamp(cam.s * factor, lo, hi);
    cam.tx = px - ((px - cam.tx) * s) / cam.s;
    cam.ty = py - ((py - cam.ty) * s) / cam.s;
    cam.s = s;
    cam.fitted = false;
    apply();
  }
  function zoomBy(factor) {
    const { cw, ch } = sizeOf();
    zoomAt(cw / 2, ch / 2, factor);
  }
  function moveBy(dx, dy) {
    cam.tx += dx;
    cam.ty += dy;
    cam.fitted = false;
    apply();
  }
  canvas.addEventListener("wheel", (e) => {
    if (!drawn) return;
    e.preventDefault();
    const box = canvas.getBoundingClientRect();
    const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-step * 0.0016));
  }, { passive: false });
  let drag = null;
  let dragged = false; // a drag's last pointerup is followed by a click: that click picks nothing
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !drawn) return;
    drag = { x: e.clientX, y: e.clientY, tx: cam.tx, ty: cam.ty, moving: false };
    dragged = false;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moving && Math.hypot(dx, dy) < 4) return;
    if (!drag.moving) {
      drag.moving = true;
      dragged = true;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("dragging");
    }
    cam.tx = drag.tx + dx;
    cam.ty = drag.ty + dy;
    cam.fitted = false;
    apply();
  });
  const endDrag = () => {
    drag = null;
    canvas.classList.remove("dragging");
    setTimeout(() => (dragged = false));
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("keydown", (e) => {
    if (e.target !== canvas || !drawn) return;
    const step = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
    if (step) moveBy(...step);
    else if (e.key === "+" || e.key === "=") zoomBy(1.25);
    else if (e.key === "-") zoomBy(1 / 1.25);
    else if (e.key === "0") fit();
    else return;
    e.preventDefault();
  });
  new ResizeObserver(() => {
    if (!drawn) return;
    if (cam.fitted) fit();
    else apply();
  }).observe(canvas);

  // ---------- 가리킨 문서: 그 문서의 선과 이웃이 진해진다 ----------
  let hover = null;
  function setHover(key) {
    // 둘레: nearly every line touches the picked doc, so pointing at it marks nothing.
    if (key && key === drawn?.quiet) key = null;
    if (key === hover || !drawn) return;
    hover = key;
    const near = new Set(key ? [key] : []);
    for (const e of drawn.edges) {
      const on = !!key && (e.from === key || e.to === key);
      if (on) near.add(e.from).add(e.to);
      e.path.classList.toggle("hl", on);
      markEdge(e);
    }
    for (const [k, nd] of drawn.nodes) nd.g.classList.toggle("nb", near.has(k));
    svg.classList.toggle("hovering", !!key);
    drawn.near = near;
    if (drawn.kind === "all") apply();
  }
  /** An edge's arrow takes the color the edge has now. */
  function markEdge(e) {
    if (!e.base) return;
    const lit = e.path.classList.contains("hl") || e.path.classList.contains("on");
    const id = e.base === "gmk" && lit ? "gmk-on" : e.base;
    e.path.setAttribute("marker-end", `url(#${id})`);
    if (e.both) e.path.setAttribute("marker-start", `url(#${id})`);
  }
  const keyAt = (target) => target.closest?.("[data-key]")?.getAttribute("data-key") ?? null;
  const isGroup = (key) => key?.startsWith("group:");
  world.addEventListener("pointerover", (e) => !drag?.moving && setHover(keyAt(e.target)));
  world.addEventListener("pointerleave", () => setHover(null));
  world.addEventListener("focusin", (e) => setHover(keyAt(e.target)));
  world.addEventListener("focusout", () => setHover(null));
  /** A press on a doc: Shift = the path from the picked doc to it; else its 둘레 (the picked doc itself opens). */
  function press(key, { shift = false, keyboard = false } = {}) {
    if (isGroup(key)) return openGroup(key, keyboard);
    const n = key && g.nodes.get(key);
    if (!n) return;
    if (shift && view.mode === "path") return setPath({ to: key });
    if (shift && sel && key !== sel) {
      view.path = { ...view.path, from: sel, to: key };
      return setMode("path");
    }
    if (key === sel && view.mode === "ego") return openDoc(n);
    view.mode = "ego";
    go(key, { focus: keyboard });
  }
  world.addEventListener("click", (e) => {
    // The second click of a double click lands on whatever stands there now: it picks nothing.
    if (dragged || e.detail > 1) return;
    press(keyAt(e.target), { shift: e.shiftKey });
  });
  world.addEventListener("keydown", (e) => {
    const key = keyAt(e.target);
    if (!key || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const n = g.nodes.get(key);
    if (n && e.shiftKey) return openDoc(n);
    press(key, { keyboard: true });
  });

  // ---------- 카드 열 그림: 둘레 · 경로 ----------
  /**
   * stacks = the columns left to right, [{ items: [{ kind: "doc", key } | { kind: "more" | "missing" | "none", … }], head, mid }];
   * edges = [{ from, to, rel, both }] between shown docs. `centers` stand out; a press on `openKey` opens it;
   * `anchor` = the doc the picture keeps in view; pointing at `quiet` marks nothing;
   * `minScale` = the smallest scale 화면에 맞춤 goes to.
   */
  function layCards(stacks, edgeList, { centers, openKey, anchor, label, minScale = EGO_MIN_SCALE }) {
    // The columns spread over the canvas's width; past it the picture is moved by dragging.
    const { cw } = sizeOf();
    const ncol = stacks.length;
    const gap = ncol > 1 ? clamp((cw / minScale - EGO_PAD * 2 - ncol * CARD_W) / (ncol - 1), 44, 150) : 0;
    const tallest = Math.max(...stacks.map((s) => s.items.length));
    const w = EGO_PAD * 2 + ncol * CARD_W + (ncol - 1) * gap;
    const h = EGO_PAD * 2 + EGO_HEAD + tallest * CARD_ROW - (CARD_ROW - CARD_H);
    const pos = new Map();
    const heads = [];
    const extras = [];
    stacks.forEach((st, ci) => {
      const x = EGO_PAD + ci * (CARD_W + gap);
      const y0 = EGO_PAD + EGO_HEAD + ((tallest - st.items.length) * CARD_ROW) / 2;
      heads.push(svgEl("text", { class: `gcol-h${st.mid ? " mid" : ""}`, x: x + CARD_W / 2, y: y0 - 12, "text-anchor": "middle", text: st.head }));
      st.items.forEach((it, i) => {
        const p = { x, y: y0 + i * CARD_ROW, col: ci };
        if (it.kind === "doc") pos.set(it.key, p);
        else extras.push({ ...it, ...p });
      });
    });
    const edgeLayer = svgEl("g", { class: "gedges" });
    const edges = [];
    const mid = CARD_H / 2;
    const curve = (a, b) => {
      if (a.col === b.col) {
        const x = a.x + CARD_W;
        return `M${x} ${a.y + mid} C${x + 34} ${a.y + mid} ${x + 34} ${b.y + mid} ${x + 2} ${b.y + mid}`;
      }
      const fwd = a.col < b.col;
      const x1 = fwd ? a.x + CARD_W : a.x;
      const x2 = fwd ? b.x - 2 : b.x + CARD_W + 2;
      const m = (x1 + x2) / 2;
      return `M${x1} ${a.y + mid} C${m} ${a.y + mid} ${m} ${b.y + mid} ${x2} ${b.y + mid}`;
    };
    for (const e of edgeList) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      const kind = e.rel === "screen" ? "scr" : bodyEdge.has(`${e.from}>${e.to}`) || (e.both && bodyEdge.has(`${e.to}>${e.from}`)) ? "body" : "";
      const far = Math.abs(a.col - b.col) > 1 ? " far" : "";
      const what = `${g.nodes.get(e.from).id} ${e.both ? "↔" : "→"} ${g.nodes.get(e.to).id} · ${kind === "scr" ? "rel screen" : kind === "body" ? "본문 [[ ]]" : "links"}`;
      const path = svgEl("path", { class: `ge ${kind}${far}`, d: curve(a, b) }, svgEl("title", { text: what }));
      const edge = { path, from: e.from, to: e.to, both: e.both, base: kind === "scr" ? "gmk-scr" : "gmk" };
      markEdge(edge);
      edgeLayer.appendChild(path);
      edges.push(edge);
    }
    const nodeLayer = svgEl("g", { class: "gnodes" });
    const nodes = new Map();
    for (const [key, p] of pos) {
      const n = g.nodes.get(key);
      const center = centers.has(key);
      const opens = key === openKey;
      const name = labelName(n);
      const off = n.status === "inactive";
      const metaRoom = CARD_W - 36 - 10 - (opens ? 34 : off ? 44 : 0);
      const card = svgEl("g", {
        class: `gn gcardn kind-${n.kind}${center ? " center" : ""}${off ? " off" : ""}`,
        transform: `translate(${p.x},${p.y})`,
        tabindex: "0",
        role: "button",
        "aria-label": opens ? `${typeName(n.type)} ${name} — 고른 문서, 누르면 문서 열기` : `${typeName(n.type)} ${name} — 누르면 이 문서의 둘레`,
        "data-key": key,
      }, [
        svgEl("title", { text: `${typeName(n.type)} · ${n.id}${name === n.id ? "" : `\n${name}`}\n가리켜짐 ${deg.get(key).in} · 가리킴 ${deg.get(key).out}${off ? " · 비활성" : ""}\n${opens ? "누르면 문서 열기" : "누르면 이 문서의 둘레 · Shift+Enter 로 문서 열기"}` }),
        svgEl("rect", { class: "gcard-bg", width: CARD_W, height: CARD_H, rx: 9, style: { "--c": typeColor(n.type) } }),
        svgEl("g", { transform: `translate(19,${mid})` }, shapeNodes(n, n.kind === "main" ? 5.5 : 7)),
        svgEl("text", { class: "gc-name", x: 36, y: 19, text: clip(name, `${center ? 700 : 600} 14px`, CARD_W - 36 - 10) }),
        svgEl("text", { class: "gc-meta", x: 36, y: 36, text: clip(opens ? linkCounts(key) : `${kindTag(n.type, n.kind)} · ${linkCounts(key)}`, "12.5px", metaRoom) }),
        opens ? svgEl("text", { class: "gc-open", x: CARD_W - 10, y: 36, "text-anchor": "end", text: "열기 ↗" }) : off ? svgEl("text", { class: "gc-off", x: CARD_W - 10, y: 36, "text-anchor": "end", text: "비활성" }) : null,
      ]);
      nodeLayer.appendChild(card);
      nodes.set(key, { g: card, x: p.x + CARD_W / 2, y: p.y + mid });
    }
    for (const x of extras) {
      if (x.kind === "more") {
        const btn = svgEl("g", { class: "gmore", transform: `translate(${x.x},${x.y})`, tabindex: "0", role: "button", "aria-label": `${num(x.n)} 문서 더 보기` }, [
          svgEl("rect", { class: "gmore-bg", width: CARD_W, height: CARD_H, rx: 9 }),
          svgEl("text", { class: "gc-name", x: CARD_W / 2, y: 19, "text-anchor": "middle", text: `+ ${num(x.n)} 문서` }),
          svgEl("text", { class: "gc-meta", x: CARD_W / 2, y: 36, "text-anchor": "middle", text: "더 보기 — 연결이 많은 순" }),
        ]);
        const raise = () => {
          more = { ...more, [x.level]: x.cap * 3 };
          refresh();
        };
        btn.addEventListener("click", () => !dragged && raise());
        btn.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), raise()));
        nodeLayer.appendChild(btn);
      } else if (x.kind === "missing") {
        const a = pos.get(anchor);
        const path = svgEl("path", { class: "ge broken", d: curve(a, x), "marker-end": "url(#gmk-broken)" }, svgEl("title", { text: `[[${x.text}]] — 등록 안 된 문서` }));
        edgeLayer.appendChild(path);
        nodeLayer.appendChild(svgEl("g", { class: "gmiss", transform: `translate(${x.x},${x.y})` }, [
          svgEl("title", { text: `[[${x.text}]] — 등록 안 된 문서` }),
          svgEl("rect", { class: "gmiss-bg", width: CARD_W, height: CARD_H, rx: 9 }),
          svgEl("text", { class: "gc-name", x: 14, y: 19, text: clip(x.text, "600 14px", CARD_W - 28) }),
          svgEl("text", { class: "gc-meta gmiss-t", x: 14, y: 36, text: "등록 안 됨 · 끊긴 연결" }),
        ]));
      } else {
        nodeLayer.appendChild(svgEl("g", { class: "gnone", transform: `translate(${x.x},${x.y})` }, [
          svgEl("rect", { class: "gnone-bg", width: CARD_W, height: CARD_H, rx: 9 }),
          svgEl("text", { class: "gc-meta", x: CARD_W / 2, y: mid + 4, "text-anchor": "middle", text: x.level < 0 ? "가리키는 문서 없음" : "가리키는 대상 없음" }),
        ]));
      }
    }
    world.replaceChildren(...heads, edgeLayer, nodeLayer);
    svg.setAttribute("class", "gsvg ego");
    svg.setAttribute("aria-label", `${label} — 문서 ${pos.size} · 선 ${edges.length}`);
    drawn = { kind: "cards", w, h, nodes, edges, anchor: nodes.get(anchor), quiet: openKey, minScale };
  }

  // ---------- 둘레 보기 ----------
  function drawEgo() {
    const ego = lib.egoView(g, sel, { depth: view.depth, cap: EGO_CAP, more });
    const byLevel = new Map(ego.columns.map((c) => [c.level, c]));
    const mine = broken.filter((b) => b.from === sel);
    const lo = Math.min(-1, ...byLevel.keys());
    const hi = Math.max(1, ...byLevel.keys());
    const stacks = [];
    for (let level = lo; level <= hi; level++) {
      const c = byLevel.get(level);
      const items = (c?.keys ?? []).map((key) => ({ kind: "doc", key }));
      if (c?.hidden) items.push({ kind: "more", level, n: c.hidden, cap: c.keys.length });
      if (level === 1) for (const b of mine) items.push({ kind: "missing", text: b.text });
      if (!items.length) items.push({ kind: "none", level });
      const total = (c?.keys.length ?? 0) + (c?.hidden ?? 0);
      const head =
        level === 0 ? "고른 문서"
        : level === -1 ? `이 문서를 가리킴 · ${num(total)}`
        : level === 1 ? `이 문서가 가리킴 · ${num(total)}`
        : level < 0 ? `← ${-level}단 · ${num(total)}`
        : `${level}단 → · ${num(total)}`;
      stacks.push({ items, head, mid: level === 0 });
    }
    layCards(stacks, ego.edges, { centers: new Set([sel]), openKey: sel, anchor: sel, label: `${labelName(g.nodes.get(sel))} 둘레` });
  }

  // ---------- 경로 ----------
  /** 경로's state: "pick" (출발 · 도착 not both set), "none" (no chain; `loose` = the undirected one), or "path". */
  function pathState() {
    const { from, to, directed } = view.path;
    if (!from || !to || !g.nodes.has(from) || !g.nodes.has(to)) return { kind: "pick" };
    const res = lib.shortestPaths(g, from, to, { directed, limit: PATH_LIMIT });
    if (res) return { kind: "path", res };
    return { kind: "none", loose: directed ? lib.shortestPaths(g, from, to, { limit: 1 }) : null };
  }
  function drawPath(res) {
    const { from, to } = view.path;
    const stacks = res.layers.map((keys, i) => ({
      items: keys.map((key) => ({ kind: "doc", key })),
      head: i === 0 ? "출발" : i === res.hops ? "도착" : `${i} 걸음`,
      mid: i === 0 || i === res.hops,
    }));
    layCards(stacks, res.edges, { centers: new Set([from, to]), openKey: null, anchor: from, minScale: PATH_MIN_SCALE, label: `${labelName(g.nodes.get(from))} 에서 ${labelName(g.nodes.get(to))} 까지 경로` });
  }
  function paintPathBar(ps) {
    fromPick.set(view.path.from ? full.nodes.get(view.path.from) : null);
    toPick.set(view.path.to ? full.nodes.get(view.path.to) : null);
    dirBtn.setAttribute("aria-pressed", String(view.path.directed));
    pathNote.textContent =
      ps.kind === "path"
        ? `${num(ps.res.hops)} 걸음 · 가장 짧은 길 ${num(ps.res.count)} 개${ps.res.count > ps.res.paths.length ? ` 가운데 ${ps.res.paths.length} 개를 그립니다` : ""}`
        : ps.kind === "none" ? "이어지지 않음" : "";
  }
  /** 경로 with no picture: what to pick, or 이어지지 않음. */
  function paintPathNote(ps) {
    const filtered = view.hidden.size || view.roles.size < 2;
    const name = (k) => labelName(full.nodes.get(k));
    if (ps.kind === "pick") {
      start.replaceChildren(el("div", { class: "gstart-in gpath-empty" }, [
        el("h2", { class: "gstart-h", text: "두 문서 사이 경로" }),
        el("p", { class: "gstart-p", text: "위 칸에서 출발 문서와 도착 문서를 고르면 둘을 잇는 가장 짧은 길이 섭니다. 선은 어느 쪽으로든 따라가고, 화살표는 실제로 가리키는 쪽을 보입니다." }),
        el("p", { class: "gstart-p dim", text: "둘레 · 전체 보기에서 문서를 고른 채 다른 문서를 Shift+클릭해도 경로가 섭니다." }),
      ]));
      return;
    }
    start.replaceChildren(el("div", { class: "gstart-in gpath-empty" }, [
      el("h2", { class: "gstart-h", text: "이어지지 않음" }),
      el("p", { class: "gstart-p" }, [
        el("b", { text: name(view.path.from) }),
        " 에서 ",
        el("b", { text: name(view.path.to) }),
        view.path.directed ? " 까지 가리키는 쪽으로 따라가는 길이 없습니다." : " 까지 잇는 연결이 없습니다. 두 문서는 서로 다른 덩어리에 있습니다.",
      ]),
      ps.loose
        ? el("div", { class: "gstart-foot" }, [
            el("button", { type: "button", class: "btn", onclick: () => setPath({ directed: false }) }, `방향을 가리지 않고 보기 — ${num(ps.loose.hops)} 걸음`),
          ])
        : null,
      filtered ? el("p", { class: "gstart-p dim", text: "왼쪽 범례에서 끈 타입의 문서는 길에 들지 않습니다." }) : null,
    ]));
  }

  // ---------- 행렬 ----------
  function paintMatrix() {
    const m = lib.typeMatrix(g);
    if (!m.kinds.length) {
      matrixBox.replaceChildren(el("p", { class: "loading", text: full.nodes.size ? "보이는 문서가 없습니다 — 왼쪽 필터를 켜 보세요." : "문서가 없습니다." }));
      return;
    }
    const size = (k) => m.size.get(k);
    const valid = (k) => k === null || m.kinds.includes(k);
    if (view.cell && !(valid(view.cell.from) && valid(view.cell.to) && (view.cell.from || view.cell.to))) view.cell = null;
    const kindHead = (k, extra) => [glyph(kindSample(k), 16), el("span", { class: "gmx-l", text: kindName(k) }), el("span", { class: "gmx-n", text: num(size(k)) }), extra];
    const level = (n) => (n ? clamp(Math.ceil(Math.sqrt(n / m.max) * 5), 1, 5) : 0);
    const grid = []; // [row][col] = the cell buttons, for the arrow keys
    const at = (cell) => `${cell.from ?? ""}>${cell.to ?? ""}`;
    const buttons = new Map();
    const cellBtn = (r, c, cell, cls, children, label) => {
      const on = view.cell && at(view.cell) === at(cell);
      const b = el("button", { type: "button", class: `gmx-c ${cls}${on ? " on" : ""}`, "aria-pressed": String(!!on), "aria-label": label, title: label, tabindex: "-1", onclick: () => pickCell(cell) }, children);
      (grid[r] ??= [])[c] = b;
      buttons.set(at(cell), b);
      return el("td", {}, b);
    };
    const n = m.kinds.length;
    const head = el("tr", {}, [
      el("th", { scope: "col", class: "gmx-corner" }, [el("span", { text: "가리키는 쪽 ↓" }), el("span", { text: "가리켜지는 쪽 →" })]),
      ...m.kinds.map((k) => el("th", { scope: "col", class: "gmx-ch", title: `${kindName(k)} ${num(size(k))} 문서` }, kindHead(k))),
      el("th", { scope: "col", class: "gmx-ch side", title: "선을 하나도 갖지 않은 문서" }, el("span", { class: "gmx-l", text: "가리키는 것 없음" })),
    ]);
    const body = m.kinds.map((a, r) =>
      el("tr", {}, [
        el("th", { scope: "row", class: "gmx-rh", title: `${kindName(a)} ${num(size(a))} 문서` }, kindHead(a)),
        ...m.kinds.map((b, c) => {
          const x = m.cells.get(`${a}>${b}`);
          if (!x) return cellBtn(r, c, { from: a, to: b }, "zero", [el("b", { text: "0" })], `${kindName(a)} → ${kindName(b)}: 선 없음 — ${kindName(a)} ${num(size(a))} 문서 가운데 가리키는 문서 없음`);
          return cellBtn(r, c, { from: a, to: b }, `l${level(x.links)}`, [el("b", { text: num(x.links) }), el("span", { class: "gmx-sub", text: `${num(x.from)}/${num(size(a))}` })],
            `${kindName(a)} → ${kindName(b)}: 선 ${num(x.links)} — ${kindName(a)} ${num(size(a))} 문서 가운데 ${num(x.from)} 문서가 가리키고, ${kindName(b)} ${num(x.to)} 문서가 가리켜짐`);
        }),
        cellBtn(r, n, { from: a, to: null }, `side${m.noOut.get(a) ? "" : " none"}`, [el("b", { text: num(m.noOut.get(a)) }), el("span", { class: "gmx-sub", text: `/${num(size(a))}` })], `${kindName(a)} 가운데 아무것도 가리키지 않는 문서 ${num(m.noOut.get(a))}`),
      ]),
    );
    const foot = el("tr", { class: "gmx-foot" }, [
      el("th", { scope: "row", class: "gmx-rh side", title: "아무 문서도 가리키지 않는 문서" }, el("span", { class: "gmx-l", text: "가리켜지지 않음" })),
      ...m.kinds.map((b, c) => cellBtn(n, c, { from: null, to: b }, `side${m.noIn.get(b) ? "" : " none"}`, [el("b", { text: num(m.noIn.get(b)) }), el("span", { class: "gmx-sub", text: `/${num(size(b))}` })], `${kindName(b)} 가운데 아무도 가리키지 않는 문서 ${num(m.noIn.get(b))}`)),
      el("td", { class: "gmx-blank" }),
    ]);
    const table = el("table", { class: "gmx" }, [
      el("caption", { text: "타입 × 타입 연결 수 — 줄은 가리키는 문서의 타입, 칸은 가리켜지는 문서의 타입" }),
      el("thead", {}, head),
      el("tbody", {}, [...body, foot]),
    ]);
    // One tab stop: the arrow keys walk the cells (the picked one, else the first).
    ((view.cell && buttons.get(at(view.cell))) || grid[0][0]).tabIndex = 0;
    table.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[e.key];
      if (!step) return;
      const r = grid.findIndex((row) => row?.includes(e.target));
      if (r < 0) return;
      const c = grid[r].indexOf(e.target);
      const next = grid[r + step[0]]?.[c + step[1]];
      if (!next) return;
      e.preventDefault();
      e.target.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    });
    const detail = el("section", { class: "gmx-detail", "aria-live": "polite" });
    function pickCell(cell) {
      const same = view.cell && at(view.cell) === at(cell);
      view.cell = same ? null : cell;
      for (const [k, b] of buttons) {
        const on = !!view.cell && k === at(view.cell);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", String(on));
        b.tabIndex = (view.cell ? on : k === at(cell)) ? 0 : -1;
      }
      paintDetail();
      if (view.cell) detail.scrollIntoView({ block: "nearest" });
    }
    function paintDetail() {
      detail.hidden = !view.cell;
      if (!view.cell) return detail.replaceChildren();
      const { from: a, to: b } = view.cell;
      const res = lib.matrixCell(g, a, b);
      const toEgo = (key) => () => {
        view.mode = "ego";
        go(key, { focus: true });
      };
      const docList = (keys) => pagedList(keys, (key) => docRow(g.nodes.get(key), linkCounts(key), { onclick: toEgo(key) }));
      const close = el("button", { type: "button", class: "btn sm ghost", "aria-label": "칸 풀기", onclick: () => {
        const was = view.cell;
        pickCell(was);
        buttons.get(at(was))?.focus();
      } }, [icon("x", 13)]);
      const part = (title, count, body, cls = "") => el("div", { class: `gmx-part${count && cls ? ` ${cls}` : ""}` }, [el("h4", { class: "plabel prow" }, [el("span", { text: title }), el("span", { class: "grow-n", text: num(count) })]), body]);
      if (a && b) {
        const x = m.cells.get(`${a}>${b}`);
        const edgeRow = (e) =>
          el("div", { class: "gmx-edge" }, [
            docRow(g.nodes.get(e.from), null, { onclick: toEgo(e.from) }),
            el("span", { class: `gmx-arrow${e.rel === "screen" ? " scr" : ""}`, "aria-label": e.rel === "screen" ? "가리킴(rel screen)" : "가리킴", text: "→" }),
            docRow(g.nodes.get(e.to), null, { onclick: toEgo(e.to) }),
          ]);
        detail.replaceChildren(
          el("div", { class: "gmx-dh" }, [el("h3", {}, [glyph(kindSample(a), 16), kindName(a), el("span", { class: "dim", text: " → " }), glyph(kindSample(b), 16), kindName(b)]), el("span", { class: "sp" }), close]),
          el("p", { class: "gmx-facts", text: x
            ? `선 ${num(x.links)} · ${kindName(a)} ${num(size(a))} 문서 가운데 ${num(x.from)} 문서가 가리킵니다 · ${kindName(b)} ${num(size(b))} 문서 가운데 ${num(x.to)} 문서가 가리켜집니다.`
            : `선이 없습니다 — ${kindName(a)} ${num(size(a))} 문서 가운데 ${kindName(b)} 문서를 가리키는 문서가 없습니다.` }),
          el("div", { class: "gmx-parts" }, [
            part(`${kindName(b)} 연결이 없는 ${kindName(a)}`, res.without.length, res.without.length ? docList(res.without) : el("p", { class: "dim pnone", text: `모든 ${kindName(a)} 문서가 ${kindName(b)} 문서를 가리킵니다.` }), "gap"),
            part(`${kindName(a)} → ${kindName(b)} 선`, res.edges.length, res.edges.length ? pagedList(res.edges, edgeRow) : el("p", { class: "dim pnone", text: "선이 없습니다." })),
          ]),
        );
      } else {
        const k = a ?? b;
        const title = a ? `아무것도 가리키지 않는 ${kindName(k)}` : `아무도 가리키지 않는 ${kindName(k)}`;
        detail.replaceChildren(
          el("div", { class: "gmx-dh" }, [el("h3", {}, [glyph(kindSample(k), 16), title]), el("span", { class: "sp" }), close]),
          el("p", { class: "gmx-facts", text: `${kindName(k)} ${num(size(k))} 문서 가운데 ${num(res.without.length)} 문서${a ? "는 links 와 본문 [[ ]] 로 다른 문서를 가리키지 않습니다." : "는 다른 문서가 가리키지 않습니다."}` }),
          el("div", { class: "gmx-parts one" }, part(title, res.without.length, res.without.length ? docList(res.without) : el("p", { class: "dim pnone", text: "없습니다." }), "gap")),
        );
      }
    }
    const steps = [10, 20, 32, 46, 60];
    matrixBox.replaceChildren(el("div", { class: "gmx-in" }, [
      el("div", { class: "gmx-top" }, [
        el("div", {}, [
          el("h2", { class: "gstart-h", text: "타입 사이 연결" }),
          el("p", { class: "gstart-p", text: `문서 ${num(g.nodes.size)} · 선 ${num(g.edges.length)}. 줄의 타입이 칸의 타입을 가리키는 선을 셉니다. 칸을 누르면 그 선과, 그 칸의 타입을 하나도 가리키지 않는 줄의 문서가 아래에 섭니다.` }),
        ]),
      ]),
      el("div", { class: "gmx-scroll" }, table),
      el("div", { class: "gmx-legend", "aria-hidden": "true" }, [
        el("span", { class: "gmx-key" }, [el("span", { text: "선 적음" }), ...steps.map((_, i) => el("i", { class: `gmx-sw l${i + 1}` })), el("span", { text: "많음" })]),
        el("span", { class: "gmx-key" }, [el("i", { class: "gmx-sw zero" }), "선 없음"]),
        el("span", { class: "gmx-key" }, [el("b", { class: "mono", text: "9/12" }), "줄의 12 문서 가운데 9 문서가 가리킴"]),
      ]),
      detail,
    ]));
    paintDetail();
  }

  // ---------- 전체 보기 ----------
  function drawAll() {
    const layout = lib.layoutColumns(g, (n) => {
      const d = deg.get(n.key);
      return d.in + d.out > 0;
    });
    // The mains are where the picture starts: they never fold. Nor does the picked doc.
    const unfolded = new Set([...g.nodes.values()].filter((n) => n.kind === "main" || n.key === sel).map((n) => n.key));
    const { columns, itemOf } = lib.groupColumns(layout, g, { threshold: GROUP_AT, open: view.groups, keep: unfolded });
    const { cw, ch } = sizeOf();
    const rows = lib.wrapRows(columns.map((c) => c.items.length), { cellW: CELL_W, cellH: CELL_H, gap: COL_GAP, aspect: ch / Math.max(1, cw) });
    const nodes = new Map();
    const groups = new Map();
    const heads = [];
    const nodeLayer = svgEl("g", { class: "gnodes" });
    const weight = (k) => (groups.has(k) ? groups.get(k).keys.length : deg.get(k).in + deg.get(k).out);
    const top = new Set(lib.hubs(g, { limit: 12 }).map((x) => x.key));
    let x0 = ALL_PAD;
    for (const c of columns) {
      const total = c.items.reduce((s, it) => s + (it.kind === "group" ? it.keys.length : 1), 0);
      const stacksN = Math.max(1, Math.ceil(c.items.length / rows));
      const head = c.dist === null ? "메인에 닿지 않는 묶음" : c.dist === 0 ? "메인" : `${c.dist}단`;
      const headText = `${head} · ${num(total)}`;
      const headG = svgEl("g", { transform: `translate(${x0 - 6},${ALL_PAD})` }, svgEl("g", { class: "gcol-hw" }, svgEl("text", { class: "gcol-h", text: headText })));
      heads.push({ g: headG, x: x0 - 6, y: ALL_PAD, w: textW(headText, "600 12.5px"), n: total, main: c.dist === 0 });
      const used = Math.min(rows, c.items.length);
      const y0 = ALL_PAD + ALL_HEAD + ((rows - used) * CELL_H) / 2;
      c.items.forEach((it, i) => {
        const x = x0 + Math.floor(i / rows) * CELL_W + 6;
        const y = y0 + (i % rows) * CELL_H;
        if (it.kind === "group") {
          groups.set(it.id, it);
          const what = `${kindName(it.of)} +${num(it.keys.length)} 문서`;
          const name = clip(what, GROUP_FONT, CELL_W - 34);
          const s = sample(it.type, { kind: it.of });
          const node = svgEl("g", {
            class: "gn gdot ggroup",
            transform: `translate(${x},${y})`,
            tabindex: "0",
            role: "button",
            "aria-label": `${what} — 묶음, 누르면 펼칩니다`,
            "aria-expanded": "false",
            "data-key": it.id,
          }, [
            svgEl("title", { text: `${kindName(it.of)} ${num(it.keys.length)} 문서 묶음 — 이 열(${head})에 같은 타입 문서가 ${GROUP_AT} 개를 넘어 한 점으로 접었습니다.\n누르면 펼칩니다.` }),
            svgEl("g", { class: "gk" }, [
              svgEl("circle", { r: 11, class: "ghit" }),
              svgEl("g", { class: "gstack", transform: "translate(3.5,-3.5)" }, shapeNodes(s, 6)),
              svgEl("g", { transform: "translate(0,0)" }, shapeNodes(s, 6.5)),
            ]),
            svgEl("g", { class: "glab" }, svgEl("text", { class: "gname", x: 2, y: 4.5, text: name })),
          ]);
          nodes.set(it.id, { g: node, x, y, lw: textW(name, GROUP_FONT) + 2, name, group: it });
          return;
        }
        const key = it.key;
        const n = g.nodes.get(key);
        const name = clip(labelName(n), NAME_FONT, CELL_W - 34);
        const node = svgEl("g", {
          class: `gn gdot kind-${n.kind}${n.status === "inactive" ? " off" : ""}`,
          transform: `translate(${x},${y})`,
          tabindex: n.kind === "main" || top.has(key) ? "0" : "-1",
          role: "button",
          "aria-label": `${typeName(n.type)} ${labelName(n)} — 누르면 이 문서의 둘레`,
          "data-key": key,
        }, [
          svgEl("title", { text: `${typeName(n.type)} · ${n.id}${labelName(n) === n.id ? "" : `\n${labelName(n)}`}\n가리켜짐 ${deg.get(key).in} · 가리킴 ${deg.get(key).out}\n누르면 이 문서의 둘레 · Shift+클릭은 고른 문서에서 이 문서까지 경로` }),
          svgEl("g", { class: "gk" }, [svgEl("circle", { r: 9, class: "ghit" }), ...shapeNodes(n, n.kind === "main" ? 5 : 5.5)]),
          svgEl("g", { class: "glab" }, svgEl("text", { class: "gname", x: 0, y: 4.5, text: name })),
        ]);
        nodes.set(key, { g: node, x, y, lw: textW(name, NAME_FONT), name });
      });
      x0 += stacksN * CELL_W + COL_GAP;
    }
    const w = Math.max(x0 - COL_GAP + ALL_PAD, 200);
    const h = ALL_PAD * 2 + ALL_HEAD + rows * CELL_H;
    const edgeLayer = svgEl("g", { class: "gedges" });
    const edges = [];
    const nameOf = (k) => nodes.get(k).name;
    for (const e of lib.mergeEdges(g, itemOf)) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (!a || !b) continue;
      const one = g.edges[e.idx[0]];
      const kind = e.rel === "screen" ? "scr" : e.n === 1 && bodyEdge.has(`${one.from}>${one.to}`) ? "body" : "";
      const m = (a.x + b.x) / 2;
      const d = Math.abs(a.x - b.x) < 1 ? `M${a.x} ${a.y} Q${a.x - 46} ${(a.y + b.y) / 2} ${b.x} ${b.y}` : `M${a.x} ${a.y} C${m} ${a.y} ${m} ${b.y} ${b.x} ${b.y}`;
      const path = svgEl("path", { class: `ge ${kind}${e.n > 1 ? " many" : ""}`, d, style: e.n > 1 ? { "--w": String(Math.min(4.5, 1 + 0.7 * Math.log2(e.n)).toFixed(2)) } : null }, e.n > 1 ? svgEl("title", { text: `${nameOf(e.from)} → ${nameOf(e.to)} · 선 ${num(e.n)}` }) : null);
      edgeLayer.appendChild(path);
      edges.push({ path, from: e.from, to: e.to, idx: e.idx });
    }
    // The picked doc's paths stay dark; the rest goes faint. A group is lit when one of its docs is.
    const r = sel && nodes.has(sel) ? lib.reach(g, sel, { depth: view.depth, direction: "both" }) : null;
    const lit = (k) => !!r && (groups.has(k) ? groups.get(k).keys.some((x) => r.nodes.has(x)) : r.nodes.has(k));
    if (r) {
      for (const [k, nd] of nodes) nd.g.classList.toggle("on", lit(k));
      nodes.get(sel).g.classList.add("sel");
      for (const e of edges)
        if (e.idx.some((i) => r.edges.has(i))) {
          e.path.classList.add("on");
          edgeLayer.appendChild(e.path);
        }
    }
    // Names in the order they claim room. The first names — the picked doc and its paths, the
    // groups, the mains, the hubs — may stand over other docs' dots, so those docs are drawn last, on top.
    const rank = (k) => (k === sel ? 0 : lit(k) ? 1 : groups.has(k) || g.nodes.get(k).kind === "main" ? 2 : top.has(k) ? 3 : 4);
    const order = [...nodes.keys()].sort((a, b) => rank(a) - rank(b) || weight(b) - weight(a));
    const first = order.filter((k) => rank(k) < 4);
    const rest = order.filter((k) => rank(k) === 4);
    for (const k of [...rest, ...[...first].reverse()]) nodeLayer.appendChild(nodes.get(k).g);
    const over = svgEl("g", { class: "gover" });
    world.replaceChildren(...heads.map((x) => x.g), edgeLayer, nodeLayer, over);
    // Many lines are drawn fainter, so the dots stay the picture.
    svg.style.setProperty("--ea", String(clamp(0.4 * Math.sqrt(300 / Math.max(1, edges.length)), 0.12, 0.4)));
    svg.setAttribute("class", `gsvg all${r ? " has-sel" : ""}`);
    const docsShown = [...nodes.values()].reduce((s, nd) => s + (nd.group ? nd.group.keys.length : 1), 0);
    svg.setAttribute("aria-label", `전체 그래프 — 문서 ${docsShown} · 점 ${nodes.size} · 선 ${edges.length}`);
    drawn = { kind: "all", w, h, nodes, edges, anchor: (sel && nodes.get(sel)) || { x: w / 2, y: h / 2 }, first, rest, weight, over, heads, labeled: new Set(), near: new Set(), quiet: null };
    paintMini();
  }
  /** A press on a group: it opens where it stood, the view kept on that spot. */
  function openGroup(id, keyboard) {
    const nd = drawn?.nodes.get(id);
    if (!nd) return;
    view.groups.add(id);
    refresh({ keep: { key: nd.group.keys[0], sx: nd.x * cam.s + cam.tx, sy: nd.y * cam.s + cam.ty, focus: keyboard } });
  }
  /**
   * 이름표 솎기, of the docs on screen. The first names (the pointed-at doc and its neighbours,
   * the picked doc's paths, the groups, the mains, the hubs) only give way to each other. Every
   * other name shows when it covers neither a shown name nor a dot.
   */
  function relabel() {
    if (drawn?.kind !== "all") return;
    const { cw, ch } = sizeOf();
    const fg = dotScale(cam.s);
    const fl = nameScale(cam.s);
    const at = new Map();
    for (const [key, nd] of drawn.nodes) {
      const x = nd.x * cam.s + cam.tx;
      const y = nd.y * cam.s + cam.ty;
      if (x > -nd.lw * fl - 20 && x < cw && y > -12 && y < ch + 12) at.set(key, { x, y, nd });
    }
    const box = (key, pin) => {
      const p = at.get(key);
      return { key, x: p.x + 10 * fg, y: p.y - 8 * fl, w: p.nd.lw * fl, h: 16 * fl, pin };
    };
    const pointed = hover && at.has(hover) ? [hover, ...[...drawn.near].filter((k) => k !== hover && at.has(k)).sort((a, b) => drawn.weight(b) - drawn.weight(a)).slice(0, 40)] : [];
    const seen = new Set(pointed);
    const firstBoxes = [...pointed, ...drawn.first.filter((k) => at.has(k) && !seen.has(k))].map((k) => box(k, k === hover || k === sel));
    const keep = lib.declutter(firstBoxes, { pad: 3 });
    for (const b of firstBoxes) seen.add(b.key);
    const dots = [...at].map(([key, p]) => ({ key: `dot ${key}`, x: p.x - 4.5 * fg, y: p.y - 4.5 * fg, w: 9 * fg, h: 9 * fg, pin: true }));
    // Below REST_NAMES_FROM only the first names show: the rest would be a wall of text.
    const rest = cam.s < REST_NAMES_FROM ? [] : drawn.rest.filter((k) => at.has(k) && !seen.has(k));
    const fits = lib.declutter([...firstBoxes.filter((b) => keep.has(b.key)).map((b) => ({ ...b, pin: true })), ...dots, ...rest.map((k) => box(k, false))], { pad: 2.5 });
    for (const k of rest) if (fits.has(k)) keep.add(k);
    for (const k of drawn.labeled) if (!keep.has(k)) drawn.nodes.get(k).g.classList.remove("lab");
    for (const k of keep) if (!drawn.labeled.has(k)) drawn.nodes.get(k).g.classList.add("lab");
    drawn.labeled = keep;
    // Column heads: 메인 first, then the larger column, each where it covers no other head.
    const headKeep = lib.declutter(
      [...drawn.heads]
        .sort((a, b) => b.main - a.main || b.n - a.n)
        .map((x) => ({ key: x, x: x.x * cam.s + cam.tx, y: x.y * cam.s + cam.ty - 12 * fl, w: x.w * fl, h: 16 * fl })),
      { pad: 6 },
    );
    for (const x of drawn.heads) x.g.classList.toggle("gone", !headKeep.has(x));
    // The pointed-at doc's names once more, above every dot.
    drawn.over.replaceChildren(
      ...pointed.filter((k) => keep.has(k)).map((k) => {
        const nd = drawn.nodes.get(k);
        return svgEl("g", { class: `gn lab${k === hover ? " sel" : ""}${nd.group ? " ggroup" : ""}`, transform: `translate(${nd.x},${nd.y})` }, svgEl("g", { class: "glab" }, svgEl("text", { class: "gname", x: nd.group ? 2 : 0, y: 4.5, text: nd.name })));
      }),
    );
  }

  // ---------- 미니맵 ----------
  const MINI_W = 168;
  const MINI_H = 104;
  let miniView = null;
  let miniScale = 1;
  function paintMini() {
    miniScale = Math.min(MINI_W / drawn.w, MINI_H / drawn.h);
    miniView = svgEl("rect", { class: "gmini-view" });
    const map = svgEl("svg", { width: MINI_W, height: MINI_H, viewBox: `0 0 ${MINI_W} ${MINI_H}`, role: "img", "aria-label": "미니맵 — 누르면 그 자리로 갑니다" }, [
      ...[...drawn.nodes].map(([k, p]) => svgEl("rect", { x: p.x * miniScale - 1, y: p.y * miniScale - 1, width: p.group ? 4 : 2, height: p.group ? 4 : 2, fill: typeColor(p.group ? p.group.type : g.nodes.get(k).type) })),
      miniView,
    ]);
    const jump = (e) => {
      const box = map.getBoundingClientRect();
      const { cw, ch } = sizeOf();
      cam.tx = cw / 2 - ((e.clientX - box.left) / miniScale) * cam.s;
      cam.ty = ch / 2 - ((e.clientY - box.top) / miniScale) * cam.s;
      cam.fitted = false;
      apply();
    };
    map.addEventListener("pointerdown", (e) => {
      map.setPointerCapture(e.pointerId);
      jump(e);
    });
    map.addEventListener("pointermove", (e) => e.buttons === 1 && jump(e));
    mini.replaceChildren(el("div", { class: "gmini-h", text: "미니맵 · 보이는 영역" }), map);
  }
  function paintMiniView() {
    if (!miniView || drawn?.kind !== "all") return;
    const { cw, ch } = sizeOf();
    const x = clamp(-cam.tx / cam.s, 0, drawn.w);
    const y = clamp(-cam.ty / cam.s, 0, drawn.h);
    const x2 = clamp((cw - cam.tx) / cam.s, 0, drawn.w);
    const y2 = clamp((ch - cam.ty) / cam.s, 0, drawn.h);
    miniView.setAttribute("x", String(x * miniScale));
    miniView.setAttribute("y", String(y * miniScale));
    miniView.setAttribute("width", String(Math.max(3, (x2 - x) * miniScale)));
    miniView.setAttribute("height", String(Math.max(3, (y2 - y) * miniScale)));
  }

  // ---------- 시작 화면: 고른 문서가 없을 때 ----------
  function paintStart() {
    const total = (n) => deg.get(n.key).in + deg.get(n.key).out;
    const mains = [...g.nodes.values()].filter((n) => n.kind === "main").sort((a, b) => total(b) - total(a) || a.name.localeCompare(b.name, "ko"));
    const hubList = lib.hubs(g, { limit: 10, skip: (n) => n.kind === "main" });
    const linked = [...deg.values()].filter((d) => d.in + d.out > 0).length;
    const most = Math.max(1, ...hubList.map((x) => x.degree));
    const stat = (n, label) => el("div", { class: "gstat" }, [el("b", { text: num(n) }), el("span", { text: label })]);
    const pickRow = (n, right, bar) => {
      const row = docRow(n, right, { onclick: () => go(n.key, { focus: true }) });
      if (bar != null) row.style.setProperty("--bar", `${Math.round(bar * 100)}%`);
      return el("li", {}, row);
    };
    start.replaceChildren(
      el("div", { class: "gstart-in" }, [
        el("h2", { class: "gstart-h", text: "어느 문서의 둘레를 볼까요" }),
        el("p", { class: "gstart-p", text: "문서를 고르면 그 문서를 가리키는 문서가 왼쪽에, 그 문서가 가리키는 문서가 오른쪽에 섭니다. 위 칸에서 찾거나 아래에서 고르세요." }),
        el("div", { class: "gstats" }, [
          stat(g.nodes.size, "문서"),
          stat(g.edges.length, "연결"),
          stat(linked, "연결 있는 문서"),
          stat(g.nodes.size - linked, "연결 없는 문서"),
        ]),
        el("div", { class: "gstart-cols" }, [
          el("section", { class: "gstart-sec", "aria-label": "메인 에이전트" }, [
            el("h3", { class: "plabel prow" }, [el("span", { text: `메인 에이전트 · ${mains.length}` }), el("span", { class: "gleg-hint", text: "← 가리켜짐 · → 가리킴" })]),
            mains.length ? el("ul", { class: "gpick" }, mains.map((n) => pickRow(n, linkCounts(n.key)))) : el("p", { class: "dim pnone", text: "보이는 메인 에이전트가 없습니다." }),
          ]),
          el("section", { class: "gstart-sec", "aria-label": "허브 문서" }, [
            el("h3", { class: "plabel prow" }, [el("span", { text: "허브 문서 — 연결이 많은 순" }), el("span", { class: "gleg-hint", text: "연결 수" })]),
            hubList.length ? el("ul", { class: "gpick bars" }, hubList.map((x) => pickRow(g.nodes.get(x.key), num(x.degree), x.degree / most))) : el("p", { class: "dim pnone", text: "연결된 문서가 없습니다." }),
          ]),
        ]),
        el("div", { class: "gstart-foot" }, [
          el("button", { type: "button", class: "btn", onclick: () => setMode("all") }, [icon("graph", 15), "전체 그래프 보기"]),
          el("button", { type: "button", class: "btn", onclick: () => setMode("matrix") }, [icon("grid", 15), "타입 사이 연결 보기"]),
          el("button", { type: "button", class: "btn", onclick: () => setMode("path") }, [icon("right", 15), "두 문서 사이 경로"]),
          el("span", { class: "dim", text: `연결된 ${num(linked)} 문서 — 전체는 휠로 확대하고 끌어서 옮깁니다.` }),
        ]),
      ]),
    );
  }

  // ---------- 지나온 문서 ----------
  function paintTrail() {
    if (!view.trail.length) return trailBox.replaceChildren();
    const first = Math.max(0, view.trail.length - TRAIL_SHOWN);
    const crumb = (key, i) => {
      const n = full.nodes.get(key);
      const last = i === view.trail.length - 1;
      return el("li", {}, [
        icon("right", 12),
        last
          ? el("span", { class: "gcrumb now", "aria-current": "page", text: labelName(n) })
          : el("button", { type: "button", class: "gcrumb", text: labelName(n), title: `${labelName(n)} 로 돌아가기`, onclick: () => back(i) }),
      ]);
    };
    trailBox.replaceChildren(
      el("button", { type: "button", class: "btn sm ghost gback", "aria-label": view.trail.length < 2 ? "시작 화면으로" : "앞 문서로 돌아가기", title: view.trail.length < 2 ? "시작 화면으로" : "앞 문서로", onclick: () => (view.trail.length < 2 ? go(null) : back(view.trail.length - 2)) }, [icon("back", 14)]),
      el("ol", { class: "gcrumbs" }, [
        el("li", {}, el("button", { type: "button", class: "gcrumb", text: "시작", title: "시작 화면으로", onclick: () => go(null) })),
        first > 0 ? el("li", { class: "dim", title: `앞의 ${first} 문서` }, [icon("right", 12), el("span", { class: "gcrumb-gap", text: "…" })]) : null,
        ...view.trail.slice(first).map((key, i) => crumb(key, first + i)),
      ]),
    );
  }
  function back(i) {
    const key = view.trail[i];
    view.trail = view.trail.slice(0, i + 1);
    go(key, { focus: true });
  }

  // ---------- 왼쪽 패널 다시 그리기 ----------
  function paintSummary() {
    const n = sel && full.nodes.get(sel);
    summary.hidden = !n;
    if (!n) return summary.replaceChildren();
    const d = byKey.get(sel);
    const mine = broken.filter((b) => b.from === sel);
    const two = lib.reach(g, sel, { depth: 2, direction: "both" }).nodes.size - 1;
    const scoreSlot = el("span", {});
    if (n.kind === "main") lastScore(n.id).then((s) => s.run && scoreSlot.replaceChildren(el("span", { class: "chip scorechip", text: `Score ${s.run.score}` })));
    summary.replaceChildren(
      el("div", { class: "plabel", text: "고른 문서" }),
      el("div", { class: "gcard" }, [
        el("div", { class: "gcard-h" }, [el("span", { class: n.kind === "main" ? "badge-main" : "kind-badge", style: { "--c": typeColor(n.type) }, text: kindTag(n.type, n.kind) }), el("b", { class: "mono gcard-id", text: n.id })]),
        d?.title && d.title !== n.id ? el("div", { class: "gcard-t", text: d.title }) : null,
        el("div", { class: "gcard-chips" }, [
          el("span", { class: "chip" }, [glyph(n, 14), ` ${typeName(n.type)}`]),
          n.type === "domain-skill" ? el("span", { class: "chip", text: n.kind }) : null,
          n.status === "inactive" ? el("span", { class: "chip", text: "비활성" }) : null,
          scoreSlot,
        ]),
        el("dl", { class: "pkv" }, [
          el("dt", { text: "가리킴" }), el("dd", { text: String(deg.get(sel)?.out ?? 0) }),
          el("dt", { text: "가리켜짐" }), el("dd", { text: String(deg.get(sel)?.in ?? 0) }),
          el("dt", { text: "2단까지" }), el("dd", { text: `${num(two)} 문서` }),
          el("dt", { text: "끊김" }), el("dd", { class: mine.length ? "gbroken" : "", text: mine.length ? `${mine.length} · ${mine.map((b) => b.text).join(", ")}` : "0" }),
        ]),
        el("div", { class: "gcard-acts" }, [
          el("button", { type: "button", class: "btn primary gopen", text: "문서 열기", onclick: () => openDoc(n) }),
          el("button", { type: "button", class: "btn gopen", title: "이 문서에서 다른 문서까지의 가장 짧은 길", onclick: () => {
            view.path = { ...view.path, from: sel, to: view.path.to === sel ? null : view.path.to };
            setMode("path");
            toPick.input.focus();
          } }, "경로 찾기"),
        ]),
      ]),
    );
  }
  /** A folding list: its heading carries the count, its rows are made when it first opens. */
  function fold(id, label, count, body, { cls = "", mark = null } = {}) {
    const box = el("details", { class: `gfold ${cls}`.trim(), open: !!view.open[id] }, [
      el("summary", {}, [icon("right", 13), mark, el("span", { class: "grow-name", text: label }), el("span", { class: "grow-n", text: num(count) })]),
    ]);
    let made = false;
    const fill = () => {
      if (made || !box.open) return;
      made = true;
      box.appendChild(body());
    };
    box.addEventListener("toggle", () => {
      view.open[id] = box.open;
      fill();
    });
    fill();
    return box;
  }
  /** A long list, `LIST_STEP` rows at a time. */
  function pagedList(items, row) {
    const ul = el("ul", { class: "gpick" });
    let at = 0;
    const moreBtn = el("button", { type: "button", class: "btn sm ghost gmore-btn", onclick: () => add() });
    function add() {
      for (const it of items.slice(at, at + LIST_STEP)) ul.appendChild(el("li", {}, row(it)));
      at = Math.min(items.length, at + LIST_STEP);
      moreBtn.hidden = at >= items.length;
      moreBtn.textContent = `${num(Math.min(LIST_STEP, items.length - at))} 줄 더 보기 · 남은 ${num(items.length - at)}`;
    }
    add();
    return el("div", {}, [ul, moreBtn]);
  }
  function paintLists() {
    const hubList = lib.hubs(g, { limit: 10, skip: (n) => n.kind === "main" });
    const orphans = lib.orphansByType(g);
    const orphanN = orphans.reduce((s, o) => s + o.keys.length, 0);
    const brokenShown = broken.filter((b) => g.nodes.has(b.from));
    lists.replaceChildren(
      el("div", { class: "plabel", text: "목록" }),
      fold("hubs", "허브 문서 — 연결이 많은 순", hubList.length, () =>
        hubList.length
          ? el("ul", { class: "gpick" }, hubList.map((x) => el("li", {}, docRow(g.nodes.get(x.key), num(x.degree), { onclick: () => { view.mode = "ego"; go(x.key, { focus: true }); } }))))
          : el("p", { class: "dim pnone", text: "연결된 문서가 없습니다." })),
      fold("orphans", "연결 없는 문서", orphanN, () =>
        orphans.length
          ? el("div", { class: "gfold-in" }, [
              el("p", { class: "dim gl-note", text: "가리키는 선도 가리켜지는 선도 없는 문서입니다. 누르면 문서가 열립니다." }),
              ...orphans.map((o) => fold(`orphans:${o.type}`, typeName(o.type), o.keys.length, () =>
                pagedList(o.keys, (key) => {
                  const n = g.nodes.get(key);
                  const name = labelName(n);
                  return el("a", { class: "grow", href: `#/doc/${n.type}/${enc(n.id)}`, title: `${typeName(n.type)} · ${n.id}` }, [
                    glyph(n),
                    el("span", { class: "grow-name", text: name }),
                    n.status === "inactive" ? el("span", { class: "grow-off", text: "비활성" }) : null,
                  ]);
                }), { cls: "sub", mark: glyph(sample(o.type)) })),
            ])
          : el("p", { class: "dim pnone", text: "모든 문서가 이어져 있습니다." })),
      fold("broken", "끊긴 연결 — 등록 안 된 [[ ]]", brokenShown.length, () =>
        brokenShown.length
          ? pagedList(brokenShown, (b) => {
              const n = g.nodes.get(b.from);
              const row = docRow(n, null, { title: `${n.id} 의 본문이 [[${b.text}]] 를 가리킵니다`, onclick: () => { view.mode = "ego"; go(b.from, { focus: true }); } });
              row.appendChild(el("span", { class: "grow-miss", text: `[[${b.text}]]` }));
              return row;
            })
          : el("p", { class: "dim pnone", text: "끊긴 연결이 없습니다." })),
    );
  }

  // ---------- 고르기 · 보기 바꾸기 · 다시 그리기 ----------
  /** The trail after `key` is picked: one step back drops the last, a new doc is added. */
  function walk(key) {
    if (!key) view.trail = [];
    else if (view.trail.at(-2) === key) view.trail.pop();
    else if (view.trail.at(-1) !== key) view.trail = [...view.trail, key].slice(-30);
  }
  function pathHash() {
    const q = new URLSearchParams();
    if (view.path.from) q.set("from", view.path.from);
    if (view.path.to) q.set("to", view.path.to);
    if (view.path.directed) q.set("dir", "1");
    const s = q.toString();
    return `#/graph/path${s ? `?${s}` : ""}`;
  }
  /** The address of what stands now. 전체 keeps the 둘레 address: it is a way of looking, not a place. */
  function hashNow() {
    if (view.mode === "matrix") return "#/graph/matrix";
    if (view.mode === "path") return pathHash();
    const n = sel && full.nodes.get(sel);
    return n ? `#/graph/${n.type}/${enc(n.id)}` : "#/graph";
  }
  function setMode(mode) {
    view.mode = mode;
    const hash = hashNow();
    if (location.hash !== hash) history.pushState(null, "", hash);
    refresh();
  }
  /** 경로's 출발 · 도착 · 방향 changed: the address follows without a new history step. */
  function setPath(patch) {
    view.path = { ...view.path, ...patch };
    const hash = pathHash();
    if (location.hash !== hash) history.replaceState(null, "", hash);
    refresh();
  }
  function go(key, { push = true, focus = false } = {}) {
    const n = key && full.nodes.get(key);
    const changed = (n ? key : null) !== sel;
    sel = n ? key : null;
    if (changed) more = {};
    walk(sel);
    if (n) setLastDoc({ type: n.type, id: n.id });
    const hash = hashNow();
    if (push && location.hash !== hash) history.pushState(null, "", hash);
    refresh();
    if (focus) (sel && drawn?.nodes.get(sel) ? drawn.nodes.get(sel).g : canvas).focus({ preventScroll: true });
  }
  /** `keep` = { key, sx, sy }: after drawing, that doc stands at that screen spot (a group just opened). */
  function refresh({ keep = null } = {}) {
    const { from, to } = view.path;
    g = lib.filterGraph(full, (n) => shown(n) || n.key === sel || (view.mode === "path" && (n.key === from || n.key === to)));
    deg = lib.degrees(g);
    hover = null;
    svg.classList.remove("hovering");
    const mode = view.mode;
    const ps = mode === "path" ? pathState() : null;
    const startScreen = mode === "ego" && !sel;
    const pictured = (mode === "ego" && !!sel) || mode === "all" || ps?.kind === "path";
    start.hidden = !(startScreen || (ps && ps.kind !== "path"));
    matrixBox.hidden = mode !== "matrix";
    canvas.hidden = !pictured;
    mini.hidden = mode !== "all";
    trailBox.hidden = mode === "matrix" || mode === "path";
    pathBar.hidden = mode !== "path";
    search.box.hidden = mode === "path";
    depthBox.hidden = !((mode === "ego" || mode === "all") && sel);
    zoomBox.hidden = !pictured;
    regroup.hidden = !(mode === "all" && view.groups.size);
    modeSeg.sync();
    depthSeg.sync();
    hint.textContent =
      mode === "matrix" ? "칸을 누르면 그 선과 문서가 아래에 섭니다"
      : mode === "path" ? "카드를 누르면 그 문서의 둘레"
      : startScreen ? ""
      : mode === "ego" ? "이웃을 누르면 가운데로 · Shift+클릭은 경로"
      : "점을 누르면 그 문서의 둘레 · 묶음은 눌러 펼침";
    paintSummary();
    const listsOf = JSON.stringify([[...view.hidden], [...view.roles], sel && !shown(full.nodes.get(sel)) ? sel : null]);
    if (listsOf !== listsFor) paintLists();
    listsFor = listsOf;
    paintTrail();
    if (ps) paintPathBar(ps);
    if (!pictured) {
      drawn = null;
      world.replaceChildren();
      if (startScreen) return paintStart();
      if (mode === "matrix") return paintMatrix();
      return paintPathNote(ps);
    }
    if (mode === "ego") drawEgo();
    else if (mode === "path") drawPath(ps.res);
    else drawAll();
    if (drawn.kind === "all" && !drawn.nodes.size) {
      start.replaceChildren(el("p", { class: "loading", text: full.nodes.size ? "보이는 연결이 없습니다 — 왼쪽 필터를 켜 보세요." : "문서가 없습니다." }));
      start.hidden = false;
      canvas.hidden = true;
      mini.hidden = true;
    }
    const at = keep && drawn.nodes.get(keep.key);
    if (at) {
      cam.tx = keep.sx - at.x * cam.s;
      cam.ty = keep.sy - at.y * cam.s;
      cam.fitted = false;
      apply();
      if (keep.focus) at.g.focus({ preventScroll: true });
    } else fit();
  }

  live = {
    root,
    version: docsVersion,
    /** The address changed (back · forward · a link from a doc): the picture follows it. */
    route(key, mode) {
      const next = key && full.nodes.has(key) ? key : null;
      takeMode(mode);
      if (next) view.mode = "ego";
      go(next, { push: false });
    },
  };
  if (sel) setLastDoc({ type: full.nodes.get(sel).type, id: full.nodes.get(sel).id });
  refresh();
  if (!sel && view.mode === "ego") search.input.focus({ preventScroll: true });
  else if (view.mode === "path" && !view.path.from) fromPick.input.focus({ preventScroll: true });
  else if (view.mode === "path" && !view.path.to) toPick.input.focus({ preventScroll: true });
}
