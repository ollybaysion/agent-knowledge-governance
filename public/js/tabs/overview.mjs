// 개요 탭: 소개 띠(티어의 일생 · 상태 다이어그램, index.html 의 template) ·
// 통계 · 타입 칩 · 문서 표. 소개 띠의 문서 종류 표는 GET /api/types 로 그린다.
import { allDocs } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { keywordChips, shortRev, stat, statusBadge, tierMeter } from "../shared.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPES, TYPE_LABEL } from "../state.mjs";

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
  const open = (d) => (location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`);
  function paint() {
    for (const c of chips.children) {
      c.setAttribute("aria-pressed", String(c.dataset.type === shown));
      c.classList.toggle("on", c.dataset.type === shown);
    }
    const rows = all.filter((d) => shown === "all" || d.type === shown);
    tableHost.replaceChildren(
      rows.length
        ? el("table", {}, [
            el("thead", {}, el("tr", {}, ["문서", "키워드", "검토 상태", "상태", "rev"].map((t) => el("th", { scope: "col", text: t })))),
            el("tbody", {}, rows.map((d) =>
              el("tr", { class: "nav-doc", tabindex: "0", onclick: () => open(d), onkeydown: (e) => e.key === "Enter" && open(d) }, [
                el("td", {}, [el("b", { text: d.id }), " ", el("span", { class: "dim", text: d.type === "domain-skill" ? (d.role === "sub" ? "도메인 지식" : "에이전트") : TYPE_LABEL[d.type] })]),
                el("td", {}, keywordChips(d.keywords || [])),
                el("td", {}, tierMeter(d.tiers ?? {})),
                el("td", {}, statusBadge(d.status)),
                el("td", {}, el("span", { class: "chip rev", text: shortRev(d.rev) })),
              ]),
            )),
          ])
        : el("p", { class: "loading", text: "문서가 없습니다." }),
    );
  }
  paint();
}
