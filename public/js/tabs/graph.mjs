// 그래프 탭(5-v2): the whole graph fitted to the body (메인 · 1단 · 2단 …
// columns from graph-model layoutColumns), the picked doc's paths dark and
// the rest faint, 연결 없음 in a dotted box, broken [[ ]] as red dashes to a
// hollow dot, and a 160×100 minimap. Left: 필터 · 고른 문서 · 범례.
// One click picks, two open the doc with its 연결 tab.
import { allDocs, lastScore } from "../api.mjs";
import { el, icon, svgEl } from "../dom.mjs";
import { kindTag } from "../md.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPES, TYPE_LABEL, isMdType, setLastDoc, typeColor } from "../state.mjs";
import { openDocWithPanel } from "./doc-view.mjs";

const graphLib = import("/lib/shared/graph-model.mjs");
const enc = encodeURIComponent;

// Kept while the page lives: the filter and the view choices.
const view = { depth: Infinity, onlyPath: true, hidden: new Set(), roles: new Set(["main", "sub"]), brokenOnly: false, zoom: null };

const GAP = 110;
const MIN_ROW = 58;
const PAD = 40;

let ticket = 0;
export async function renderGraph(selKey) {
  const my = ++ticket;
  setActiveTab("graph");
  setCrumbs([{ label: "그래프" }]);
  const [lib, docs] = await Promise.all([graphLib, allDocs()]);
  if (my !== ticket) return;
  const graphTypes = DOC_TYPES.filter((t) => t !== "fab-line");
  const graph = lib.buildGraph(docs, graphTypes);
  const byKey = new Map(docs.map((d) => [`${d.type}/${d.id}`, d]));
  // Edges a body's [[ ]] made, and the [[ ]] that point nowhere.
  const bodyEdge = new Set();
  const broken = [];
  for (const d of docs) {
    const from = `${d.type}/${d.id}`;
    if (!graph.nodes.has(from)) continue;
    for (const w of d.wikilinks ?? []) {
      if (w.found) bodyEdge.add(`${from}>${w.type}/${w.id}`);
      else broken.push({ from, text: w.text, key: `missing:${from}:${w.text}` });
    }
  }
  let sel = selKey && graph.nodes.has(selKey) ? selKey : null;
  if (sel) setLastDoc({ type: graph.nodes.get(sel).type, id: graph.nodes.get(sel).id });

  // ---------- 왼쪽: 필터 · 고른 문서 · 범례 ----------
  const counts = new Map();
  for (const n of graph.nodes.values()) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  const check = (checked, onchange, label, extra) =>
    el("label", { class: "gf-row" }, [el("input", { type: "checkbox", checked, onchange }), ...label, extra ? el("span", { class: "gf-n", text: extra }) : null]);
  const filterBox = el("div", { class: "psec gf" }, [
    el("div", { class: "plabel", text: "필터 · 타입" }),
    ...TYPES.filter((t) => graphTypes.includes(t.id)).map((t) =>
      check(!view.hidden.has(t.id), (e) => {
        if (e.currentTarget.checked) view.hidden.delete(t.id);
        else view.hidden.add(t.id);
        draw();
      }, [el("span", { class: "tdot", style: { "--c": t.color } }), ` ${t.id === "domain-skill" ? "스킬 문서" : t.label}`], String(counts.get(t.id) ?? 0)),
    ),
    el("div", { class: "plabel gf-sub", text: "역할" }),
    el("div", { class: "gf-roles" }, ["main", "sub"].map((r) =>
      check(view.roles.has(r), (e) => {
        if (e.currentTarget.checked) view.roles.add(r);
        else view.roles.delete(r);
        draw();
      }, [el("span", { class: r === "main" ? "badge-main" : "wchip-t gf-subtag", text: r })]),
    )),
    check(view.brokenOnly, (e) => {
      view.brokenOnly = e.currentTarget.checked;
      draw();
    }, [" 끊긴 연결만"], String(broken.length)),
  ]);
  const summary = el("div", { class: "psec gsum" });
  const legend = el("div", { class: "psec glegend" }, [
    el("div", { class: "plabel", text: "범례" }),
    el("div", { class: "gl-grid" }, [
      legendItem(svgEl("circle", { cx: 9, cy: 9, r: 8, class: "gl-fill" }), "main 스킬"),
      legendItem(svgEl("circle", { cx: 9, cy: 9, r: 4.5, class: "gl-fill" }), "sub 스킬"),
      legendItem(svgEl("rect", { x: 4, y: 4, width: 10, height: 10, rx: 1, class: "gl-fill" }), "구조 문서(표 · msg · 매뉴얼 · 화면)"),
      legendItem(svgEl("rect", { x: 4, y: 4, width: 10, height: 10, rx: 3.5, class: "gl-fill" }), "md 문서(VOC · 등록 · 미분류)"),
      legendItem(svgEl("line", { x1: 0, y1: 9, x2: 26, y2: 9, class: "ge" }), "links", 28),
      legendItem(svgEl("line", { x1: 0, y1: 9, x2: 26, y2: 9, class: "ge body" }), "본문 [[ ]]", 28),
      legendItem(svgEl("line", { x1: 0, y1: 9, x2: 26, y2: 9, class: "ge scr" }), "rel screen", 28),
      legendItem(svgEl("line", { x1: 0, y1: 9, x2: 26, y2: 9, class: "ge broken" }), "끊긴 연결", 28),
    ]),
    el("p", { class: "dim gl-note", text: "점 색 = 타입 색" }),
  ]);
  const left = panel("left graph-panel", [el("div", { class: "panel-scroll gpanel" }, [filterBox, summary, legend])], "그래프 필터");

  // ---------- 가운데: 띠 · 캔버스 · 연결 없음 · 미니맵 ----------
  const selChip = el("span", { class: "gsel" });
  const depthSeg = el("div", { class: "seg", role: "group", "aria-label": "깊이" }, [
    ["1", 1],
    ["2", 2],
    ["전부", Infinity],
  ].map(([label, v]) => el("button", { type: "button", "aria-pressed": String(view.depth === v), text: label, onclick: (e) => {
    view.depth = v;
    for (const b of depthSeg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
    highlight();
  } })));
  const zoomText = el("span", { class: "gzoom mono", "aria-live": "polite" });
  const canvas = el("div", { class: "gcanvas", tabindex: "-1" });
  const orphanBox = el("div", { class: "gorphans" });
  const mini = el("div", { class: "gmini", "aria-hidden": "true" });
  const stage = el("div", { class: "gstage" }, [canvas, el("div", { class: "gcorner" }, [orphanBox, mini])]);
  const main = el("main", { class: "main wide gmain", "aria-label": "문서 관계 그래프" }, [
    el("div", { class: "gbar" }, [
      selChip,
      el("span", { class: "dim", text: "깊이" }),
      depthSeg,
      el("label", { class: "gf-inline" }, [el("input", { type: "checkbox", checked: view.onlyPath, onchange: (e) => { view.onlyPath = e.currentTarget.checked; highlight(); } }), " 경로만 진하게"]),
      el("span", { class: "sp" }),
      el("span", { class: "dim gbar-hint", text: "한 번 = 고르기 · 두 번 = 읽기 화면" }),
      el("button", { type: "button", class: "btn sm", text: "화면에 맞춤", onclick: () => { view.zoom = null; layoutZoom(); } }),
      zoomText,
      el("button", { type: "button", class: "btn sm ghost", "aria-label": "작게", onclick: () => zoomBy(1 / 1.15) }, "−"),
      el("button", { type: "button", class: "btn sm ghost", "aria-label": "크게", onclick: () => zoomBy(1.15) }, "+"),
    ]),
    stage,
  ]);
  screen().appendChild(cols({ left, main, className: "graph-cols" }));

  // ---------- 그리기 ----------
  const ctx2 = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(document.body).fontFamily;
  const textW = (s, font) => ((ctx2.font = `${font} ${family}`), ctx2.measureText(s).width);
  let drawn = null; // {svg, nodes: Map<key, g>, edges: [{path, i|null, key}], world: {w, h}, pos}

  function shown(n) {
    if (view.hidden.has(n.type)) return false;
    if (n.type === "domain-skill" && !view.roles.has(n.kind)) return false;
    if (view.brokenOnly) return broken.some((b) => b.from === n.key);
    return true;
  }
  const radius = (n) => (n.kind === "main" ? 10 : n.kind === "sub" ? 5 : 5);
  function shape(n, cls = "") {
    const c = typeColor(n.type);
    if (n.type === "domain-skill") return svgEl("circle", { r: radius(n), fill: c, class: `gshape ${cls}` });
    const s = 11;
    return svgEl("rect", { x: -s / 2, y: -s / 2, width: s, height: s, rx: isMdType(n.type) ? 3.5 : 1.5, fill: c, class: `gshape ${cls}` });
  }

  function draw() {
    const columns = lib.layoutColumns(graph, shown);
    const linked = columns.filter((c) => c.dist !== null);
    const orphans = columns.find((c) => c.dist === null)?.keys ?? [];
    const pos = new Map();
    const labelOf = (n) => {
      const tag = kindTag(n.type, n.kind);
      const name = n.type === "db-schema" || n.type === "msg-format" ? n.id : n.name;
      return { tag, name, w: textW(tag, "700 11px") + 10 + 6 + textW(name, "14px") };
    };
    const labels = new Map();
    for (const c of linked) for (const k of c.keys) labels.set(k, labelOf(graph.nodes.get(k)));
    // A broken [[ ]] stands one column right of its source.
    const colOf = new Map();
    linked.forEach((c, ci) => c.keys.forEach((k) => colOf.set(k, ci)));
    const missingAt = broken.filter((b) => colOf.has(b.from)).map((b) => ({ ...b, col: colOf.get(b.from) + 1 }));
    const ncol = Math.max(linked.length, ...missingAt.map((m) => m.col + 1), 1);
    // Each column's stack: its documents, then the broken targets standing in it.
    const stacks = Array.from({ length: ncol }, (_, ci) => [...(linked[ci]?.keys ?? []), ...missingAt.filter((m) => m.col === ci).map((m) => m.key)]);
    const tallest = Math.max(1, ...stacks.map((st) => st.length));
    const extent = (ci) => {
      const ws = [
        ...(linked[ci]?.keys ?? []).map((k) => labels.get(k).w),
        ...missingAt.filter((m) => m.col === ci).map((m) => textW(m.text, "14px") + textW("등록 안 됨", "600 11px") + 40),
      ];
      return Math.max(60, ...ws);
    };
    const xs = [];
    let x = PAD + extent(0) + 22;
    for (let ci = 0; ci < ncol; ci++) {
      xs.push(x);
      const right = ci === 0 ? 14 : 10 + extent(ci) + 8;
      x += right + GAP;
    }
    // Rows spread to the canvas's shape, so a wide graph is not a thin strip.
    const aspect = canvas.clientHeight / Math.max(1, canvas.clientWidth);
    const ROW = Math.max(MIN_ROW, Math.min(120, ((x - GAP + PAD) * aspect * 0.8 - PAD * 2 - 40) / tallest));
    const heads = [];
    stacks.forEach((st, ci) => {
      const y0 = PAD + 40 + ((tallest - st.length) * ROW) / 2;
      const head = linked[ci] ? (linked[ci].dist === 0 ? "메인" : `${linked[ci].dist}단`) : `${ci}단`;
      heads.push(svgEl("text", { class: "gcol-h", x: xs[ci], y: PAD + 6, "text-anchor": ci === 0 ? "end" : "start", text: head }));
      st.forEach((k, i) => pos.set(k, { x: xs[ci], y: y0 + i * ROW, col: ci }));
    });
    const missing = missingAt.map((m) => ({ ...m, ...pos.get(m.key) }));
    for (const m of missing) pos.delete(m.key);
    const worldW = x - GAP + PAD;
    const worldH = PAD * 2 + 40 + tallest * ROW;
    const edgeLayer = svgEl("g", {});
    const edges = [];
    graph.edges.forEach((e, i) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return;
      const from = a.col === 0 ? a.x + radius(graph.nodes.get(e.from)) + 2 : a.x + 10 + labels.get(e.from).w + 8;
      const to = b.x - radius(graph.nodes.get(e.to)) - 3;
      let d;
      if (a.col >= b.col) {
        const bend = Math.max(from, b.x + labels.get(e.to).w) + 40;
        d = `M${from} ${a.y} C${bend} ${a.y} ${bend} ${b.y} ${b.x + 10 + labels.get(e.to).w + 4} ${b.y}`;
      } else {
        const m = (from + to) / 2;
        d = `M${from} ${a.y} C${m} ${a.y} ${m} ${b.y} ${to} ${b.y}`;
      }
      const kind = e.rel === "screen" ? "scr" : bodyEdge.has(`${e.from}>${e.to}`) ? "body" : "";
      const path = svgEl("path", { class: `ge ${kind}`, d });
      edgeLayer.appendChild(path);
      edges.push({ path, i, from: e.from, to: e.to });
    });
    for (const m of missing) {
      const a = pos.get(m.from);
      const from = a.col === 0 ? a.x + 12 : a.x + 10 + labels.get(m.from).w + 8;
      const path = svgEl("path", { class: "ge broken", d: `M${from} ${a.y} L${m.x - 7} ${m.y}` });
      edgeLayer.appendChild(path);
      edges.push({ path, i: null, from: m.from, to: m.key });
    }
    const nodeLayer = svgEl("g", {});
    const nodes = new Map();
    for (const [k, p] of pos) {
      const n = graph.nodes.get(k);
      const lb = labels.get(k);
      const leftLabel = p.col === 0;
      const lx = leftLabel ? -(radius(n) + 8 + lb.w) : radius(n) + 8;
      const tagW = textW(lb.tag, "700 11px") + 10;
      const g = svgEl("g", { class: `gn kind-${n.kind}`, transform: `translate(${p.x},${p.y})`, tabindex: "0", role: "button", "aria-label": `${TYPE_LABEL[n.type] ?? n.type} ${n.id}`, "data-key": k }, [
        svgEl("title", { text: `${n.type} · ${n.id}\n한 번 = 고르기 · 두 번 = 읽기 화면(연결 탭)` }),
        n.kind === "main" ? svgEl("circle", { r: 15, class: "gsel-ring" }) : null,
        shape(n),
        svgEl("rect", { x: lx, y: -9, width: tagW, height: 18, rx: 3, class: "gtag", style: { "--c": typeColor(n.type) } }),
        svgEl("text", { x: lx + tagW / 2, y: 4, "text-anchor": "middle", class: "gtag-t", text: lb.tag }),
        svgEl("text", { x: lx + tagW + 6, y: 5, class: "gname", text: lb.name }),
      ]);
      g.addEventListener("click", (e) => {
        if (e.detail > 1) return;
        select(sel === k ? null : k);
      });
      g.addEventListener("dblclick", () => openDocWithPanel(n.type, n.id, "links"));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.shiftKey) return openDocWithPanel(n.type, n.id, "links");
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select(sel === k ? null : k);
        }
      });
      nodeLayer.appendChild(g);
      nodes.set(k, g);
    }
    for (const m of missing) {
      const g = svgEl("g", { class: "gn missing", transform: `translate(${m.x},${m.y})`, "data-key": m.key }, [
        svgEl("title", { text: `[[${m.text}]] — 등록 안 된 문서 (${m.from})` }),
        svgEl("rect", { x: -6, y: -6, width: 12, height: 12, rx: 2, class: "gmissing" }),
        svgEl("text", { x: 14, y: 4, class: "gname", text: m.text }),
        svgEl("rect", { x: 20 + textW(m.text, "14px"), y: -9, width: textW("등록 안 됨", "600 11px") + 12, height: 18, rx: 9, class: "gnoreg" }),
        svgEl("text", { x: 26 + textW(m.text, "14px"), y: 4, class: "gnoreg-t", text: "등록 안 됨" }),
      ]);
      nodeLayer.appendChild(g);
      nodes.set(m.key, g);
    }
    const svg = svgEl("svg", { class: "gsvg", viewBox: `0 0 ${worldW} ${worldH}`, role: "group", "aria-label": `문서 ${pos.size} · 선 ${edges.length}` }, [...heads, edgeLayer, nodeLayer]);
    canvas.replaceChildren(svg);
    drawn = { svg, nodes, edges, world: { w: worldW, h: worldH }, pos, missing, edgeLayer };
    orphanBox.replaceChildren(
      ...(orphans.length
        ? [
            el("div", { class: "gorph-h", text: `연결 없음 ${orphans.length}` }),
            el("ul", {}, orphans.map((k) => {
              const n = graph.nodes.get(k);
              return el("li", {}, el("button", { type: "button", class: `gorph${sel === k ? " on" : ""}`, onclick: () => select(k), ondblclick: () => openDocWithPanel(n.type, n.id, "links") }, [
                el("span", { class: "tdot", style: { "--c": typeColor(n.type) } }),
                el("span", { class: "wchip-t", style: { "--c": typeColor(n.type) }, text: kindTag(n.type, n.kind) }),
                el("span", { class: "mono", text: n.type === "db-schema" ? n.id : n.name }),
              ]));
            })),
          ]
        : []),
    );
    orphanBox.hidden = !orphans.length;
    if (!pos.size)
      canvas.replaceChildren(el("p", { class: "loading", text: graph.nodes.size ? "보이는 문서가 없습니다 — 필터를 풀어 보세요." : "문서가 없습니다." }));
    layoutZoom();
    highlight();
  }

  // ---------- 확대 · 맞춤 · 미니맵 ----------
  function fitScale() {
    if (!drawn) return 1;
    const w = canvas.clientWidth - 8;
    const h = canvas.clientHeight - 8;
    return Math.max(0.2, Math.min(w / drawn.world.w, h / drawn.world.h, 1.4));
  }
  function layoutZoom() {
    if (!drawn?.svg) return;
    const s = view.zoom ?? fitScale();
    drawn.svg.setAttribute("width", String(Math.round(drawn.world.w * s)));
    drawn.svg.setAttribute("height", String(Math.round(drawn.world.h * s)));
    zoomText.textContent = `${Math.round(s * 100)}%`;
    paintMini();
  }
  function zoomBy(f) {
    view.zoom = Math.max(0.2, Math.min(3, (view.zoom ?? fitScale()) * f));
    layoutZoom();
  }
  function paintMini() {
    if (!drawn?.pos) return mini.replaceChildren();
    const W = 160;
    const H = 100;
    const s = Math.min(W / drawn.world.w, H / drawn.world.h);
    const svgW = drawn.svg.getBoundingClientRect().width || 1;
    const ratio = drawn.world.w / svgW;
    const vx = canvas.scrollLeft * ratio;
    const vy = canvas.scrollTop * ratio;
    const vw = Math.min(drawn.world.w, canvas.clientWidth * ratio);
    const vh = Math.min(drawn.world.h, canvas.clientHeight * ratio);
    mini.replaceChildren(
      el("div", { class: "gmini-h", text: "미니맵 · 보이는 영역" }),
      svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}` }, [
        ...[...drawn.pos].map(([k, p]) => svgEl("rect", { x: p.x * s - 1.5, y: p.y * s - 1.5, width: 3, height: 3, fill: typeColor(graph.nodes.get(k).type) })),
        svgEl("rect", { class: "gmini-view", x: vx * s, y: vy * s, width: Math.max(4, vw * s - 1), height: Math.max(4, vh * s - 1) }),
      ]),
    );
  }
  canvas.addEventListener("scroll", paintMini);
  new ResizeObserver(() => layoutZoom()).observe(canvas);

  // ---------- 고르기 · 경로 ----------
  function select(key) {
    sel = key;
    const n = key && graph.nodes.get(key);
    if (n) setLastDoc({ type: n.type, id: n.id });
    history.replaceState(null, "", n ? `#/graph/${n.type}/${enc(n.id)}` : "#/graph");
    highlight();
    paintSummary();
    for (const b of orphanBox.querySelectorAll(".gorph")) b.classList.remove("on");
  }
  function highlight() {
    const n = sel && graph.nodes.get(sel);
    selChip.replaceChildren(
      n
        ? el("button", { type: "button", class: "chip gsel-chip", "aria-label": `${n.id} — 고르기 풀기`, onclick: () => select(null) }, [el("span", { class: "dim", text: "고른 문서 " }), el("b", { text: n.id }), icon("x", 12)])
        : el("span", { class: "dim", text: "고른 문서 없음 — 점을 누르세요" }),
    );
    if (!drawn?.nodes) return;
    const r = sel ? lib.reach(graph, sel, { depth: view.depth, direction: "both" }) : null;
    const onNodes = new Set(r ? r.nodes : []);
    for (const m of drawn.missing ?? []) if (onNodes.has(m.from) && (!r || m.from === sel || view.depth === Infinity)) onNodes.add(m.key);
    for (const [k, g] of drawn.nodes) {
      g.classList.toggle("sel", k === sel);
      g.classList.toggle("on", !!r && onNodes.has(k));
      g.classList.toggle("dim", !!r && view.onlyPath && !onNodes.has(k));
      g.setAttribute("aria-pressed", String(k === sel));
    }
    for (const e of drawn.edges) {
      const on = !!r && (e.i === null ? onNodes.has(e.from) && onNodes.has(e.to) : r.edges.has(e.i));
      e.path.classList.toggle("on", on);
      e.path.classList.toggle("dim", !!r && view.onlyPath && !on);
      if (on) drawn.edgeLayer.appendChild(e.path);
    }
  }
  function paintSummary() {
    const n = sel && graph.nodes.get(sel);
    if (!n) {
      summary.replaceChildren(el("div", { class: "plabel", text: "고른 문서" }), el("p", { class: "dim pnone", text: "그래프의 점을 누르면 여기에 요약이 섭니다." }));
      return;
    }
    const d = byKey.get(sel);
    const out = graph.edges.filter((e) => e.from === sel).length;
    const inn = graph.edges.filter((e) => e.to === sel).length;
    const two = lib.reach(graph, sel, { depth: 2, direction: "both" }).nodes.size - 1;
    const mine = broken.filter((b) => b.from === sel);
    const scoreSlot = el("span", {});
    if (n.kind === "main") lastScore(n.id).then((s) => s.run && scoreSlot.replaceChildren(el("span", { class: "chip scorechip", text: `Score ${s.run.score}` })));
    summary.replaceChildren(
      el("div", { class: "plabel", text: "고른 문서" }),
      el("div", { class: "gcard" }, [
        el("div", { class: "gcard-h" }, [el("span", { class: n.kind === "main" ? "badge-main" : "kind-badge", style: { "--c": typeColor(n.type) }, text: kindTag(n.type, n.kind) }), el("b", { class: "mono", text: n.id })]),
        d?.title && d.title !== n.id ? el("div", { class: "gcard-t", text: d.title }) : null,
        el("div", { class: "gcard-chips" }, [
          el("span", { class: "chip" }, [el("span", { class: "tdot", style: { "--c": typeColor(n.type) } }), ` ${n.type === "domain-skill" ? "스킬 문서" : TYPE_LABEL[n.type] ?? n.type}`]),
          n.type === "domain-skill" ? el("span", { class: "chip", text: n.kind }) : null,
          scoreSlot,
        ]),
        el("dl", { class: "pkv" }, [
          el("dt", { text: "가리킴" }), el("dd", { text: String(out) }),
          el("dt", { text: "가리켜짐" }), el("dd", { text: String(inn) }),
          el("dt", { text: "2단까지" }), el("dd", { text: `${two} 문서` }),
          el("dt", { text: "끊김" }), el("dd", { class: mine.length ? "gbroken" : "", text: mine.length ? `${mine.length} · ${mine.map((b) => b.text).join(", ")}` : "0" }),
        ]),
        el("button", { type: "button", class: "btn primary gopen", text: "문서 열기", onclick: () => openDocWithPanel(n.type, n.id, "links") }),
        el("p", { class: "dim gcard-note", text: "점을 두 번 눌러도 열립니다. 읽기 화면은 연결 탭이 켜진 채 열립니다." }),
      ]),
    );
  }
  draw();
  paintSummary();
  if (sel) requestAnimationFrame(() => drawn?.nodes.get(sel)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
}

function legendItem(shapeNode, label, w = 18) {
  return el("span", { class: "gl-item" }, [svgEl("svg", { width: w, height: 18, viewBox: `0 0 ${w} 18`, "aria-hidden": "true" }, shapeNode), label]);
}

