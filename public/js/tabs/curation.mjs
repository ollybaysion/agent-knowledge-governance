// 정리 화면 (#/curation). 정리기(BE curator)가 남긴 두 가지를 본다.
// 중복 후보: 내용이 비슷한 문서 쌍. admin 이 그대로 두기 · 처리함 을 고른다.
// 흡수 기록: 정리기가 미분류 문서를 1급 문서에 합친 기록. admin 이 되돌린다.
// 서버: GET · POST /api/curation/duplicates(/:key/dismiss|resolve) ·
// GET /api/curation/absorptions(/:id) · POST /api/curation/absorptions/:id/revert.
import { api, invalidateDocs } from "../api.mjs";
import { el, toast } from "../dom.mjs";
import { docChip } from "../md.mjs";
import { statusBadge } from "../shared.mjs";
import { isAdmin } from "../state.mjs";
import { pageSection } from "../shell.mjs";
import { PAIR_FILTERS, absorptionRow, changedSections, lineDiff, pairRow } from "/lib/curation.mjs";

let pairFilter = "open";

/** A document cell: its chip, its status and a note when it moved. */
function docCell(side) {
  return el("div", { class: "cu-doc" }, [
    side.exists ? docChip({ type: side.type, id: side.id, label: side.label }) : docChip({ id: `${side.type}/${side.id}`, found: false }),
    side.status ? statusBadge(side.status) : null,
    side.note ? el("span", { class: "cu-note", text: side.note }) : null,
  ]);
}

const empty = (head, text) => el("div", { class: "rt-empty" }, [el("p", { class: "rt-empty-h", text: head }), el("p", { class: "dim", text })]);

