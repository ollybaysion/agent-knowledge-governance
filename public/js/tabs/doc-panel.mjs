// The reading view's right panel: small tabs 요약 · 연결 · 이력.
// 요약 — an agent: Score · G A R · 측정 시각 · 절 · 검증 질문; another doc:
// the agents that use it · type facts · 절 · 최근 이력. 연결 — the one-step
// ring (2단 toggle), four lists and 전체 그래프에서 보기. 이력 — the doc's
// commits (GET /api/audit?doc=type/id).
import { api, lastScore } from "../api.mjs";
import { el, icon, svgEl } from "../dom.mjs";
import { docChip, kindTag } from "../md.mjs";
import { scrollToSec } from "../sec.mjs";
import { VERIFY_KIND_LABEL, shortAt, shortRev } from "../shared.mjs";
import { TIER_LABEL, TYPE_LABEL, isAdmin, isMdType, typeColor } from "../state.mjs";

export const BAND_NAMES = ["신뢰 불가", "기본", "문제 이해 및 설명 가능", "쉬운 문제 해결", "탁월"];
export const bandIndex = (score) => Math.min(4, Math.max(0, Math.floor(Number(score) / 20)));

/** The Score dot (+ number) a list row carries; nothing when there is no run. */
export function scoreDot(run, { withNumber = true } = {}) {
  if (!run) return null;
  const b = bandIndex(run.score);
  return el("span", { class: "sdot-w", title: `Score ${run.score} · ${run.band || BAND_NAMES[b]}` }, [
    el("span", { class: `sdot band-${b}`, "aria-hidden": "true" }),
    withNumber ? el("span", { class: "sdot-n", text: String(run.score) }) : null,
  ]);
}

/** 답변 품질 Score: big number · band · five-band bar · scale. */
export function scoreBlock(run) {
  if (!run)
    return el("div", { class: "pscore none" }, [
      el("div", { class: "plabel", text: "답변 품질 Score" }),
      el("p", { class: "dim", text: "기록이 없습니다 — 채점기가 한 번 돌면 여기에 섭니다." }),
    ]);
  const b = bandIndex(run.score);
  const r2 = (x) => (typeof x === "number" ? x.toFixed(2) : "—");
  return el("div", { class: "pscore" }, [
    el("div", { class: "plabel", text: "답변 품질 Score" }),
    el("div", { class: "pscore-top" }, [
      el("span", { class: "pscore-n", text: String(run.score) }),
      el("span", { class: `pscore-band band-t-${b}`, text: run.band || BAND_NAMES[b] }),
    ]),
    el("div", { class: "pbar", role: "img", "aria-label": `0~100 다섯 구간 중 ${BAND_NAMES[b]}, ${run.score}` }, [
      ...[0, 1, 2, 3, 4].map((i) => el("span", { class: `pbar-s band-${i}${i === b ? " on" : ""}` })),
      el("span", { class: "pbar-m", style: { left: `${Math.min(100, Math.max(0, run.score))}%` } }),
    ]),
    el("div", { class: "pbar-scale", "aria-hidden": "true" }, ["0", "20", "40", "60", "80", "100"].map((t) => el("span", { text: t }))),
    el("dl", { class: "pkv" }, [
      el("dt", { text: "결과 G" }), el("dd", { class: "mono", text: r2(run.G) }),
      el("dt", { text: "바탕 A" }), el("dd", { class: "mono", text: r2(run.A) }),
      el("dt", { text: "신뢰성 R" }), el("dd", { class: "mono", text: r2(run.R) }),
      el("dt", { text: "측정 시각" }), el("dd", { class: "mono", text: shortAt(run.at) || "—" }),
    ]),
  ]);
}

// ---------- 연결: 고리 그래프 ----------
const trunc = (s, n = 13) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Neighbours of a doc from the doc rows: out (its links) and in (rows that link to it). */
export function neighbours(docs, type, id) {
  const key = `${type}/${id}`;
  const byKey = new Map(docs.map((d) => [`${d.type}/${d.id}`, d]));
  const out = new Map();
  const add = (k, rel) => {
    if (k === key || !byKey.has(k)) return;
    if (!out.has(k)) out.set(k, { key: k, doc: byKey.get(k), rel });
  };
  for (const l of byKey.get(key)?.links ?? []) add(`${l.type}/${l.id}`, l.rel);
  for (const d of docs) if ((d.links ?? []).some((l) => `${l.type}/${l.id}` === key)) add(`${d.type}/${d.id}`, "in");
  return [...out.values()];
}

