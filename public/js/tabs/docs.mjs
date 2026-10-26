// 문서 탭. Nothing picked yet: the whole body is the column browser
// (즐겨찾기 · 최근 · 타입 → 문서 → 미리보기, ← → ↑ ↓ ↩). A document open: the
// left 288 is the path column (타입 › 문서 · ‹ 탐색으로 · same-type list),
// which folds to a 48 band from the handle on its right edge.
import { allDocs, api } from "../api.mjs";
import { $, el, icon } from "../dom.mjs";
import { deriveDraftId, draftsOfType, newDocButton } from "../drafts.mjs";
import { docChip, kindTag, mdNodes, wikiResolver } from "../md.mjs";
import { SUB_LABEL, docRows, inDocsTab, move, rowTier, typeRows } from "/lib/miller.mjs";
import { liveShelf } from "/lib/shelf.mjs";
import { isFav, shelf, toggleFav } from "../shelf.mjs";
import { coverageBar, kindBadge, shortRev, tierBadge } from "../shared.mjs";
import { DEFAULT_FILTER, TABLE_FILTERS, kindOf, readFilter, tableGroups } from "/lib/table-class.mjs";
import { screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { TIER_LABEL, TYPES, TYPE_LABEL, typeColor } from "../state.mjs";

const enc = encodeURIComponent;
export const typeLabel = (type) => (type === "domain-skill" ? SUB_LABEL : TYPE_LABEL[type] ?? type);
export const shortDay = (at) => (at ? String(at).slice(5, 10) : "");
export function whenLabel(at) {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return `오늘 ${hm}`;
  if (diff === 1) return `어제 ${hm}`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const rowName = (d) => (d.type === "db-schema" || d.type === "msg-format" ? d.id : d.title && d.title !== d.id ? d.title : d.id);
// The docs tab holds a domain-skill's sub drafts only; its mains are the 에이전트 tab's.
const draftRole = (type) => (type === "domain-skill" ? "sub" : null);
const tierChip = (d) => {
  const t = rowTier(d.tiers);
  return t ? tierBadge(t) : null;
};

/** A document row of column 2 and the path column. */
function docRow(d, { on, id }) {
  return el("li", { class: `mrow${on ? " on" : ""}`, role: "option", id, "aria-selected": String(!!on), "data-key": `${d.type}/${d.id}` }, [
    el("div", { class: "mrow-top" }, [
      el("span", { class: `mrow-name${d.type === "db-schema" || d.type === "msg-format" ? " mono" : ""}`, text: rowName(d) }),
      isFav(d) ? el("span", { class: "fav-mark", "aria-label": "즐겨찾기" }, icon("star", 12)) : null,
      d.status === "inactive" ? el("span", { class: "mini-off", text: "비활성" }) : null,
      el("span", { class: "mrow-chev" }, icon("right", 14)),
    ]),
    el("div", { class: "mrow-sub" }, [
      tierChip(d),
      d.type === "db-schema" ? kindBadge(kindOf(d)) : null,
      d.type === "db-schema" ? coverageBar(d.coverage) : null,
      d.updatedAt ? el("span", { class: "dim", text: `수정 ${shortDay(d.updatedAt)}` }) : null,
    ]),
  ]);
}

// The db-schema list's filter (중요도 · 성격), kept for this tab's session.
const FILTER_KEY = "akg_table_filter";
function savedFilter() {
  try {
    return readFilter(sessionStorage.getItem(FILTER_KEY));
  } catch {
    return { ...DEFAULT_FILTER };
  }
}
function saveFilter(f) {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch {
    /* storage off: the filter lasts until the next screen */
  }
}
/** The two chip rows above the db-schema list. */
function filterChips(filter, onPick) {
  const row = (axis, label) =>
    el("div", { class: "tfilter-row", role: "group", "aria-label": label }, [
      el("span", { class: "dim tfilter-k", text: label }),
      ...TABLE_FILTERS[axis].map(([k, text]) =>
        el("button", { type: "button", class: filter[axis] === k ? "on" : "", "aria-pressed": String(filter[axis] === k), onclick: () => onPick({ ...filter, [axis]: k }) }, text),
      ),
    ]);
  return el("div", { class: "typechips tfilter" }, [row("major", "중요도"), row("kind", "성격")]);
}

/** This browser's unsaved drafts of a type, as links ("(빈 문서)" until named). */
export function draftLinks(type, { role = null, current = null } = {}) {
  const drafts = draftsOfType(type).filter((d) => !role || (d.body.role ?? "main") === role);
  if (!drafts.length) return null;
  let unnamed = 0;
  return el("ul", { class: "mlist drafts", "aria-label": "드래프트" }, drafts.map((d) => {
    const id = deriveDraftId(type, d.body);
    const label = id || (++unnamed === 1 ? "(빈 문서)" : `(빈 문서${unnamed})`);
    return el("li", {}, el("a", { class: `mrow draft${d.localId === current ? " on" : ""}`, href: `#/draft/${type}/${d.localId}` }, [
      el("span", { class: `mrow-name${id ? " mono" : " dim"}`, text: label }),
      el("span", { class: "df-badge", text: "드래프트" }),
    ]));
  }));
}

// ---------- 경로 열 ----------
const FOLD_KEY = "akg_path_folded";
const folded = () => {
  try {
    return localStorage.getItem(FOLD_KEY) === "1";
  } catch {
    return false;
  }
};
function setFolded(v) {
  try {
    localStorage.setItem(FOLD_KEY, v ? "1" : "0");
  } catch {
    /* storage off: the fold lasts until the next screen */
  }
}

/** The path column of an open document: {node, collapsed, bind(layout)}. */
export function pathPanel(type, id, docs, draftId = null) {
  const rows = docRows(docs, type);
  const color = typeColor(type);
  const node = el("aside", { class: "panel left path-panel", "aria-label": "같은 타입 문서" });
  let layout = null;
  const handle = el("button", { type: "button", class: "fold-handle", onclick: () => toggle() });
  function toggle() {
    const now = !node.classList.contains("folded");
    setFolded(now);
    paint(now);
    layout?.classList.toggle("collapsed", now);
  }
  function paint(isFolded) {
    node.classList.toggle("folded", isFolded);
    handle.setAttribute("aria-label", isFolded ? "경로 열 펼치기" : "경로 열 접기");
    handle.setAttribute("aria-expanded", String(!isFolded));
    handle.replaceChildren(icon(isFolded ? "right" : "left", 14));
    if (isFolded) {
      node.replaceChildren(
        el("div", { class: "band" }, [
          el("span", { class: "tdot band-dot", style: { "--c": color }, title: typeLabel(type) }),
          el("a", { class: "icon-btn", href: `#/docs/${type}`, "aria-label": "탐색으로", title: "탐색으로" }, icon("columns", 17)),
          el("button", { type: "button", class: "icon-btn", "aria-label": "찾기 (⌘K)", title: "찾기 (⌘K)", onclick: () => document.dispatchEvent(new CustomEvent("akg:cmdk")) }, icon("search", 17)),
        ]),
        handle,
      );
      return;
    }
    const list = el("ul", { class: "mlist", role: "listbox", "aria-label": `${typeLabel(type)} 문서` }, rows.map((d) => {
      const li = docRow(d, { on: d.id === id });
      li.tabIndex = 0;
      li.addEventListener("click", () => (location.hash = `#/doc/${d.type}/${enc(d.id)}`));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") location.hash = `#/doc/${d.type}/${enc(d.id)}`;
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          (e.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling)?.focus();
        }
      });
      return li;
    }));
    node.replaceChildren(
      el("div", { class: "path-head" }, [
        el("div", { class: "path-crumb" }, [
          el("span", { class: "tdot", style: { "--c": color }, "aria-hidden": "true" }),
          el("a", { href: `#/docs/${type}`, text: typeLabel(type) }),
          icon("right", 12),
          el("b", { class: "mono", text: id ?? "새 문서" }),
        ]),
        el("a", { class: "btn ghost sm back-browse", href: `#/docs/${type}` }, [icon("left", 13), "탐색으로"]),
      ]),
      el("div", { class: "plabel path-list-h" }, [
        el("span", {}, [el("span", { class: "tdot", style: { "--c": color } }), ` ${typeLabel(type)} `, el("span", { class: "count-pill", text: String(rows.length) })]),
        el("span", { class: "dim", text: "최근 수정 순" }),
      ]),
      el("div", { class: "panel-scroll" }, [draftLinks(type, { role: draftRole(type), current: draftId }), list, el("p", { class: "dim path-hint", text: "같은 타입 문서 — ↑ ↓ 로 옮기고 ↩ 로 엽니다." })]),
      el("div", { class: "panel-foot" }, newDocButton()),
      handle,
    );
  }
  const isFolded = folded();
  paint(isFolded);
  return { node, collapsed: isFolded, bind: (l) => (layout = l) };
}

