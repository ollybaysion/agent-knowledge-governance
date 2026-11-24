// 표 보기 (#/table): 문서 전부를 한 표로. 왼쪽 패싯(타입 · 상태 · 수정 · 연결 ·
// 크기 · 제목)으로 거르고 열 머리로 정렬한다. 보기 상태는 주소 해시에 담겨서
// 주소를 건네면 같은 보기가 열린다. 개요 탭의 문서 표도 같은 표(docTable)를 쓴다.
import { everyDoc } from "../api.mjs";
import { docLink, freshBadge, idNote, num, sizeText, typeTag, viewSwitch } from "../doc-bits.mjs";
import { el, icon } from "../dom.mjs";
import { STATUS_LABEL, statusBadge, tierMeter } from "../shared.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPE_LABEL, mdTypeIds, typeColor } from "../state.mjs";
import { FACETS, activeCount, emptyState, facetCounts, filterRows, parseState, sortRows, tableHash, toggleFacet, toggleSort } from "/lib/doc-table.mjs";
import { BROKEN_LABEL, docFacts } from "/lib/health.mjs";

// 한 번에 그리는 줄 수. 다음 줄들은 마지막 줄이 보일 때 더 그린다.
const PAGE = 200;

const COLUMNS = [
  { id: "title", label: "문서" },
  { id: "type", label: "타입" },
  { id: null, label: "검토 상태" },
  { id: "status", label: "상태" },
  { id: "updated", label: "수정" },
  { id: "size", label: "크기", num: true, title: "본문 글자 수" },
  { id: "links", label: "연결", num: true, title: "가리켜지는 수 ← · → 가리키는 수" },
];

const brokenTitle = (row) => row.broken.map((b) => `${BROKEN_LABEL[b.kind]}: ${b.target}`).join("\n");