function ring(docs, type, id, depth) {
  const W = 256;
  const H = 240;
  const cx = W / 2;
  const cy = H / 2;
  const first = neighbours(docs, type, id);
  const firstKeys = new Set(first.map((n) => n.key));
  const second = [];
  if (depth === 2) {
    const seen = new Set([`${type}/${id}`, ...firstKeys]);
    for (const n of first)
      for (const m of neighbours(docs, n.doc.type, n.doc.id))
        if (!seen.has(m.key)) {
          seen.add(m.key);
          second.push({ ...m, parent: n.key });
        }
  }
  const r1 = depth === 2 ? 56 : 74;
  const r2 = 100;
  const pos = new Map();
  first.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, first.length);
    pos.set(n.key, { x: cx + r1 * Math.cos(a), y: cy + r1 * Math.sin(a) * 0.92, a });
  });
  second.forEach((n, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / Math.max(1, second.length);
    pos.set(n.key, { x: cx + r2 * Math.cos(a), y: cy + r2 * Math.sin(a) * 0.92, a });
  });
  const shape = (d, x, y, big) => {
    const c = typeColor(d.type);
    if (d.type === "domain-skill") return svgEl("circle", { cx: x, cy: y, r: big ? 9 : 4.5, fill: c });
    const s = big ? 14 : 8;
    return svgEl("rect", { x: x - s / 2, y: y - s / 2, width: s, height: s, rx: isMdType(d.type) ? 2.5 : 1, fill: c });
  };
  const edges = [];
  const nodes = [];
  for (const n of first) {
    const p = pos.get(n.key);
    edges.push(svgEl("line", { class: "ring-e", x1: cx, y1: cy, x2: p.x, y2: p.y, "data-key": n.key }));
  }
  for (const n of second) {
    const p = pos.get(n.key);
    const q = pos.get(n.parent);
    edges.push(svgEl("line", { class: "ring-e far", x1: q.x, y1: q.y, x2: p.x, y2: p.y, "data-key": n.key }));
  }
  for (const n of [...first, ...second]) {
    const p = pos.get(n.key);
    const below = Math.sin(p.a) > 0.3;
    const right = Math.cos(p.a) > 0.35;
    const left = Math.cos(p.a) < -0.35;
    nodes.push(
      svgEl("a", { href: `#/doc/${n.doc.type}/${encodeURIComponent(n.doc.id)}`, class: `ring-n${second.includes(n) ? " far" : ""}`, "data-key": n.key }, [
        svgEl("title", { text: `${TYPE_LABEL[n.doc.type] ?? n.doc.type} · ${n.doc.id}` }),
        shape(n.doc, p.x, p.y, false),
        svgEl("text", {
          x: right ? p.x + 7 : left ? p.x - 7 : p.x,
          y: below ? p.y + 14 : right || left ? p.y + 3 : p.y - 8,
          "text-anchor": right ? "start" : left ? "end" : "middle",
          text: trunc(n.doc.title && n.doc.type !== "db-schema" ? n.doc.title : n.doc.id),
        }),
      ]),
    );
  }
  const self = docs.find((d) => d.type === type && d.id === id) ?? { type, id };
  return svgEl("svg", { class: "ring", viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `이 문서 둘레 ${first.length}${depth === 2 ? ` · 2단 ${second.length}` : ""}` }, [
    ...edges,
    svgEl("circle", { cx, cy, r: 13, class: "ring-self-halo" }),
    shape(self, cx, cy, true),
    ...nodes,
  ]);
}

/** Which ## section of a text a `[[ ]]` first appears under. */
function sectionOfWiki(markdown, text) {
  let head = null;
  for (const line of String(markdown ?? "").split("\n")) {
    const h = /^##\s+(.*?)\s*$/.exec(line);
    if (h) head = h[1];
    else if (line.includes(`[[${text}]]`)) return head;
  }
  return null;
}

