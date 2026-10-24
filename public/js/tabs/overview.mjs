import { api } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { keywordChips, shortRev, stat, statusBadge, tierMeter } from "../shared.mjs";
import { DOC_TYPES, TYPE_LABEL } from "../state.mjs";

// ================= 개요 =================
export async function renderOverview() {
  const all = [];
  const totals = { scaffold: 0, inferred: 0, confirmed: 0, deprecated: 0 };
  for (const type of DOC_TYPES) {
    const res = await api(`/api/docs?type=${type}`);
    if (!res.ok) continue;
    for (const d of res.data.docs) {
      if (d.status === "archived") continue;
      all.push({ ...d, type });
      for (const t of Object.keys(totals)) totals[t] += d.tiers[t] || 0;
    }
  }

  // Counted separately rather than folded into 문서: after a bulk import most
  // of the corpus can be inactive, and a single total would read as a corpus
  // far larger than what any session actually sees.
  const inactive = all.filter((d) => d.status === "inactive").length;
  $("ov-stats").replaceChildren(
    stat(String(all.length - inactive), "활성 문서"),
    stat(String(inactive), "비활성 (주입 안 됨)", inactive ? "off" : ""),
    stat(String(totals.inferred), "검토 대기 (추정 슬롯)", "warn"),
    stat(String(totals.confirmed), "confirmed 슬롯"),
    stat(String(totals.deprecated), "deprecated (고아)", "dep"),
  );

  const typeCounts = { all: all.length };
  for (const d of all) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
  const chipDefs = [
    ["all", `전체 ${typeCounts.all || 0}`],
    ...DOC_TYPES.map((t) => [t, `${TYPE_LABEL[t]} ${typeCounts[t] || 0}`]),
  ];
  const chips = chipDefs.map(([t, label], i) =>
    el(
      "button",
      {
        type: "button",
        class: i === 0 ? "on" : "",
        "data-type": t,
        onclick: (e) => filterType(e.currentTarget, t),
      },
      label,
    ),
  );
  $("ov-typechips").replaceChildren(...chips);

  const rows = all.map((d) =>
    el(
      "tr",
      {
        class: "nav-doc",
        "data-type": d.type,
        tabindex: "0",
        onclick: () =>
          (location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`),
        onkeydown: (e) => {
          if (e.key === "Enter")
            location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`;
        },
      },
      [
        el("td", {}, [
          el("b", { text: d.id }),
          " ",
          el("span", { class: "dim", text: TYPE_LABEL[d.type] }),
        ]),
        el("td", {}, keywordChips(d.keywords || [])),
        el("td", {}, tierMeter(d.tiers)),
        el("td", {}, statusBadge(d.status)),
        el("td", {}, el("span", { class: "chip rev", text: shortRev(d.rev) })),
      ],
    ),
  );
  $("ov-table").replaceChildren(
    all.length
      ? el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "문서" }),
              el("th", { scope: "col", text: "키워드" }),
              el("th", { scope: "col", text: "검토 상태" }),
              el("th", { scope: "col", text: "상태" }),
              el("th", { scope: "col", text: "rev" }),
            ]),
          ),
          el("tbody", {}, rows),
        ])
      : el("p", { class: "loading", text: "문서가 없습니다." }),
  );

  function filterType(btn, t) {
    for (const c of $("ov-typechips").querySelectorAll("button"))
      c.classList.toggle("on", c === btn);
    for (const tr of $("ov-table").querySelectorAll("tbody tr")) {
      tr.style.display = t === "all" || tr.dataset.type === t ? "" : "none";
    }
  }
}