// ---------- 탐색: 밀러 열 ----------
export async function renderBrowse(pickType = null) {
  setActiveTab("docs");
  setCrumbs([{ label: "문서" }]);
  const docs = await allDocs();
  const types = typeRows(TYPES, docs);
  const sh = liveShelf(shelf(), docs);
  const docRowsIn = docs.filter(inDocsTab);
  // Column 1: 즐겨찾기 · 최근 (documents) then the types.
  const col1 = [
    ...sh.fav.map((x) => ({ kind: "doc", group: "fav", doc: x.doc })),
    ...sh.recent.slice(0, 5).map((x) => ({ kind: "doc", group: "recent", doc: x.doc, at: x.at })),
    ...types.map((t) => ({ kind: "type", type: t })),
  ];
  const firstType = col1.findIndex((r) => r.kind === "type" && (pickType ? r.type.id === pickType : r.type.count > 0));
  let state = { col: pickType ? 2 : 1, i1: Math.max(0, firstType), i2: 0 };
  // db-schema: 주요 then 기타, through the filter; the arrow keys walk the same order.
  let tableFilter = savedFilter();
  const groupsOf = (type, filter = tableFilter) => (type === "db-schema" ? tableGroups(docRows(docs, type), filter) : null);
  const listOf = (i1) => {
    const r = col1[i1];
    if (r?.kind !== "type") return [];
    return groupsOf(r.type.id)?.flatMap((g) => g.rows) ?? docRows(docs, r.type.id);
  };
  if (state.col === 2 && !listOf(state.i1).length) state.col = 1;
  // A doc row in column 1 shows its own type's list in column 2, itself picked.
  let picked = null;

  const c1 = el("div", { class: "mcol mcol1", role: "listbox", tabindex: "0", "aria-label": "즐겨찾기 · 최근 · 타입" });
  const c2 = el("div", { class: "mcol mcol2", role: "listbox", tabindex: "0", "aria-label": "문서" });
  const c3 = el("div", { class: "mcol mcol3", "aria-live": "polite" });
  const where = el("span", { class: "mtop-path" });
  const root = el("div", { class: "miller" }, [
    el("div", { class: "mtop" }, [
      el("b", { text: "문서" }),
      el("span", { class: "dim", text: `타입 ${types.length} · 문서 ${docRowsIn.length}` }),
      el("span", { class: "mtop-sep", "aria-hidden": "true" }),
      where,
      el("span", { class: "sp" }),
      newDocButton({ compact: true }),
    ]),
    el("div", { class: "mcols" }, [c1, c2, c3]),
    el("div", { class: "mfoot" }, [
      el("span", {}, [el("kbd", { text: "←" }), el("kbd", { text: "→" }), " 열 옮기기"]),
      el("span", {}, [el("kbd", { text: "↑" }), el("kbd", { text: "↓" }), " 고르기"]),
      el("span", {}, [el("kbd", { text: "↩" }), " 열기"]),
      el("span", {}, [el("kbd", { text: "⌘K" }), " 찾기"]),
      el("span", { class: "sp" }),
      el("span", { class: "dim" }, ["에이전트 문서(domain-skill main)는 ", el("a", { href: "#/agents", text: "에이전트" }), " 탭에 있습니다"]),
    ]),
  ]);
  screen().appendChild(el("main", { class: "main browse", "aria-label": "문서 탐색" }, root));

  const sizes = { n1: col1.length, n2: (i) => listOf(i).length, isDocRow: (i) => col1[i]?.kind === "doc" };
  function currentDoc() {
    if (state.col === 1 && col1[state.i1]?.kind === "doc") return col1[state.i1].doc;
    return listOf(state.i1)[state.i2] ?? null;
  }
  function open(d) {
    if (!d) return;
    location.hash = `#/doc/${d.type}/${enc(d.id)}`;
  }
  function paint1() {
    const rows = [];
    const head = (label, ic, extra) => el("li", { class: "mgroup", role: "presentation" }, [icon(ic, 13), ` ${label}`, extra ? el("span", { class: "dim", text: extra }) : null]);
    let lastGroup = null;
    col1.forEach((r, i) => {
      const group = r.kind === "doc" ? r.group : "type";
      if (group !== lastGroup) {
        rows.push(group === "fav" ? head("즐겨찾기", "star") : group === "recent" ? head("최근", "clock") : head(`타입 ${types.length}`, "file", "타입 관리 순서"));
        lastGroup = group;
      }
      const on = state.i1 === i;
      const optId = `m1-${i}`;
      if (r.kind === "doc") {
        const d = r.doc;
        rows.push(el("li", { class: `mrow1 doc${on ? " on" : ""}${on && state.col === 1 ? " cur" : ""}`, role: "option", id: optId, "aria-selected": String(on), onclick: () => { state = { col: 1, i1: i, i2: 0 }; paint(); }, ondblclick: () => open(d) }, [
          el("span", { class: "kind-badge", style: { "--c": typeColor(d.type) }, text: kindTag(d.type, d.role) }),
          el("span", { class: "mrow-name", text: rowName(d) }),
          el("span", { class: "dim mrow-meta", text: r.group === "recent" ? whenLabel(r.at) : d.type === "domain-skill" && d.role === "main" ? "에이전트" : typeLabel(d.type) }),
        ]));
      } else {
        const t = r.type;
        rows.push(el("li", { class: `mrow1 type${on ? " on" : ""}${on && state.col === 1 ? " cur" : ""}${t.archived ? " off" : ""}`, role: "option", id: optId, "aria-selected": String(on), onclick: () => { state = { col: 1, i1: i, i2: 0 }; paint(); } }, [
          el("span", { class: "tdot", style: { "--c": t.color }, "aria-hidden": "true" }),
          el("span", { class: "mrow-name", text: t.label }),
          el("span", { class: "dim mrow-n", text: String(t.count) }),
          t.tag ? el("span", { class: "tag", text: t.tag }) : null,
          t.archived ? el("span", { class: "tag", text: "닫힘" }) : null,
          el("span", { class: "mrow-chev" }, icon("right", 14)),
        ]));
      }
    });
    c1.replaceChildren(el("ul", { class: "mlist" }, rows));
    c1.setAttribute("aria-activedescendant", `m1-${state.i1}`);
  }
  function paint2() {
    const r = col1[state.i1];
    let list = listOf(state.i1);
    let type = r?.kind === "type" ? r.type.id : null;
    picked = null;
    // A 즐겨찾기 · 최근 row shows its type's whole list, so it is always in it.
    let groups = type ? groupsOf(type) : null;
    if (r?.kind === "doc") {
      type = r.doc.type;
      groups = groupsOf(type, DEFAULT_FILTER);
      list = groups?.flatMap((g) => g.rows) ?? docRows(docs, type);
      picked = r.doc;
    }
    if (!type) {
      c2.replaceChildren();
      return;
    }
    const t = types.find((x) => x.id === type);
    const row = (d, i) => {
      const on = picked ? picked.id === d.id : state.i2 === i;
      const li = docRow(d, { on, id: `m2-${i}` });
      if (on && state.col === 2) li.classList.add("cur");
      li.addEventListener("click", () => {
        if (r?.kind === "doc") return open(d);
        state = { col: 2, i1: state.i1, i2: i };
        paint();
      });
      li.addEventListener("dblclick", () => open(d));
      return li;
    };
    const items = [];
    if (groups) {
      let i = 0;
      for (const g of groups) {
        items.push(el("li", { class: "mgroup", role: "presentation" }, [g.label, el("span", { class: "count-pill", text: String(g.rows.length) })]));
        for (const d of g.rows) items.push(row(d, i++));
      }
    } else list.forEach((d, i) => items.push(row(d, i)));
    const filtering = type === "db-schema" && r?.kind === "type";
    c2.replaceChildren(
      el("div", { class: "mcol-h" }, [
        el("span", { class: "tdot", style: { "--c": typeColor(type) }, "aria-hidden": "true" }),
        el("b", { text: t?.label ?? typeLabel(type) }),
        el("span", { class: "dim", text: String(list.length) }),
        el("span", { class: "sp" }),
        el("span", { class: "dim", text: groups ? "주요 → 기타 · 최근 수정 순" : "최근 수정 순" }),
      ]),
      filtering
        ? filterChips(tableFilter, (f) => {
            tableFilter = f;
            saveFilter(f);
            state = { ...state, i2: 0 };
            paint();
          })
        : document.createTextNode(""),
      draftLinks(type, { role: draftRole(type) }) ?? document.createTextNode(""),
      list.length
        ? el("ul", { class: "mlist" }, items)
        : el("p", { class: "dim pnone", text: filtering && docRows(docs, type).length ? "거르기에 맞는 표가 없습니다." : "문서가 없습니다." }),
    );
    c2.setAttribute("aria-activedescendant", `m2-${state.i2}`);
  }
  let previewTicket = 0;
  async function paint3() {
    const d = currentDoc();
    const ticket = ++previewTicket;
    where.replaceChildren(
      ...(d
        ? [el("span", { class: "tdot", style: { "--c": typeColor(d.type) } }), ` ${typeLabel(d.type)} `, icon("right", 12), el("b", { class: "mono", text: d.id })]
        : col1[state.i1]?.kind === "type"
          ? [el("span", { class: "tdot", style: { "--c": col1[state.i1].type.color } }), ` ${col1[state.i1].type.label}`]
          : []),
    );
    if (!d) {
      c3.replaceChildren(el("p", { class: "dim mpreview-empty", text: "문서를 고르면 여기에 미리보기가 섭니다." }));
      return;
    }
    c3.replaceChildren(el("p", { class: "dim mpreview-empty", text: "불러오는 중…" }));
    const res = await api(`/api/docs/${d.type}/${enc(d.id)}`);
    if (ticket !== previewTicket) return;
    if (!res.ok) {
      c3.replaceChildren(el("p", { class: "error", text: `미리보기를 불러오지 못했습니다 (${res.status})` }));
      return;
    }
    c3.replaceChildren(preview(d, res.data, docs, () => open(d), paint));
  }
  function paint() {
    paint1();
    paint2();
    paint3();
  }
  root.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) return;
    if (e.target.closest("button, a, input")) return;
    e.preventDefault();
    const r = move(state, e.key, sizes);
    state = r.state;
    if (r.action === "open") return open(currentDoc());
    if (r.action === "pick") return open(col1[state.i1].doc);
    paint();
    (state.col === 1 ? c1 : c2).focus();
  });
  c2.addEventListener("focus", () => {
    if (state.col !== 2 && listOf(state.i1).length) {
      state.col = 2;
      paint();
    }
  });
  c1.addEventListener("focus", () => {
    if (state.col !== 1) {
      state.col = 1;
      paint();
    }
  });
  paint();
  (state.col === 2 ? c2 : c1).focus({ preventScroll: true });
}