/**
 * @param {{type: string, id: string, doc: object, data: object, docs: object[],
 *   isAgent: boolean, tab?: string, users?: object[]}} ctx
 * @returns {{node: HTMLElement, setSummary: (s: object) => void, show: (tab: string) => void}}
 */
export function docPanel(ctx) {
  const { type, id, doc, data, docs } = ctx;
  const tabs = [
    ["summary", "요약"],
    ["links", "연결"],
    ["history", "이력"],
  ];
  const panes = {};
  const buttons = {};
  const bar = el("div", { class: "ptabs", role: "tablist", "aria-label": "문서 정보" });
  for (const [k, label] of tabs) {
    buttons[k] = el("button", {
      type: "button",
      class: "ptab",
      role: "tab",
      id: `ptab-${k}`,
      "aria-controls": `ppane-${k}`,
      text: label,
      onclick: () => show(k),
      onkeydown: (e) => {
        const i = tabs.findIndex(([x]) => x === k);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
          show(next);
          buttons[next].focus();
        }
      },
    });
    bar.appendChild(buttons[k]);
    panes[k] = el("div", { class: "ppane panel-scroll", role: "tabpanel", id: `ppane-${k}`, "aria-labelledby": `ptab-${k}`, hidden: true });
  }
  let current = null;
  function show(k) {
    current = k;
    for (const [x] of tabs) {
      const on = x === k;
      buttons[x].setAttribute("aria-selected", String(on));
      buttons[x].tabIndex = on ? 0 : -1;
      buttons[x].classList.toggle("on", on);
      panes[x].hidden = !on;
    }
    if (k === "history") loadHistory();
  }

  // ---- 이력 ----
  let historyRows = null;
  const historyP = api(`/api/audit?doc=${encodeURIComponent(`${type}/${id}`)}`).then((r) => (historyRows = r.ok ? r.data.entries : []));
  const histLine = (e) =>
    el("li", { class: "phist" }, [
      el("div", { class: "phist-top" }, [
        el("span", { class: "mono phist-rev", text: shortRev(e.rev) }),
        el("span", { class: "dim", text: `${shortAt(e.at.slice(0, 16))} · ${e.author}` }),
      ]),
      el("div", { class: "phist-msg", text: e.message }),
    ]);
  async function loadHistory() {
    await historyP;
    panes.history.replaceChildren(
      el("div", { class: "psec" }, [
        el("div", { class: "plabel" }, [`이력 `, el("span", { class: "count-pill", text: String(historyRows.length) })]),
        historyRows.length ? el("ul", { class: "plist" }, historyRows.map(histLine)) : el("p", { class: "dim", text: "기록이 없습니다." }),
      ]),
    );
  }

  // ---- 연결 ----
  let depth = 1;
  const wikis = data.wikilinks || [];
  const fromBody = new Set(wikis.filter((w) => w.found).map((w) => `${w.type}/${w.id}`));
  const roleOf = new Map(docs.filter((d) => d.type === "domain-skill").map((d) => [d.id, d.role ?? "main"]));
  const md = doc.body?.markdown ?? "";
  const row = (l, note) =>
    el("li", { class: "plink", "data-key": `${l.type}/${l.id}` }, [
      docChip({ type: l.type, id: l.id, role: roleOf.get(l.id) }),
      note ? el("span", { class: "plink-note", text: note }) : null,
    ]);
  function paintLinks() {
    const links = data.links || [];
    const back = data.backlinks || [];
    const found = wikis.filter((w) => w.found);
    const broken = wikis.filter((w) => !w.found);
    const group = (label, list, empty) =>
      el("div", { class: "psec" }, [
        el("div", { class: "plabel" }, [`${label} `, el("span", { class: "count-pill", text: String(list.length) })]),
        list.length ? el("ul", { class: "plist" }, list) : el("p", { class: "dim pnone", text: empty }),
      ]);
    const seg = el("div", { class: "seg", role: "group", "aria-label": "깊이" }, [1, 2].map((n) =>
      el("button", { type: "button", "aria-pressed": String(depth === n), text: `${n}단`, onclick: () => { depth = n; paintLinks(); } }),
    ));
    panes.links.replaceChildren(
      el("div", { class: "psec" }, [
        el("div", { class: "plabel prow" }, [el("span", {}, [el("b", { text: "이 문서 둘레 " }), el("span", { class: "dim", text: `${depth}단 고리` })]), seg]),
        el("div", { class: "ring-box" }, ring(docs, type, id, depth)),
      ]),
      group("가리키는", links.map((l) => row(l, `${l.rel === "screen" ? "screen" : "links"}${fromBody.has(`${l.type}/${l.id}`) ? " · 본문" : ""}`)), "없음"),
      group("가리켜지는", back.map((l) => row(l, l.rel === "screen" ? "screen" : "links")), "없음"),
      group("본문 링크", found.map((w) => row(w, sectionOfWiki(md, w.text) ?? "")), "없음"),
      group("끊긴 연결", broken.map((w) =>
        el("li", { class: "plink broken" }, [docChip({ id: w.text, found: false }), el("span", { class: "plink-note", text: sectionOfWiki(md, w.text) ?? "" })])), "없음"),
      el("div", { class: "pfoot-btns" }, [
        el("a", { class: "btn ghost pfull", href: `#/graph/${type}/${encodeURIComponent(id)}` }, [icon("graph", 15), "전체 그래프에서 보기"]),
        isAdmin() && ctx.onEditLinks ? el("button", { type: "button", class: "btn ghost pfull", text: "연결 고치기", onclick: ctx.onEditLinks }) : null,
      ]),
    );
  }

  // ---- 요약 ----
  function setSummary({ sections = [], info = null }) {
    const secList = el("div", { class: "psec" }, [
      el("div", { class: "plabel" }, [`절 `, el("span", { class: "count-pill", text: String(sections.length) })]),
      el("ul", { class: "plist psecs" }, sections.map((s) =>
        el("li", {}, el("button", { type: "button", class: "psec-btn", "data-sec": s.key, onclick: () => scrollToSec(s.key) }, [
          el("span", { text: s.title }),
          s.editing ? el("span", { class: "chip editing-chip", text: "편집 중" }) : null,
        ])),
      )),
    ]);
    const parts = [];
    if (ctx.isAgent) {
      parts.push(el("div", { class: "psec" }, scoreBlock(info?.run ?? null)), secList);
      const qs = info?.questions ?? [];
      parts.push(
        el("div", { class: "psec" }, [
          el("div", { class: "plabel" }, [`검증 질문 `, el("span", { class: "count-pill", text: String(qs.length) })]),
          qs.length
            ? el("ul", { class: "plist" }, qs.map((q) => {
                const m = info.last.of(q).m;
                return el("li", { class: "pq" }, [
                  el("span", { class: `pq-v ${m ? (m.machine.ok ? "ok" : "no") : "none"}`, text: m ? (m.machine.ok ? "✓" : "✗") : "–", "aria-label": m ? (m.machine.ok ? "맞음" : "틀림") : "판정 없음" }),
                  el("button", { type: "button", class: "pq-t", text: q.text, title: q.text, onclick: () => scrollToSec("답변 품질 검증 Set") }),
                  el("span", { class: "pq-k", text: VERIFY_KIND_LABEL[q.kind] }),
                ]);
              }))
            : el("p", { class: "dim pnone", text: "없음" }),
        ]),
      );
    } else {
      const users = (data.backlinks || []).filter((l) => l.type === "domain-skill");
      const usersBox = el("ul", { class: "plist" });
      for (const u of users) {
        const li = el("li", { class: "puser", "data-key": `domain-skill/${u.id}` }, [
          el("div", { class: "puser-top" }, [docChip({ type: "domain-skill", id: u.id, role: roleOf.get(u.id) }), el("span", { class: "puser-score" })]),
          el("div", { class: "dim puser-how", text: u.rel === "screen" ? "screen" : "links" }),
        ]);
        usersBox.appendChild(li);
        if ((roleOf.get(u.id) ?? "main") === "main")
          lastScore(u.id).then((s) => li.querySelector(".puser-score").replaceChildren(...[scoreDot(s.run)].filter(Boolean)));
      }
      parts.push(
        el("div", { class: "psec" }, [
          el("div", { class: "plabel" }, [`이 ${type === "db-schema" ? "표를" : "문서를"} 쓰는 에이전트 `, el("span", { class: "count-pill", text: String(users.length) })]),
          users.length ? usersBox : el("p", { class: "dim pnone", text: "아직 이 문서를 가리키는 에이전트가 없습니다." }),
        ]),
        typeFacts(type, doc, data.tiers),
        secList,
        recentHistory(),
      );
    }
    panes.summary.replaceChildren(...parts.filter(Boolean));
  }
  function recentHistory() {
    const box = el("div", { class: "psec" }, [el("div", { class: "plabel", text: "최근 이력" }), el("p", { class: "dim", text: "불러오는 중…" })]);
    historyP.then(() => {
      box.replaceChildren(
        el("div", { class: "plabel", text: "최근 이력" }),
        historyRows.length ? el("ul", { class: "plist" }, historyRows.slice(0, 3).map(histLine)) : el("p", { class: "dim pnone", text: "기록이 없습니다." }),
        ...(historyRows.length ? [el("button", { type: "button", class: "linkbtn", text: "이력 전부 보기", onclick: () => show("history") })] : []),
      );
    });
    return box;
  }

  paintLinks();
  setSummary({ sections: [] });
  show(ctx.tab ?? "summary");
  const node = el("aside", { class: "panel right doc-panel", "aria-label": "문서 정보" }, [bar, ...Object.values(panes)]);
  return { node, setSummary, show, get current() { return current; } };
}

