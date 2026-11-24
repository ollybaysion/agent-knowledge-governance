// 진단 탭 (#/health/<검사>): 문서 저장소를 한눈에. 위에 검사 카드 여덟(연결 없음 ·
// 끊긴 연결 · 오래됨 · 짧음 · 긺 · 제목 없음 · 겹친 제목 · 최근), 가운데에 타입 × 상태
// 표와 수정 · 크기 분포, 아래에 고른 검사의 문서 목록. 값은 문서 목록 응답에서 센다.
import { everyDoc } from "../api.mjs";
import { docLink, freshBadge, idNote, num, sizeText, typeTag } from "../doc-bits.mjs";
import { el, svgEl } from "../dom.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPE_LABEL, mdTypeIds, typeColor } from "../state.mjs";
import { tableHash } from "/lib/doc-table.mjs";
import { BROKEN_LABEL, CHECKS, LONG_CHARS, SHORT_CHARS, ageHistogram, checkCounts, checkOf, checkRows, docFacts, dupGroups, median, sizeHistogram, typeStatusMatrix } from "/lib/health.mjs";
import { STALE_DAYS, ageLabel } from "/lib/freshness.mjs";

// 목록이 한 번에 보이는 줄 수.
const PAGE = 100;

// 검사마다: 표 보기의 같은 거르기, 걸린 문서가 없을 때의 글.
const CHECK_VIEW = {
  orphans: { table: { links: ["none"] }, none: "모든 문서가 다른 문서와 이어져 있습니다." },
  broken: { table: { links: ["broken"] }, none: "모든 연결의 대상이 살아 있습니다." },
  stale: { table: { age: ["old"], sort: "updated", dir: "asc" }, none: `모든 문서가 ${STALE_DAYS}일 안에 손을 탔습니다.` },
  short: { table: { size: ["short"], sort: "size", dir: "asc" }, none: `모든 문서의 본문이 ${SHORT_CHARS}자 이상입니다.` },
  long: { table: { size: ["long"], sort: "size", dir: "desc" }, none: `모든 문서의 본문이 ${num(LONG_CHARS)}자 안쪽입니다.` },
  untitled: { table: { title: ["none"] }, none: "모든 문서에 제목이 있습니다." },
  dup: { table: { title: ["dup"], sort: "title", dir: "asc" }, none: "제목이 문서마다 다릅니다." },
  recent: { table: { age: ["7"] }, none: "지난 7일 동안 바뀐 문서가 없습니다." },
};
const AGE_FACET = ["7", "30", "90", "180", "old", "old"];
const pct = (n, total) => (total ? `${((n / total) * 100).toFixed(n && n / total < 0.1 ? 1 : 0)}%` : "0%");

/**
 * 막대 분포 그림. bins = [{label, range, count, tone, href}], step = 칸 하나의 폭(px).
 * 막대 위에 수, 아래에 칸 이름. 그림은 제 크기(px)로 서고, 상자가 좁으면 같이 줄어든다.
 */
