// 에이전트 탭: domain-skill role=main only, one flat list with a Score dot at
// each row's end. Left panel: search · list · Score legend · 새 문서. The sub
// skills live in the 문서 탭 as 도메인 지식.
import { allDocs, lastScore } from "../api.mjs";
import { el, icon } from "../dom.mjs";
import { startDraft } from "../drafts.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { canEdit } from "../state.mjs";
import { scoreDot } from "./doc-panel.mjs";
import { draftLinks } from "./docs.mjs";

export const isMain = (d) => d.type === "domain-skill" && (d.role ?? "main") === "main";

/** The agent list panel; `selected` = the open agent's id. */
export function agentPanel(selected, draftId = null) {
  const list = el("ul", { class: "alist", "aria-label": "에이전트" });
  const count = el("span", { class: "count-pill" });
  const search = el("input", { type: "search", class: "psearch", placeholder: "에이전트 찾기 — id · 이름", "aria-label": "에이전트 찾기", autocomplete: "off" });
  let rows = [];
  function paint() {
    const q = search.value.trim().toLowerCase();
    const shown = rows.filter((d) => !q || `${d.id}\n${d.title ?? ""}\n${(d.keywords ?? []).map((k) => k.kw).join("\n")}`.toLowerCase().includes(q));
    list.replaceChildren(
      ...(shown.length
        ? shown.map((d) => {
            const dot = el("span", { class: "arow-score" });
            lastScore(d.id).then((s) => dot.replaceChildren(...[scoreDot(s.run)].filter(Boolean)));
            return el("li", {}, el("a", {
              class: `arow${d.id === selected ? " on" : ""}${d.status === "inactive" ? " off" : ""}`,
              href: `#/doc/domain-skill/${encodeURIComponent(d.id)}`,
              ...(d.id === selected ? { "aria-current": "page" } : {}),
            }, [
              el("span", { class: "badge-main", text: "메인" }),
              el("span", { class: "arow-id mono", text: d.id }),
              d.status === "inactive" ? el("span", { class: "mini-off", text: "비활성" }) : null,
              dot,
            ]));
          })
        : [el("li", { class: "dim pnone", text: q ? "찾는 에이전트가 없습니다." : "main 스킬이 없습니다." })]),
    );
  }
  search.addEventListener("input", paint);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      paint();
    }
  });
  allDocs().then((docs) => {
    rows = docs.filter(isMain).sort((a, b) => a.id.localeCompare(b.id));
    count.textContent = String(rows.length);
    paint();
  });
  return panel("left agent-panel", [
    el("div", { class: "psearch-w" }, [icon("search", 15), search]),
    el("div", { class: "plabel agent-h" }, [el("span", {}, ["에이전트 ", count]), el("span", { class: "dim mono", text: "domain-skill · main" })]),
    el("div", { class: "panel-scroll" }, [draftLinks("domain-skill", { role: "main", current: draftId }), list]),
    el("div", { class: "panel-foot" }, [
      el("div", { class: "legend-score" }, [
        el("span", { class: "dim", text: "점 = Score 구간" }),
        ...[0, 1, 2, 3, 4].map((b) => el("span", { class: `sdot band-${b}`, "aria-hidden": "true" })),
        el("span", { class: "dim mono", text: "0 → 100" }),
      ]),
      canEdit()
        ? el("button", { type: "button", class: "btn primary", onclick: () => startDraft("domain-skill", { role: "main" }) }, [icon("plus", 15), "새 문서"])
        : null,
    ]),
  ], "에이전트 목록");
}

/** #/agents: the first agent opens; with none, an empty body beside the list. */
export async function renderAgents() {
  const docs = await allDocs();
  const first = docs.filter(isMain).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (first) {
    location.replace(`#/doc/domain-skill/${encodeURIComponent(first.id)}`);
    return;
  }
  setActiveTab("agents");
  setCrumbs([{ label: "에이전트" }]);
  screen().appendChild(
    cols({ left: agentPanel(null), main: el("main", { class: "main" }, el("p", { class: "loading", text: "main 스킬이 아직 없습니다. 왼쪽 아래 새 문서로 만드세요." })) }),
  );
}