function rowOf(row) {
  const d = row.doc;
  const open = (e) => {
    if (e.target.closest("a, button")) return;
    location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`;
  };
  return el("tr", { class: "nav-doc", onclick: open }, [
    el("td", { class: "dt-doc" }, el("span", { class: "dt-name" }, [docLink(d), idNote(d, "dt-id")])),
    el("td", {}, typeTag(d.type)),
    // 슬롯이 없는 문서(md 타입)는 검토할 티어가 없다.
    el("td", { class: "dt-tier" }, Object.values(d.tiers ?? {}).some(Boolean) ? tierMeter(d.tiers) : el("span", { class: "dim", title: "티어를 매기는 슬롯이 없는 문서입니다", text: "—" })),
    el("td", {}, statusBadge(d.status)),
    el("td", {}, freshBadge(d.updatedAt)),
    el("td", { class: "num", text: sizeText(row.size), title: row.size == null ? "크기가 없습니다" : `${num(row.size)}자` }),
    el("td", { class: "num dt-links" }, [
      el("span", { class: row.in + row.out ? "" : "dim", title: `가리켜짐 ${row.in} · 가리킴 ${row.out}`, text: `← ${row.in} · → ${row.out}` }),
      row.broken.length ? el("span", { class: "dt-broken", title: brokenTitle(row), text: `끊김 ${row.broken.length}` }) : null,
    ]),
  ]);
}

/**
 * 정렬되는 문서 표. rows = 이미 거르고 정렬한 줄, state = {sort, dir},
 * onSort(열 id) = 열 머리를 눌렀을 때. → 표를 든 노드.
 */
export function docTable({ rows, state, onSort, empty }) {
  if (!rows.length) return el("div", { class: "dt-empty" }, empty ?? el("p", { class: "loading", text: "문서가 없습니다." }));
  const head = el("tr", {}, COLUMNS.map((c) => {
    if (!c.id) return el("th", { scope: "col", class: "dt-tier", text: c.label });
    const on = state.sort === c.id;
    return el("th", { scope: "col", class: c.num ? "num" : "", "aria-sort": on ? (state.dir === "asc" ? "ascending" : "descending") : "none" },
      el("button", { type: "button", class: `th-sort${on ? " on" : ""}`, "data-fk": `sort:${c.id}`, title: c.title ?? null, onclick: () => onSort(c.id) }, [
        c.label,
        on ? icon(state.dir === "asc" ? "up" : "down", 12) : null,
      ]));
  }));
  let drawn = Math.min(PAGE, rows.length);
  const tbody = el("tbody", {}, rows.slice(0, drawn).map(rowOf));
  const table = el("table", { class: "dt" }, [el("thead", {}, head), tbody]);
  if (drawn < rows.length) {
    if (typeof IntersectionObserver === "undefined") tbody.append(...rows.slice(drawn).map(rowOf));
    else {
      const watch = el("tr", { "aria-hidden": "true" });
      tbody.appendChild(watch);
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!watch.isConnected) return observer.disconnect();
        watch.before(...rows.slice(drawn, drawn + PAGE).map(rowOf));
        drawn = Math.min(drawn + PAGE, rows.length);
        observer.unobserve(watch);
        if (drawn < rows.length) observer.observe(watch);
        else {
          watch.remove();
          observer.disconnect();
        }
      }, { rootMargin: "0px 0px 800px 0px" });
      observer.observe(watch);
    }
  }
  return el("div", { class: "dt-wrap" }, table);
}

/** 패싯 값의 화면 글: 타입은 타입 이름, 상태는 상태 이름, 그 밖은 패싯에 적힌 글. */
function valueLabel(facet, value) {
  if (facet.id === "type") return TYPE_LABEL[value] ?? value;
  if (facet.id === "status") return STATUS_LABEL[value] ?? value;
  return facet.values?.find(([v]) => v === value)?.[1] ?? value;
}

export async function renderDocTable() {
  setActiveTab("docs");
  setCrumbs([{ label: "문서", href: "#/docs" }, { label: "표 보기" }]);
  const facetsHost = el("div", { class: "panel-scroll fct" });
  const tableHost = el("div", { class: "dt-host" });
  const countEl = el("span", { class: "dim dt-count", role: "status" });
  const chipsEl = el("div", { class: "dt-active" });
  const input = el("input", { type: "search", class: "dt-q", placeholder: "id · 제목 · 키워드", "aria-label": "문서 찾기", autocomplete: "off", spellcheck: "false" });
  const card = el("section", { class: "page-card dtable", "aria-label": "문서 표" }, [
    el("div", { class: "dt-bar" }, [viewSwitch("table"), el("label", { class: "dt-find" }, [icon("search", 14), input]), countEl]),
    chipsEl,
    tableHost,
  ]);
  screen().appendChild(cols({
    left: panel("left facets", [el("div", { class: "fct-head" }, [el("b", { text: "거르기" }), el("span", { class: "sp" })]), facetsHost], "거르기"),
    main: el("main", { class: "main wide" }, card),
    className: "wide",
  }));
  tableHost.replaceChildren(el("p", { class: "loading", text: "불러오는 중…" }));

  const all = docFacts(await everyDoc(), Date.now(), { mdTypes: mdTypeIds() });
  if (!card.isConnected) return;
  let state = parseState(location.hash.split("?")[1] ?? "");
  input.value = state.q;

  const values = (f) => {
    if (f.id === "type") {
      const have = new Set(all.map((r) => r.doc.type));
      return [...DOC_TYPES.filter((t) => have.has(t) || state.type.includes(t)), ...[...have].filter((t) => !DOC_TYPES.includes(t)).sort()];
    }
    if (f.id === "status") return ["active", "inactive"];
    return f.values.map(([v]) => v);
  };

  function set(next, { keepInput = false } = {}) {
    state = next;
    history.replaceState(null, "", `${location.pathname}${location.search}${tableHash(state)}`);
    if (!keepInput) input.value = state.q;
    paint();
  }

  function paintFacets() {
    const counts = facetCounts(all, state);
    facetsHost.replaceChildren(...FACETS.map((f) =>
      el("fieldset", { class: "fct-g" }, [
        el("legend", {}, [f.label, state[f.id].length ? el("span", { class: "count-pill", text: String(state[f.id].length) }) : null]),
        ...values(f).map((v) => {
          const n = counts[f.id].get(v) ?? 0;
          const on = state[f.id].includes(v);
          return el("label", { class: `fct-v${n || on ? "" : " zero"}` }, [
            el("input", { type: "checkbox", checked: on, "data-fk": `f:${f.id}:${v}`, onchange: () => set(toggleFacet(state, f.id, v)) }),
            f.id === "type" ? el("span", { class: "tdot", style: { "--c": typeColor(v) } }) : null,
            el("span", { class: "fct-l", text: valueLabel(f, v) }),
            el("span", { class: "fct-n", text: num(n) }),
          ]);
        }),
      ]),
    ));
  }

  function paint() {
    // 다시 그린 뒤에도 초점은 누른 그 단추 · 체크 칸에 남는다.
    const fk = document.activeElement?.dataset?.fk;
    draw();
    if (fk) [...card.parentNode.parentNode.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === fk)?.focus();
  }

  function draw() {
    paintFacets();
    const rows = sortRows(filterRows(all, state), state.sort, state.dir, DOC_TYPES);
    countEl.textContent = rows.length === all.length ? `문서 ${num(all.length)}` : `문서 ${num(rows.length)} / ${num(all.length)}`;
    const picked = FACETS.flatMap((f) => state[f.id].map((v) => ({ f, v })));
    chipsEl.hidden = !activeCount(state);
    chipsEl.replaceChildren(...[
      ...picked.map(({ f, v }) =>
        el("button", { type: "button", class: "chip dt-chip", "aria-label": `${f.label} ${valueLabel(f, v)} 거르기 끄기`, onclick: () => set(toggleFacet(state, f.id, v)) }, [
          el("span", { class: "dim", text: f.label }), valueLabel(f, v), icon("x", 11),
        ])),
      state.q ? el("button", { type: "button", class: "chip dt-chip", "aria-label": "찾는 글 지우기", onclick: () => set({ ...state, q: "" }) }, [el("span", { class: "dim", text: "찾기" }), state.q, icon("x", 11)]) : null,
      el("button", { type: "button", class: "btn ghost sm", text: "모두 지우기", onclick: () => set({ ...emptyState(), sort: state.sort, dir: state.dir }) }),
    ].filter(Boolean));
    tableHost.replaceChildren(docTable({
      rows,
      state,
      onSort: (id) => set(toggleSort(state, id)),
      empty: el("p", { class: "loading" }, [all.length ? "이 조건에 맞는 문서가 없습니다. 왼쪽에서 고른 값을 줄여 보세요." : "문서가 없습니다."]),
    }));
  }

  input.addEventListener("input", () => set({ ...state, q: input.value.trim() }, { keepInput: true }));
  paint();
}