function preview(d, data, docs, open, repaint) {
  const doc = data.json;
  const isTable = d.type === "db-schema";
  const wiki = wikiResolver(data.wikilinks, docs);
  const roleOf = new Map(docs.filter((x) => x.type === "domain-skill").map((x) => [x.id, x.role ?? "main"]));
  const users = (data.backlinks || []).filter((l) => l.type === "domain-skill");
  const found = (data.wikilinks || []).filter((w) => w.found);
  const broken = (data.wikilinks || []).filter((w) => !w.found);
  const md = doc.body?.markdown;
  let firstTitle = null;
  let firstBody = null;
  if (typeof md === "string") {
    const m = /^##\s+(.+?)\s*$/m.exec(md);
    if (m) {
      firstTitle = m[1];
      const rest = md.slice(m.index + m[0].length);
      const next = rest.search(/^##\s/m);
      firstBody = (next < 0 ? rest : rest.slice(0, next)).trim();
    } else firstBody = md.replace(/^#\s+.*$/m, "").trim();
  } else if (doc.body?.purpose) {
    firstTitle = "설명";
    firstBody = doc.body.purpose.text ?? "";
  } else if (Array.isArray(doc.body?.steps)) {
    firstTitle = "단계";
    firstBody = doc.body.steps.map((s, i) => `${i + 1}. ${s.text ?? ""}`).join("\n");
  } else if (Array.isArray(doc.body?.hints)) {
    firstTitle = "보이는 모습";
    firstBody = doc.body.hints.map((h) => `- ${h}`).join("\n");
  }
  const secNames = typeof md === "string" ? [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]) : isTable ? ["설명", "열", ...(doc.body.queries?.length ? ["쓰는 법"] : [])] : d.type === "msg-format" ? ["설명", "필드"] : firstTitle ? [firstTitle] : [];
  const favBtn = el("button", { type: "button", class: "btn ghost sm", "aria-pressed": String(isFav(d)) }, [icon("star", 13), "즐겨찾기"]);
  favBtn.addEventListener("click", () => {
    const now = toggleFav({ type: d.type, id: d.id, title: d.title });
    favBtn.setAttribute("aria-pressed", String(now));
    repaint();
  });
  const tier = rowTier(d.tiers);
  const linkRow = (label, list, empty) =>
    el("div", { class: "pv-link" }, [el("span", { class: "dim pv-k", text: `${label} ${list.length}` }), el("span", { class: "pv-v" }, list.length ? list : [el("span", { class: "dim", text: empty })])]);
  return el("div", { class: "mpreview" }, [
    el("div", { class: "pv-top" }, [
      el("span", { class: "pv-label", text: "미리보기" }),
      el("span", { class: "dim", text: `${typeLabel(d.type)} › ${d.id}` }),
      el("span", { class: "sp" }),
      favBtn,
      el("button", { type: "button", class: "btn primary sm", text: "열기", onclick: open }),
    ]),
    el("p", { class: "doc-eyebrow" }, [el("span", { class: "tdot", style: { "--c": typeColor(d.type) } }), ` ${d.type} · ${typeLabel(d.type)}`]),
    el("h2", { class: `pv-title${isTable ? " mono" : ""}`, text: rowName(d) }),
    doc.body?.purpose?.text && firstTitle !== "설명" ? el("p", { class: "doc-sub", text: doc.body.purpose.text }) : null,
    el("div", { class: "doc-chips" }, [
      el("span", { class: `chip st-${doc.status}`, text: (doc.status || "").toUpperCase() }),
      tier ? el("span", { class: `chip tierchip t-${tier}`, text: `티어 ${TIER_LABEL[tier]}` }) : null,
      el("span", { class: "chip rev", text: `rev ${shortRev(data.rev)}` }),
      d.updatedAt ? el("span", { class: "dim", text: `수정 ${shortDay(d.updatedAt)}` }) : null,
    ]),
    firstTitle ? el("h3", { class: "pv-sec", text: firstTitle }) : null,
    firstBody ? el("div", { class: "pv-body" }, mdNodes(firstBody.split("\n").slice(0, 8).join("\n"), { wiki })) : null,
    el("div", { class: "pv-links" }, [
      el("div", { class: "pv-links-h", text: "연결" }),
      linkRow("쓰는 에이전트", users.map((u) => docChip({ type: "domain-skill", id: u.id, role: roleOf.get(u.id) })), "없음"),
      linkRow("본문 링크", found.map((w) => docChip({ type: w.type, id: w.id, role: roleOf.get(w.id) })), "없음"),
      linkRow("끊긴 연결", broken.map((w) => docChip({ id: w.text, found: false })), "없음"),
    ]),
    el("div", { class: "pv-foot" }, [
      el("span", { class: "dim", text: `절 ${secNames.length}${secNames.length ? ` — ${secNames.join(" · ")}` : ""}` }),
      el("span", { class: "sp" }),
      el("span", { class: "dim" }, ["[열기] · 더블클릭 · ", el("kbd", { text: "↩" }), " 로 읽기 화면"]),
    ]),
  ]);
}

