import { api, invalidateDocs } from "../api.mjs";
import { $, el, toast } from "../dom.mjs";
import { evidence } from "../shared.mjs";
import { DOC_TYPES, currentUser } from "../state.mjs";
import { refreshReviewCount } from "../review-count.mjs";
import { pageSection } from "../shell.mjs";

// 검토 탭: 에이전트 제안 · 추정 슬롯(확정 대기) · 폐기 슬롯. 내용은 그대로, 새 틀의 카드 안.
export async function renderQueue() {
  const section = $("queue");
  section.replaceChildren(
    el("h2", {}, ["에이전트 제안 ", el("span", { class: "n", id: "q-pend" })]),
  );

  const propRes = await api("/api/proposals?state=pending");
  const propWrap = el("div", {});
  section.appendChild(propWrap);
  if (propRes.status === 403)
    propWrap.appendChild(
      el("p", { class: "loading", text: "admin 만 볼 수 있습니다." }),
    );
  else if (!propRes.ok)
    propWrap.appendChild(
      el("p", { class: "error", text: `불러오기 실패 (${propRes.status})` }),
    );
  else if (!propRes.data.proposals.length)
    propWrap.appendChild(
      el("p", { class: "loading", text: "대기 중인 제안이 없습니다." }),
    );
  else {
    const pc = $("q-pend");
    if (pc) pc.textContent = `${propRes.data.proposals.length} pending`;
    for (const p of propRes.data.proposals)
      propWrap.appendChild(proposalCard(p));
  }

  await slotQueueSection(
    section,
    "추정 슬롯 — 문서 횡단",
    "확정 대기",
    "inferred",
    true,
  );
  await slotQueueSection(
    section,
    "폐기(deprecated) 슬롯",
    "삭제/복원 대기",
    "deprecated",
    false,
  );

  function proposalCard(p) {
    const bodyLines = Object.entries(p.slots).map(([addr, v]) =>
      el("div", {}, [
        el("span", { class: "addr", text: addr }),
        ` "${v.text}" `,
        ...evidence(v.evidence),
      ]),
    );
    return el("div", { class: "prop" }, [
      el("div", { class: "head" }, [
        el("span", { class: "agent", text: p.submittedBy }),
        el("span", { class: "dim", text: "→" }),
        el("span", { class: "target", text: `${p.type}/${p.docId}` }),
        el("span", {
          class: "dim mla",
          text: `${p.id.slice(0, 6)} · ${p.createdAt}`,
        }),
      ]),
      el("div", { class: "body" }, bodyLines),
      el("div", { class: "acts" }, [
        el("button", {
          type: "button",
          class: "btn primary",
          onclick: () => adopt(p),
          text: "추정으로 반영",
        }),
        el("button", {
          type: "button",
          class: "btn danger",
          onclick: () => reject(p),
          text: "기각",
        }),
      ]),
    ]);
  }
  async function adopt(p) {
    const docRes = await api(
      `/api/docs/${p.type}/${encodeURIComponent(p.docId)}`,
    );
    if (!docRes.ok) return toast("대상 문서를 찾을 수 없습니다.", "error");
    const r = await api(`/api/proposals/${p.id}/adopt`, {
      method: "POST",
      headers: { "if-match": docRes.data.rev },
      body: {},
    });
    if (r.ok) {
      invalidateDocs();
      refreshReviewCount();
      renderQueue();
    } else toast(`반영 실패 (${r.status})`, "error");
  }
  async function reject(p) {
    const r = await api(`/api/proposals/${p.id}/reject`, {
      method: "POST",
      body: {},
    });
    if (r.ok) renderQueue();
    else toast(`기각 실패 (${r.status})`, "error");
  }
}

export async function slotQueueSection(section, title, badge, tier, promotable) {
  section.appendChild(
    el("h2", {}, [title + " ", el("span", { class: "n", text: badge })]),
  );
  const wrap = el("div", { class: "tbl-wrap" });
  section.appendChild(wrap);
  const canApprove = currentUser.group === "admin";
  const rows = [];
  for (const type of DOC_TYPES) {
    const listRes = await api(`/api/docs?type=${type}&tier=${tier}`);
    if (!listRes.ok) continue;
    for (const d of listRes.data.docs) {
      const detail = await api(`/api/docs/${type}/${encodeURIComponent(d.id)}`);
      if (!detail.ok) continue;
      const drev = detail.data.rev;
      for (const slot of detail.data.slots.filter((s) => s.tier === tier)) {
        const actCell = el("td", {});
        if (promotable && canApprove) {
          actCell.appendChild(
            el("button", {
              type: "button",
              class: "btn promote",
              onclick: async () => {
                const r = await api(
                  `/api/docs/${type}/${encodeURIComponent(d.id)}/promote`,
                  {
                    method: "POST",
                    headers: { "if-match": drev },
                    body: { slots: [slot.address] },
                  },
                );
                if (r.ok) {
                  invalidateDocs();
      refreshReviewCount();
                  renderQueue();
                } else toast(`확정 실패 (${r.status})`, "error");
              },
              text: "확정",
            }),
          );
        } else if (!promotable) {
          actCell.appendChild(
            el("a", {
              class: "btn ghost",
              href: `#/doc/${type}/${encodeURIComponent(d.id)}`,
              text: "문서로",
            }),
          );
        }
        rows.push(
          el("tr", tier === "deprecated" ? { class: "dep-row" } : {}, [
            el("td", { text: `${type === "db-schema" ? d.id : d.id}` }),
            el("td", {}, el("span", { class: "addr", text: slot.address })),
            el(
              "td",
              {},
              el(
                "span",
                tier === "deprecated" ? { class: "strike dim" } : {},
                slot.text || "",
              ),
            ),
            el("td", {
              class: "num",
              text: String((slot.evidence || []).length),
            }),
            el("td", { class: "dim", text: slot.by || "" }),
            actCell,
          ]),
        );
      }
    }
  }
  wrap.replaceChildren(
    rows.length
      ? el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "문서" }),
              el("th", { scope: "col", text: "슬롯" }),
              el("th", { scope: "col", text: "내용" }),
              el("th", { scope: "col", class: "num", text: "근거" }),
              el("th", { scope: "col", text: "by" }),
              el("th", { scope: "col", text: "" }),
            ]),
          ),
          el("tbody", {}, rows),
        ])
      : el("p", { class: "loading", text: "없습니다." }),
  );
}

export function renderReview() {
  pageSection("review", "검토", "queue");
  renderQueue();
}