function histogram(bins, label, step) {
  const W = step * bins.length + 4;
  const H = 236;
  const head = 20;
  const base = H - 24;
  const pad = Math.round(step * 0.14);
  const max = Math.max(1, ...bins.map((b) => b.count));
  return svgEl("svg", { class: "hl-hist", width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${label}: ${bins.map((b) => `${b.range} ${b.count}`).join(", ")}` }, [
    svgEl("line", { class: "hl-axis", x1: 0, y1: base + 0.5, x2: W, y2: base + 0.5 }),
    ...bins.map((b, i) => {
      const x = 2 + i * step + pad;
      const w = step - pad * 2;
      const h = b.count ? Math.max(2, Math.round(((base - head) * b.count) / max)) : 0;
      const bar = [
        svgEl("title", { text: `${b.range}: 문서 ${num(b.count)}` }),
        svgEl("rect", { class: "hl-hit", x: x - pad, y: 0, width: step, height: H }),
        svgEl("rect", { class: `hl-bar tone-${b.tone}`, x, y: base - h, width: w, height: h, rx: 2 }),
        svgEl("text", { class: `hl-num${b.count ? "" : " zero"}`, x: x + w / 2, y: base - h - 5, "text-anchor": "middle", text: num(b.count) }),
        svgEl("text", { class: "hl-lab", x: x + w / 2, y: base + 15, "text-anchor": "middle", text: b.label }),
      ];
      return b.href && b.count ? svgEl("a", { href: b.href, class: "hl-col" }, bar) : svgEl("g", { class: "hl-col" }, bar);
    }),
  ]);
}

/** 타입 한 줄의 활성 · 비활성 막대(폭 = 가장 큰 타입에 대한 비). */
function splitBar(m, max) {
  const W = 120;
  const a = max ? Math.round((W * m.active) / max) : 0;
  const i = max ? Math.round((W * m.inactive) / max) : 0;
  return svgEl("svg", { class: "hl-split", width: W, height: 10, viewBox: `0 0 ${W} 10`, "aria-hidden": "true", style: { "--c": typeColor(m.type) } }, [
    svgEl("rect", { class: "hl-track", x: 0, y: 0, width: W, height: 10, rx: 2 }),
    a ? svgEl("rect", { class: "hl-act", x: 0, y: 0, width: a, height: 10, rx: 2 }) : null,
    i ? svgEl("rect", { class: "hl-inact", x: a, y: 0, width: i, height: 10, rx: 2 }) : null,
  ]);
}

export async function renderHealth(pick = null) {
  setActiveTab("health");
  setCrumbs([{ label: "진단" }]);
  const page = el("section", { class: "page-card health", "aria-label": "문서 현황 진단" }, el("p", { class: "loading", text: "불러오는 중…" }));
  screen().appendChild(cols({ main: el("main", { class: "main wide" }, page), className: "wide" }));

  const all = docFacts(await everyDoc(), Date.now(), { mdTypes: mdTypeIds() });
  if (!page.isConnected) return;
  const query = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const view = {
    check: checkOf(pick) ? pick : "orphans",
    scope: query.get("scope") === "active" ? "active" : "all",
    type: query.get("type") || null,
    shown: PAGE,
  };
  const hashOf = () => {
    const q = [view.scope === "active" ? "scope=active" : null, view.type ? `type=${encodeURIComponent(view.type)}` : null].filter(Boolean).join("&");
    return `#/health/${view.check}${q ? `?${q}` : ""}`;
  };
  const set = (patch) => {
    Object.assign(view, { shown: PAGE }, patch);
    history.replaceState(null, "", `${location.pathname}${location.search}${hashOf()}`);
    paint();
  };
  // 표 보기로 가는 주소: 지금 범위(활성만)를 같이 싣는다.
  const toTable = (state) => tableHash({ ...state, ...(view.scope === "active" ? { status: ["active"] } : {}) });

  function cards(rows, counts) {
    const move = (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const i = CHECKS.findIndex((c) => c.id === view.check);
      set({ check: CHECKS[(i + step + CHECKS.length) % CHECKS.length].id, type: null });
      page.querySelector(".hl-card.on")?.focus();
    };
    return el("div", { class: "hl-cards", role: "tablist", "aria-label": "검사" }, CHECKS.map((c) => {
      const n = counts[c.id];
      const on = c.id === view.check;
      return el("button", {
        type: "button",
        role: "tab",
        id: `hl-tab-${c.id}`,
        "data-fk": `card:${c.id}`,
        class: `hl-card tone-${n ? c.tone : "calm"}${on ? " on" : ""}`,
        "aria-selected": String(on),
        "aria-controls": "hl-drill",
        tabindex: on ? "0" : "-1",
        title: c.hint,
        onclick: () => set({ check: c.id, type: null }),
        onkeydown: move,
      }, [
        el("b", { text: num(n) }),
        el("span", { class: "hl-card-l", text: c.label }),
        el("span", { class: "hl-card-p", text: `문서의 ${pct(n, rows.length)}` }),
      ]);
    }));
  }

  function matrixBox(rows) {
    const matrix = typeStatusMatrix(rows, DOC_TYPES).filter((m) => m.total || DOC_TYPES.includes(m.type));
    const max = Math.max(0, ...matrix.map((m) => m.total));
    const sum = (k) => matrix.reduce((n, m) => n + m[k], 0);
    const cell = (n, state) => el("td", { class: "num" }, n ? el("a", { href: toTable(state), text: num(n) }) : el("span", { class: "dim", text: "0" }));
    return el("section", { class: "hl-box hl-matrix" }, [
      el("h3", { text: "타입 × 상태" }),
      el("div", { class: "tbl-wrap" }, el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", { scope: "col", text: "타입" }),
          el("th", { scope: "col" }, el("span", { class: "hl-legend" }, [el("i", { class: "lg-act" }), "활성", el("i", { class: "lg-inact" }), "비활성"])),
          el("th", { scope: "col", class: "num", text: "활성" }),
          el("th", { scope: "col", class: "num", text: "비활성" }),
          el("th", { scope: "col", class: "num", text: "합" }),
        ])),
        el("tbody", {}, matrix.map((m) =>
          el("tr", { class: m.total ? "" : "zero" }, [
            el("th", { scope: "row" }, typeTag(m.type)),
            el("td", {}, splitBar(m, max)),
            cell(m.active, { type: [m.type], status: ["active"] }),
            view.scope === "active" ? el("td", { class: "num dim", text: "—" }) : cell(m.inactive, { type: [m.type], status: ["inactive"] }),
            cell(m.total, { type: [m.type] }),
          ]))),
        el("tfoot", {}, el("tr", {}, [
          el("th", { scope: "row", text: "합" }),
          el("td"),
          el("td", { class: "num", text: num(sum("active")) }),
          el("td", { class: "num", text: view.scope === "active" ? "—" : num(sum("inactive")) }),
          el("td", { class: "num", text: num(sum("total")) }),
        ])),
      ])),
    ]);
  }

  function ageBox(rows) {
    const { bins, unknown } = ageHistogram(rows);
    const ages = rows.map((r) => r.ageDays).filter((d) => d != null);
    const facts = ages.length
      ? `가운데 값 ${ageLabel(median(ages))} · 가장 오래된 문서 ${ageLabel(Math.max(...ages))}${unknown ? ` · 시각 없음 ${num(unknown)}` : ""}`
      : "수정 시각을 가진 문서가 없습니다";
    return el("section", { class: "hl-box" }, [
      el("h3", { text: "마지막으로 고친 때" }),
      histogram(bins.map((b, i) => ({ ...b, href: toTable({ age: [AGE_FACET[i]] }) })), "마지막으로 고친 때의 분포", 56),
      el("p", { class: "hl-facts dim", text: facts }),
    ]);
  }

  function sizeBox(rows) {
    const { bins, unknown } = sizeHistogram(rows);
    const sizes = rows.map((r) => r.size).filter((s) => s != null);
    const last = bins.length - 1;
    const facts = sizes.length
      ? `가운데 값 ${num(median(sizes))}자 · 가장 긴 문서 ${num(Math.max(...sizes))}자${unknown ? ` · 크기 없음 ${num(unknown)}` : ""}`
      : "크기 값을 가진 문서가 없습니다";
    return el("section", { class: "hl-box" }, [
      el("h3", {}, ["본문 크기 ", el("span", { class: "dim", text: "글자 수" })]),
      histogram(bins.map((b, i) => ({ ...b, href: toTable({ size: [i === 0 ? "short" : i === last ? "long" : "mid"] }) })), "본문 크기의 분포", 43),
      el("p", { class: "hl-facts dim", text: facts }),
    ]);
  }

  /** 검사마다 줄 오른쪽에 보이는 근거. */
  function detail(id, r) {
    if (id === "broken") {
      const shown = r.broken.slice(0, 2);
      return [
        ...shown.map((b) => el("span", { class: `hl-brk k-${b.kind}`, title: `${BROKEN_LABEL[b.kind]}: ${b.target}` }, [el("i", { text: BROKEN_LABEL[b.kind] }), el("span", { class: "mono", text: b.target })])),
        r.broken.length > shown.length ? el("span", { class: "dim", text: `외 ${r.broken.length - shown.length}`, title: r.broken.slice(2).map((b) => `${BROKEN_LABEL[b.kind]}: ${b.target}`).join("\n") }) : null,
      ];
    }
    if (id === "stale") return el("span", { class: "hl-val", text: `${num(r.ageDays)}일` });
    if (id === "short" || id === "long") return el("span", { class: "hl-val", title: `${num(r.size)}자`, text: `${sizeText(r.size)}자` });
    if (id === "orphans" || id === "untitled" || id === "recent") return r.size == null ? null : el("span", { class: "dim", text: `${sizeText(r.size)}자` });
    return null;
  }
  const item = (id, r) =>
    el("li", { class: "hl-row" }, [
      typeTag(r.doc.type),
      el("span", { class: "hl-name" }, [docLink(r.doc), idNote(r.doc, "hl-id")]),
      el("span", { class: "hl-detail" }, detail(id, r)),
      r.doc.status === "inactive" ? el("span", { class: "mini-off", text: "비활성" }) : el("span"),
      freshBadge(r.doc.updatedAt),
    ]);

  function drill(rows) {
    const c = checkOf(view.check);
    const hit = checkRows(rows, c.id);
    const byType = new Map();
    for (const r of hit) byType.set(r.doc.type, (byType.get(r.doc.type) ?? 0) + 1);
    if (view.type && !byType.has(view.type)) view.type = null;
    const list = view.type ? hit.filter((r) => r.doc.type === view.type) : hit;
    const types = [...DOC_TYPES.filter((t) => byType.has(t)), ...[...byType.keys()].filter((t) => !DOC_TYPES.includes(t)).sort()];
    const shown = list.slice(0, view.shown);
    let body;
    if (!rows.length) body = el("p", { class: "hl-none", text: "문서가 없습니다." });
    else if (!hit.length) body = el("p", { class: "hl-none ok", text: CHECK_VIEW[c.id].none });
    else if (c.id === "dup") {
      const keys = new Set(shown.map((r) => r.key));
      body = el("div", { class: "hl-groups" }, dupGroups(list).filter((g) => g.rows.some((r) => keys.has(r.key))).map((g) =>
        el("section", { class: "hl-group" }, [
          el("h4", {}, [g.title, " ", el("span", { class: "count-pill", text: String(g.rows.length) })]),
          el("ul", { class: "hl-list" }, g.rows.map((r) => item(c.id, r))),
        ])));
    } else body = el("ul", { class: `hl-list c-${c.id}` }, shown.map((r) => item(c.id, r)));
    return el("section", { class: "hl-drill", id: "hl-drill", role: "tabpanel", "aria-labelledby": `hl-tab-${c.id}` }, [
      el("div", { class: "hl-drill-head" }, [
        el("h3", {}, [c.label, " ", el("span", { class: "count-pill", text: num(hit.length) })]),
        el("span", { class: "dim hl-hint", text: c.hint }),
        el("span", { class: "sp" }),
        hit.length ? el("a", { class: "btn ghost sm", href: toTable({ ...CHECK_VIEW[c.id].table, ...(view.type ? { type: [view.type] } : {}) }), text: "표 보기에서 열기" }) : null,
      ]),
      types.length > 1
        ? el("div", { class: "typechips hl-types", role: "group", "aria-label": "타입으로 좁히기" }, [
            el("button", { type: "button", "data-fk": "type:", "aria-pressed": String(!view.type), text: `전체 ${num(hit.length)}`, onclick: () => set({ type: null }) }),
            ...types.map((t) => el("button", { type: "button", "data-fk": `type:${t}`, "aria-pressed": String(view.type === t), text: `${TYPE_LABEL[t] ?? t} ${num(byType.get(t))}`, onclick: () => set({ type: t }) })),
          ])
        : null,
      body,
      list.length > shown.length
        ? el("div", { class: "hl-more" }, el("button", { type: "button", class: "btn ghost", "data-fk": "more", text: `${num(Math.min(PAGE, list.length - shown.length))}개 더 보기 · 남은 문서 ${num(list.length - shown.length)}`, onclick: () => {
            view.shown += PAGE;
            paint();
          } }))
        : null,
    ]);
  }

  function paint() {
    const rows = view.scope === "active" ? all.filter((r) => r.doc.status === "active") : all;
    const active = all.filter((r) => r.doc.status === "active").length;
    const counts = checkCounts(rows);
    const focusFk = document.activeElement?.dataset?.fk;
    page.replaceChildren(
      el("header", { class: "hl-head" }, [
        el("div", {}, [
          el("h2", { class: "hl-title", text: "문서 현황 진단" }),
          el("p", { class: "dim hl-sub", text: `문서 ${num(all.length)} · 활성 ${num(active)} · 비활성 ${num(all.length - active)}` }),
        ]),
        el("span", { class: "sp" }),
        el("div", { class: "seg", role: "group", "aria-label": "세는 범위" }, [["all", "전체"], ["active", "활성만"]].map(([k, text]) =>
          el("button", { type: "button", "data-fk": `scope:${k}`, "aria-pressed": String(view.scope === k), text, onclick: () => set({ scope: k }) }))),
      ]),
      cards(rows, counts),
      el("div", { class: "hl-grid" }, [matrixBox(rows), ageBox(rows), sizeBox(rows)]),
      drill(rows),
    );
    if (focusFk) [...page.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === focusFk)?.focus();
  }
  paint();
}