export function renderCuration() {
  const section = pageSection("curation", "정리", "curation");
  const pairCount = el("span", { class: "n" });
  const pairList = el("div", { class: "cu-list" }, el("p", { class: "loading", text: "읽는 중…" }));
  const filter = el("div", { class: "seg", role: "group", "aria-label": "상태" });
  const absCount = el("span", { class: "n" });
  const absList = el("div", { class: "cu-list" }, el("p", { class: "loading", text: "읽는 중…" }));
  section.replaceChildren(
    el("h2", { id: "cu-dup" }, ["중복 후보 ", pairCount]),
    el("p", { class: "rt-lead", text: "정리기가 임베딩으로 찾은, 내용이 비슷한 문서 쌍입니다. 문서는 그대로 있습니다. 그대로 둔 쌍은 두 문서가 바뀌면 다시 열립니다." }),
    el("div", { class: "cu-filter" }, filter),
    pairList,
    el("h2", { id: "cu-abs" }, ["흡수 기록 ", absCount]),
    el("p", { class: "rt-lead", text: "정리기가 미분류 문서를 1급 문서에 합친 기록입니다. 합친 본문은 바로 반영됩니다. 되돌리기는 대상 문서를 흡수 전 본문으로 새로 저장합니다." }),
    absList,
  );

  function paintFilter() {
    filter.replaceChildren(
      ...PAIR_FILTERS.map(([value, label]) =>
        el("button", {
          type: "button",
          "aria-pressed": String(pairFilter === value),
          text: label,
          onclick: () => {
            pairFilter = value;
            paintFilter();
            loadPairs();
          },
        }),
      ),
    );
  }

  async function decide(row, action) {
    const res = await api(`/api/curation/duplicates/${encodeURIComponent(row.key)}/${action}`, { method: "POST", body: {} });
    if (res.ok) toast(action === "dismiss" ? "그대로 둡니다. 두 문서가 바뀌면 다시 열립니다." : "처리한 쌍으로 닫았습니다.");
    else toast(`처리하지 못했습니다 (${res.status}).`, "error");
    await loadPairs();
  }

  async function loadPairs() {
    const res = await api(`/api/curation/duplicates${pairFilter ? `?status=${pairFilter}` : ""}`);
    if (!res.ok) return pairList.replaceChildren(el("p", { class: "rt-error", text: `목록을 읽지 못했습니다 (${res.status}).` }));
    const rows = res.data.pairs.map(pairRow);
    pairCount.textContent = String(rows.length);
    if (!rows.length)
      return pairList.replaceChildren(empty("이 상태의 쌍이 없습니다.", "정리기가 다음에 돌 때 비슷한 문서 쌍을 올립니다."));
    const admin = isAdmin();
    pairList.replaceChildren(
      el("div", { class: "tbl-wrap" }, [
        el("table", { class: "cu-table" }, [
          el("thead", {}, el("tr", {}, [
            el("th", { scope: "col", text: "문서 A" }),
            el("th", { scope: "col", text: "문서 B" }),
            el("th", { scope: "col", class: "num", text: "점수" }),
            el("th", { scope: "col", text: "본 시각" }),
            el("th", { scope: "col", text: "상태" }),
            admin ? el("th", { scope: "col", class: "rt-act", "aria-label": "처리" }) : null,
          ])),
          el("tbody", {}, rows.map((r) =>
            el("tr", {}, [
              el("td", {}, docCell(r.a)),
              el("td", {}, docCell(r.b)),
              el("td", { class: "num mono", text: r.score }),
              el("td", { class: "dim", text: r.seenAt }),
              el("td", {}, [el("span", { text: r.state.label }), r.state.detail ? el("div", { class: "dim cu-sub", text: r.state.detail }) : null]),
              admin
                ? el("td", { class: "rt-act" }, r.open
                    ? el("div", { class: "cu-acts" }, [
                        el("button", { type: "button", class: "btn sm", text: "그대로 두기", "aria-label": `${r.a.label} · ${r.b.label} 그대로 두기`, onclick: () => decide(r, "dismiss") }),
                        el("button", { type: "button", class: "btn primary sm", text: "처리함", "aria-label": `${r.a.label} · ${r.b.label} 처리함`, onclick: () => decide(r, "resolve") }),
                      ])
                    : null)
                : null,
            ]),
          )),
        ]),
      ]),
    );
  }

  // The changed `##` sections of the target, each as a line diff.
  async function diffInto(cell, row) {
    cell.replaceChildren(el("p", { class: "loading", text: "읽는 중…" }));
    const res = await api(`/api/curation/absorptions/${encodeURIComponent(row.id)}`);
    if (!res.ok) return cell.replaceChildren(el("p", { class: "rt-error", text: `읽지 못했습니다 (${res.status}).` }));
    const parts = changedSections(res.data.before, res.data.after);
    if (!parts.length) return cell.replaceChildren(el("p", { class: "dim", text: "본문이 같습니다." }));
    cell.replaceChildren(
      el("div", { class: "cu-diff" }, parts.map((p) => {
        const lines = lineDiff(p.before, p.after).map((d) =>
          el("div", { class: `cu-line ${d.t}` }, [el("span", { class: "cu-mark", "aria-hidden": "true", text: d.t === "add" ? "+" : d.t === "del" ? "−" : " " }), el("span", { text: d.line || " " })]),
        );
        return el("div", { class: "cu-diff-sec" }, [el("div", { class: "cu-diff-h", text: `## ${p.heading}` }), el("div", { class: "cu-lines" }, lines)]);
      })),
      el("p", { class: "dim cu-foot" }, [
        "커밋 이력은 대상 문서의 오른쪽 패널 ",
        el("a", { href: `#/doc/${row.target.type}/${encodeURIComponent(row.target.id)}`, text: "이력" }),
        " 에 있습니다.",
      ]),
    );
  }

  async function revert(row) {
    if (!confirm(`${row.target.label} 을 흡수 전 본문으로 되돌릴까요? 새 개정으로 저장합니다. ${row.source.label} 의 흡수 표시도 걷습니다.`)) return;
    const res = await api(`/api/curation/absorptions/${encodeURIComponent(row.id)}/revert`, { method: "POST", body: {} });
    if (res.ok) {
      invalidateDocs();
      toast(`${row.target.label} 을 되돌렸습니다.`);
    } else toast(res.data?.message ?? `되돌리지 못했습니다 (${res.status}).`, "error");
    await loadAbsorptions();
  }

  async function loadAbsorptions() {
    const res = await api("/api/curation/absorptions");
    if (!res.ok) return absList.replaceChildren(el("p", { class: "rt-error", text: `목록을 읽지 못했습니다 (${res.status}).` }));
    const rows = res.data.absorptions.map(absorptionRow);
    absCount.textContent = String(rows.length);
    if (!rows.length) return absList.replaceChildren(empty("흡수 기록이 없습니다.", "정리기가 미분류 문서를 합치면 여기에 남습니다."));
    const admin = isAdmin();
    const body = [];
    for (const r of rows) {
      const diffCell = el("td", { colspan: "7" });
      const diffRow = el("tr", { class: "cu-diff-row", hidden: true }, diffCell);
      const toggle = el("button", {
        type: "button",
        class: "btn sm",
        text: "바뀐 부분",
        "aria-expanded": "false",
        onclick: () => {
          const open = diffRow.hidden;
          diffRow.hidden = !open;
          toggle.setAttribute("aria-expanded", String(open));
          if (open && !diffCell.childNodes.length) diffInto(diffCell, r);
        },
      });
      body.push(
        el("tr", {}, [
          el("td", {}, docCell(r.source)),
          el("td", {}, docCell(r.target)),
          el("td", { class: "cu-summary", text: r.summary }),
          el("td", { class: "dim", text: r.at }),
          el("td", {}, [el("span", { class: "mono", text: r.model }), r.score ? el("div", { class: "dim cu-sub", text: `점수 ${r.score}` }) : null]),
          el("td", {}, [el("span", { text: r.status }), r.revert.reason && !r.revert.can ? el("div", { class: "dim cu-sub", text: r.revert.reason }) : null]),
          el("td", { class: "rt-act" }, el("div", { class: "cu-acts" }, [
            toggle,
            admin
              ? el("button", {
                  type: "button",
                  class: "btn danger sm",
                  text: "되돌리기",
                  disabled: !r.revert.can,
                  title: r.revert.reason ?? "",
                  "aria-label": `${r.target.label} 되돌리기`,
                  onclick: () => revert(r),
                })
              : null,
          ])),
        ]),
        diffRow,
      );
    }
    absList.replaceChildren(
      el("div", { class: "tbl-wrap" }, [
        el("table", { class: "cu-table" }, [
          el("thead", {}, el("tr", {}, [
            el("th", { scope: "col", text: "원래 문서" }),
            el("th", { scope: "col", text: "대상 문서" }),
            el("th", { scope: "col", text: "요약" }),
            el("th", { scope: "col", text: "시각" }),
            el("th", { scope: "col", text: "모델" }),
            el("th", { scope: "col", text: "상태" }),
            el("th", { scope: "col", class: "rt-act", "aria-label": "보기 · 되돌리기" }),
          ])),
          el("tbody", {}, body),
        ]),
      ]),
    );
  }

  paintFilter();
  loadPairs();
  loadAbsorptions();
}
