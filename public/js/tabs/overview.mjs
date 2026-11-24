// 개요 탭: 소개 띠(티어의 일생 · 상태 다이어그램, index.html 의 template) ·
// 통계 · 타입 칩 · 문서 표(표 보기와 같은 표). 소개 띠의 문서 종류 표는 GET /api/types 로 그린다.
import { allDocs, everyDoc } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { coverageBar, stat, usedByText } from "../shared.mjs";
import { coveragePercent, majorCoverage, userCount } from "/lib/table-class.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPES, TYPE_LABEL, mdTypeIds } from "../state.mjs";
import { docTable } from "./doc-table.mjs";
import { DEFAULT_SORT, SORTS, sortRows, tableHash, toggleSort } from "/lib/doc-table.mjs";
import { docFacts } from "/lib/health.mjs";

// 주요 테이블 확정 커버리지: the sum, then the 주요 tables, the lowest first.
function coverageBlock(all) {
  const cov = majorCoverage(all);
  const open = (d) => (location.hash = `#/doc/db-schema/${encodeURIComponent(d.id)}`);
  return [
    el("h3", { class: "ov-cov-h", text: "주요 테이블 확정 커버리지" }),
    el("div", { class: "stats" }, stat(`${coveragePercent(cov)}%`, `확정 슬롯 ${cov.confirmed} / 슬롯 ${cov.total} · 주요 표 ${cov.rows.length}`)),
    cov.rows.length
      ? el("ul", { class: "ov-cov-list" }, cov.rows.map((d) =>
          el("li", { class: "nav-doc", tabindex: "0", title: usedByText(d.usedBy), onclick: () => open(d), onkeydown: (e) => e.key === "Enter" && open(d) }, [
            el("span", { class: "mono ov-cov-name", text: d.title ?? d.id }),
            coverageBar(d.coverage),
            el("span", { class: "dim", text: `쓰는 스킬 ${userCount(d)}` }),
          ]),
        ))
      : el("p", { class: "dim ov-cov-none", text: "조회에 쓰이는 표가 없습니다" }),
  ];
}

export async function renderOverviewScreen() {
  setActiveTab("overview");
  setCrumbs([{ label: "개요" }]);
  const page = el("section", { class: "overview" }, $("tpl-overview").content.cloneNode(true));
  screen().appendChild(cols({ main: el("main", { class: "main wide" }, page), className: "wide" }));

  page.querySelector("#ov-types").replaceChildren(
    ...TYPES.filter((t) => t.status === "active").map((t) =>
      el("tr", {}, [
        el("td", { class: "tt-k" }, [el("span", { class: "tdot", style: { "--c": t.color } }), ` ${t.id}`]),
        el("td", { text: t.description ?? t.label }),
      ]),
    ),
  );

  const all = await allDocs();
  const totals = { scaffold: 0, inferred: 0, confirmed: 0, deprecated: 0 };
  for (const d of all) for (const t of Object.keys(totals)) totals[t] += d.tiers?.[t] || 0;
  // Counted apart from 문서: after a bulk import most of the corpus can be
  // inactive, and one total would read as more than any session sees.
  const inactive = all.filter((d) => d.status === "inactive").length;
  page.querySelector("#ov-stats").replaceChildren(
    stat(String(all.length - inactive), "활성 문서"),
    stat(String(inactive), "비활성 (주입 안 됨)", inactive ? "off" : ""),
    stat(String(totals.inferred), "검토 대기 (추정 슬롯)", "warn"),
    stat(String(totals.confirmed), "확정 슬롯"),
    stat(String(totals.deprecated), "폐기 슬롯", "dep"),
  );

  page.querySelector("#ov-coverage").replaceChildren(...coverageBlock(all));

  // 문서 표는 표 보기(#/table)와 같은 표다: 열 머리로 정렬하고, 타입 칩으로 좁힌다.
  const facts = docFacts(await everyDoc(), Date.now(), { mdTypes: mdTypeIds() });
  if (!page.isConnected) return;
  let sort = { sort: DEFAULT_SORT, dir: SORTS[DEFAULT_SORT] };
  const counts = new Map();
  for (const d of all) counts.set(d.type, (counts.get(d.type) || 0) + 1);
  const chips = page.querySelector("#ov-typechips");
  const tableHost = page.querySelector("#ov-table");
  let shown = "all";
  const chipDefs = [["all", `전체 ${all.length}`], ...DOC_TYPES.map((t) => [t, `${TYPE_LABEL[t]} ${counts.get(t) || 0}`])];
  chips.replaceChildren(
    ...chipDefs.map(([t, label]) =>
      el("button", { type: "button", "aria-pressed": String(t === shown), "data-type": t, onclick: () => { shown = t; paint(); } }, label),
    ),
  );
  function paint() {
    for (const c of chips.querySelectorAll("button")) {
      c.setAttribute("aria-pressed", String(c.dataset.type === shown));
      c.classList.toggle("on", c.dataset.type === shown);
    }
    const focused = document.activeElement?.dataset?.fk;
    const rows = sortRows(facts.filter((r) => shown === "all" || r.doc.type === shown), sort.sort, sort.dir, DOC_TYPES);
    toTable.href = tableHash({ ...sort, type: shown === "all" ? [] : [shown] });
    tableHost.replaceChildren(docTable({ rows, state: sort, onSort: (id) => { sort = toggleSort(sort, id); paint(); } }));
    if (focused) [...tableHost.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === focused)?.focus();
  }
  const toTable = el("a", { class: "ov-to-table", href: "#/table", text: "표 보기에서 거르기 →" });
  chips.append(el("span", { class: "sp" }), toTable);
  paint();
}
