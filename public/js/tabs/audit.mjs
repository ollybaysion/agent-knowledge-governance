import { cols as __cols, screen as __screen, setActiveTab as __setActiveTab, setCrumbs as __setCrumbs } from "../shell.mjs";
import { el as __el } from "../dom.mjs";
import { api } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { shortRev } from "../shared.mjs";

// ================= 감사 =================
export async function renderAudit() {
  const section = $("audit");
  const docInput = el("input", { type: "text", placeholder: "type/id (선택)" });
  const windowSelect = el("select", {}, [
    el("option", { value: "", text: "전체 기간" }),
    el("option", { value: "24h", text: "최근 24시간" }),
    el("option", { value: "7d", text: "최근 7일" }),
    el("option", { value: "4w", text: "최근 4주" }),
  ]);
  const goBtn = el("button", {
    type: "button",
    class: "btn",
    onclick: load,
    text: "조회",
  });
  const results = el("div", {});
  section.replaceChildren(
    el("h2", {}, [
      "감사 로그 ",
      el("span", { class: "n", text: "= git log (GET /api/audit)" }),
    ]),
    el("div", { class: "row6", style: "padding:0 16px 8px" }, [
      docInput,
      windowSelect,
      goBtn,
    ]),
    results,
  );

  async function load() {
    const params = new URLSearchParams();
    if (docInput.value.trim()) params.set("doc", docInput.value.trim());
    if (windowSelect.value) params.set("window", windowSelect.value);
    const res = await api(`/api/audit?${params.toString()}`);
    if (!res.ok)
      return results.replaceChildren(
        el("p", { class: "error", text: `조회 실패 (${res.status})` }),
      );
    if (!res.data.entries.length)
      return results.replaceChildren(
        el("p", { class: "loading", text: "기록이 없습니다." }),
      );
    results.replaceChildren(
      el(
        "div",
        { class: "tbl-wrap" },
        el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "시각" }),
              el("th", { scope: "col", text: "actor" }),
              el("th", { scope: "col", text: "메시지" }),
              el("th", { scope: "col", text: "rev" }),
            ]),
          ),
          el(
            "tbody",
            {},
            res.data.entries.map((e) =>
              el("tr", {}, [
                el("td", { class: "dim", text: e.at }),
                el("td", { text: e.author }),
                el("td", {}, auditMessage(e.message)),
                el(
                  "td",
                  {},
                  el("span", { class: "chip rev", text: shortRev(e.rev) }),
                ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
  await load();
}
// color the leading verb of a commit message as an action badge (prototype .act)
export function auditMessage(msg) {
  const verb = (msg || "").split(" ")[0];
  const cls = {
    promote: "a-promote",
    adopt: "a-adopt",
    edit: "a-edit",
    "catalog-push": "a-catalog",
    deprecate: "a-dep",
    reject: "a-reject",
    create: "a-edit",
    propose: "a-adopt",
  }[verb];
  if (!cls) return document.createTextNode(msg);
  return el("span", {}, [
    el("span", { class: `act ${cls}`, text: verb }),
    " " + msg.slice(verb.length + 1),
  ]);
}

function wideSection(tab, label, id) {
  __setActiveTab(tab);
  __setCrumbs([{ label }]);
  const main = __el("main", { class: "main wide" }, __el("section", { id, class: "on" }));
  __screen().appendChild(__cols({ main, className: "wide" }));
}

export function renderAuditScreen() {
  wideSection("audit", "감사", "audit");
  renderAudit();
}
