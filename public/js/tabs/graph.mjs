import { cols as __cols, screen as __screen, setActiveTab as __setActiveTab, setCrumbs as __setCrumbs } from "../shell.mjs";
import { el as __el } from "../dom.mjs";
import { api } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { DOC_TYPES, TYPE_LABEL, setLastDoc, typeInfo } from "../state.mjs";

// ================= 그래프 =================
// 문서 간 관계를 왼→오 층 그래프로. 열 = 메인에서의 거리, 선 = links[]
// (src/graph-model.mjs). 클릭 = 고르기(닿는 길만 진하게), 더블클릭 = 문서 화면.
export const graphModelLib = import("/lib/shared/graph-model.mjs").catch(() => null);
export const KIND_LABEL = {
  main: "메인",
  sub: "sub",
  "db-schema": "표",
  "msg-format": "msg",
  manual: "매뉴얼",
  "screen-map": "화면",
  voc: "VOC",
};
// The types the graph draws, in the type list's order. A type app.css has no
// k- colour for takes its colour from the list.
export const graphTypes = () => DOC_TYPES.filter((t) => t !== "fab-line");
export const kindLabel = (kind) => KIND_LABEL[kind] ?? TYPE_LABEL[kind] ?? kind;
export const CSS_KINDS = new Set(Object.keys(KIND_LABEL));
export function paintKind(node, kind) {
  const color = typeInfo(kind)?.color;
  if (!CSS_KINDS.has(kind) && color) node.style.setProperty("--c", color);
  return node;
}
// 깊이 · 방향 · 숨긴 타입은 화면을 다시 열어도 그대로 둔다.
export const graphView = { depth: Infinity, direction: "both", hidden: new Set() };
export let graphTicket = 0;
export const SVG_NS = "http://www.w3.org/2000/svg";
export function svgEl(tag, attrs, children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children || [])) if (c) node.appendChild(c);
  return node;
}