/** The type's own facts: a table's columns · tier · key · collected; an md's length · origin. */
function typeFacts(type, doc, tiers) {
  const b = doc.body ?? {};
  const rows = [];
  const tierOf = (tiers) => (tiers?.inferred ? "inferred" : tiers?.confirmed ? "confirmed" : tiers?.scaffold ? "scaffold" : null);
  if (type === "db-schema") {
    const cols = b.catalog?.columns ?? [];
    rows.push(["열 수", String(cols.length)]);
    rows.push(["키", (b.catalog?.primaryKey ?? []).join(" · ") || "—"]);
    rows.push(["수집", b.catalog?.fetchedAt ? b.catalog.fetchedAt.slice(0, 10) : "—"]);
  } else if (type === "msg-format") {
    rows.push(["필드 수", String((b.fields ?? []).length)]);
    rows.push(["방향", b.direction === "host->equipment" ? "Host → Equipment" : "Equipment → Host"]);
  } else if (type === "manual") {
    rows.push(["단계", String((b.steps ?? []).length)]);
    rows.push(["캡처", String((b.steps ?? []).filter((s) => s.asset).length)]);
  } else if (type === "screen-map") {
    rows.push(["프로그램", b.program || "—"]);
    rows.push(["메뉴", (b.menuPath ?? []).join(" › ") || "—"]);
  } else if (type === "fab-line") {
    rows.push(["코드", b.code || "—"]);
  } else if (isMdType(type) || type === "domain") {
    rows.push(["글자 수", String((b.markdown ?? "").length)]);
  }
  if (doc.origin?.url) rows.push(["원본", el("a", { href: doc.origin.url, target: "_blank", rel: "noopener noreferrer", text: doc.origin.title || doc.origin.url })]);
  const tier = tierOf(tiers);
  if (tier) rows.splice(1, 0, ["티어", el("span", { class: `b b-${{ scaffold: "sc", inferred: "inf", confirmed: "conf" }[tier]}`, text: TIER_LABEL[tier] })]);
  if (!rows.length) return null;
  return el("div", { class: "psec" }, [
    el("div", { class: "plabel", text: kindTag(type) === "표" ? "표" : TYPE_LABEL[type] ?? type }),
    el("dl", { class: "pkv" }, rows.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", {}, typeof v === "string" ? el("span", { text: v }) : v)])),
  ]);
}