export async function renderGraph(selKey) {
  wideSection("graph", "그래프", "graph");
  const ticket = ++graphTicket;
  const section = $("graph");
  section.replaceChildren(el("p", { class: "loading", text: "불러오는 중…" }));
  const [lib, res] = await Promise.all([graphModelLib, api("/api/docs")]);
  if (ticket !== graphTicket) return;
  if (!lib || !res.ok) {
    section.replaceChildren(
      el("p", { class: "error", text: `그래프를 불러오지 못했습니다 (${lib ? res.status : "graph-model.mjs"})` }),
    );
    return;
  }
  const graph = lib.buildGraph(res.data.docs, graphTypes());
  let sel = selKey && graph.nodes.has(selKey) ? selKey : null;
  let drawn = null; // { nodes: Map<key, g>, edges: [{ path, i, scr }], layer }
  if (sel) {
    const n = graph.nodes.get(sel);
    setLastDoc({ type: n.type, id: n.id });
  }

  function select(key) {
    sel = key;
    const n = key && graph.nodes.get(key);
    setLastDoc(n ? { type: n.type, id: n.id } : null);
    history.replaceState(null, "", n ? `#/graph/${n.type}/${encodeURIComponent(n.id)}` : "#/graph");
    paintSel();
    highlight();
  }

  const selSlot = el("span", { class: "graph-sel" });
  function paintSel() {
    const n = sel && graph.nodes.get(sel);
    selSlot.replaceChildren(
      n
        ? el("button", { type: "button", class: "graph-sel-chip", "aria-label": `${n.name} — 고르기 풀기`, onclick: () => select(null) }, [
            n.name,
            el("span", { "aria-hidden": "true", text: " ×" }),
          ])
        : el("span", { class: "dim", text: "없음 — 문서를 누르세요" }),
    );
  }
  paintSel();

  const depthSel = el(
    "select",
    {
      "aria-label": "깊이",
      onchange: (e) => {
        graphView.depth = e.currentTarget.value === "all" ? Infinity : Number(e.currentTarget.value);
        highlight();
      },
    },
    ["1", "2", "3", "all"].map((v) =>
      el("option", {
        value: v,
        text: v === "all" ? "전부" : v,
        selected: String(graphView.depth) === v || (v === "all" && graphView.depth === Infinity),
      }),
    ),
  );
  const dirSeg = el(
    "span",
    { class: "graph-seg", role: "group", "aria-label": "방향" },
    [
      ["both", "양쪽"],
      ["down", "아래로만"],
    ].map(([v, label]) =>
      el("button", {
        type: "button",
        "aria-pressed": String(graphView.direction === v),
        text: label,
        onclick: (e) => {
          graphView.direction = v;
          for (const b of dirSeg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
          highlight();
        },
      }),
    ),
  );
  const filterSum = el("summary", {});
  const paintFilterSum = () =>
    (filterSum.textContent = graphView.hidden.size ? `타입 거르기 · ${graphView.hidden.size} 숨김` : "타입 거르기");
  paintFilterSum();
  const filter = el("details", { class: "graph-filter" }, [
    filterSum,
    el(
      "div",
      { class: "graph-filter-menu" },
      graphTypes().map((t) =>
        el("label", {}, [
          el("input", {
            type: "checkbox",
            checked: !graphView.hidden.has(t),
            onchange: (e) => {
              if (e.currentTarget.checked) graphView.hidden.delete(t);
              else graphView.hidden.add(t);
              paintFilterSum();
              draw();
            },
          }),
          ` ${t}`,
        ]),
      ),
    ),
  ]);
  const legend = el(
    "span",
    { class: "graph-legend", "aria-label": "범례" },
    ["main", "sub", ...graphTypes().filter((t) => t !== "domain-skill")].map((kind) =>
      paintKind(el("i", { class: `k-${kind}` }, [el("b", { class: "sw" }), kindLabel(kind)]), kind),
    ),
  );
  const canvas = el("div", { class: "graph-canvas" });
  section.replaceChildren(
    el("div", { class: "graph-tool" }, [
      el("span", { class: "tl", text: "고른 문서" }),
      selSlot,
      el("label", { class: "graph-ctl" }, ["깊이 ", depthSel]),
      dirSeg,
      filter,
      legend,
    ]),
    canvas,
  );

  // 칩 폭은 글자 폭에서 — SVG 를 붙이기 전에 재야 하므로 canvas 로 잰다.
  const ctx = document.createElement("canvas").getContext("2d");
  const family = getComputedStyle(document.body).fontFamily;
  const textW = (s, font) => ((ctx.font = `${font} ${family}`), ctx.measureText(s).width);
  const CH = 24; // 칩 높이
  const ROW = 34;
  const PAD = 16;
  const TOP = 34; // 열 머리 아래
  const COL_GAP = 96;
  const LOOP = 40; // 같은 열 안 선이 오른쪽으로 도는 폭

  function draw() {
    const cols = lib.layoutColumns(graph, (n) => !graphView.hidden.has(n.type));
    if (!cols.length) {
      drawn = null;
      canvas.replaceChildren(
        el("p", {
          class: "loading",
          text: graph.nodes.size ? "보이는 문서가 없습니다 — 타입 거르기를 풀어 보세요." : "문서가 없습니다.",
        }),
      );
      return;
    }
    const pos = new Map(); // key → { x, y, w, tagW, col }
    const heads = [];
    const tallest = Math.max(...cols.map((c) => c.keys.length));
    let x = PAD;
    cols.forEach((c, col) => {
      const y0 = TOP + ((tallest - c.keys.length) * ROW) / 2;
      let colW = textW(c.label, "600 11px");
      c.keys.forEach((k, i) => {
        const n = graph.nodes.get(k);
        const tagW = textW(kindLabel(n.kind), "600 10px") + 10;
        const w = 5 + tagW + 6 + textW(n.name, "12px") + 10;
        pos.set(k, { x, y: y0 + i * ROW, w, tagW, col });
        colW = Math.max(colW, w);
      });
      heads.push(svgEl("text", { class: "g-col-h", x, y: 16, text: c.label }));
      x += colW + COL_GAP;
    });
    const width = x - COL_GAP + LOOP + PAD;
    const height = TOP + tallest * ROW + PAD;

    const marker = (id) =>
      svgEl("marker", { id, viewBox: "0 0 8 8", refX: 8, refY: 4, markerWidth: 8, markerHeight: 8, markerUnits: "userSpaceOnUse", orient: "auto" }, [
        svgEl("path", { d: "M0 0 8 4 0 8z" }),
      ]);
    const layer = svgEl("g", {});
    const edges = [];
    graph.edges.forEach((e, i) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return;
      const ay = a.y + CH / 2;
      const by = b.y + CH / 2;
      let d;
      if (a.col === b.col) {
        // 같은 열: 오른쪽으로 둥글게 돌아 대상의 오른쪽에 닿는다.
        const x1 = a.x + a.w;
        const x2 = b.x + b.w;
        const bend = Math.max(x1, x2) + LOOP;
        d = `M${x1} ${ay} C${bend} ${ay} ${bend} ${by} ${x2} ${by}`;
      } else {
        // 앞 열로 가는 선은 오른쪽 가운데 → 왼쪽 가운데, 뒤 열로 되가리키는 선은 그 반대.
        const fwd = a.col < b.col;
        const x1 = fwd ? a.x + a.w : a.x;
        const x2 = fwd ? b.x : b.x + b.w;
        const m = (x1 + x2) / 2;
        d = `M${x1} ${ay} C${m} ${ay} ${m} ${by} ${x2} ${by}`;
      }
      const scr = e.rel === "screen";
      const path = svgEl("path", { class: scr ? "g-edge scr" : "g-edge", d });
      layer.appendChild(path);
      edges.push({ path, i, scr });
    });
    const nodes = new Map();
    const nodeLayer = svgEl("g", {});
    for (const [k, p] of pos) {
      const n = graph.nodes.get(k);
      const g = svgEl(
        "g",
        {
          class: `g-node k-${n.kind}`,
          transform: `translate(${p.x},${p.y})`,
          tabindex: "0",
          role: "button",
          "aria-label": `${kindLabel(n.kind)} ${n.name}`,
        },
        [
          svgEl("title", { text: `${n.type} · ${n.id}\n클릭 = 고르기 · 더블클릭 = 문서 열기` }),
          svgEl("rect", { class: "box", width: p.w, height: CH, rx: 6 }),
          svgEl("rect", { class: "tag", x: 5, y: 5, width: p.tagW, height: 14, rx: 3 }),
          svgEl("text", { class: "tag-t", x: 5 + p.tagW / 2, y: 15.5, "text-anchor": "middle", text: kindLabel(n.kind) }),
          svgEl("text", { class: "name", x: 5 + p.tagW + 6, y: 16.5, text: n.name }),
        ],
      );
      paintKind(g, n.kind);
      g.addEventListener("click", (e) => {
        if (e.detail > 1) return; // 더블클릭의 두 번째 클릭은 고르기를 풀지 않는다
        select(sel === k ? null : k);
      });
      g.addEventListener("dblclick", () => (location.hash = `#/doc/${n.type}/${encodeURIComponent(n.id)}`));
      g.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        select(sel === k ? null : k);
      });
      nodeLayer.appendChild(g);
      nodes.set(k, g);
    }
    canvas.replaceChildren(
      svgEl("svg", { class: "graph-svg", width, height, viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "문서 관계 그래프" }, [
        svgEl("defs", {}, [marker("g-arr"), marker("g-arr-on"), marker("g-arr-scr")]),
        ...heads,
        layer,
        nodeLayer,
      ]),
    );
    drawn = { nodes, edges, layer };
    highlight();
  }

  function highlight() {
    if (!drawn) return;
    const r = sel ? lib.reach(graph, sel, { depth: graphView.depth, direction: graphView.direction }) : null;
    for (const [k, g] of drawn.nodes) {
      g.classList.toggle("sel", k === sel);
      g.classList.toggle("dim", !!r && !r.nodes.has(k));
      g.setAttribute("aria-pressed", String(k === sel));
    }
    for (const { path, i, scr } of drawn.edges) {
      const on = !!r && r.edges.has(i);
      path.classList.toggle("on", on);
      path.classList.toggle("dim", !!r && !on);
      path.setAttribute("marker-end", `url(#${scr ? "g-arr-scr" : on ? "g-arr-on" : "g-arr"})`);
      // 진한 선을 옅은 선 위에.
      if (on) drawn.layer.appendChild(path);
    }
  }

  draw();
}

function wideSection(tab, label, id) {
  __setActiveTab(tab);
  __setCrumbs([{ label }]);
  const main = __el("main", { class: "main wide" }, __el("section", { id, class: "on" }));
  __screen().appendChild(__cols({ main, className: "wide" }));
}
