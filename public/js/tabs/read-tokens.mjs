// 읽기 토큰 화면 (#/read-tokens). 사람이 자기 개인 읽기 토큰을 발급하고 폐기한다.
// WorkBench 같은 내 PC 의 앱이 이 토큰(Authorization: Bearer akgr_…)으로 문서를 읽는다.
// 서버: GET · POST /api/read-tokens, DELETE /api/read-tokens/:id (쿠키 세션만).
import { api } from "../api.mjs";
import { $, el, toast } from "../dom.mjs";
import { pageSection } from "../shell.mjs";

const DAYS = [30, 90, 365];
const DEFAULT_DAYS = 90;
const LABEL_MAX = 40;

const pad = (n) => String(n).padStart(2, "0");
/** ISO 8601 → 내 시각 "2026-11-08 14:05". */
function localAt(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localDay = (iso) => localAt(iso).slice(0, 10);

export function renderReadTokensScreen() {
  const section = pageSection("read-tokens", "읽기 토큰", "read-tokens");
  const count = el("span", { class: "n" });
  const issued = el("div", { class: "rt-issued", hidden: true, "aria-live": "polite" });
  const formArea = el("div", { class: "rt-form-area" });
  const listArea = el("div", { class: "rt-list" }, el("p", { class: "loading", text: "읽는 중…" }));
  section.replaceChildren(
    el("h2", {}, ["읽기 토큰 ", count]),
    el("p", { class: "rt-lead" }, [
      "이 토큰으로 WorkBench 같은 내 PC 의 앱이 AKG 문서를 읽습니다. 토큰은 읽기만 합니다. ",
      "토큰은 한 사람에 5 개까지 둡니다.",
    ]),
    issued,
    formArea,
    listArea,
  );

  const label = el("input", {
    type: "text",
    id: "rt-label",
    class: "rt-input",
    maxlength: String(LABEL_MAX),
    placeholder: "예: WorkBench 노트북",
    autocomplete: "off",
    required: true,
  });
  const days = el(
    "select",
    { id: "rt-days", class: "rt-input" },
    DAYS.map((d) => el("option", { value: String(d), text: `${d}일`, ...(d === DEFAULT_DAYS ? { selected: true } : {}) })),
  );
  const submit = el("button", { type: "submit", class: "btn primary", text: "발급" });
  const formError = el("p", { class: "rt-error", role: "alert", hidden: true });
  const form = el("form", { class: "rt-form", onsubmit: onIssue }, [
    el("div", { class: "rt-field rt-field-label" }, [el("label", { for: "rt-label", class: "fieldlab", text: "이름" }), label]),
    el("div", { class: "rt-field" }, [el("label", { for: "rt-days", class: "fieldlab", text: "기간" }), days]),
    el("div", { class: "rt-field rt-field-go" }, submit),
  ]);
  const full = el("p", { class: "rt-full", hidden: true });
  formArea.replaceChildren(form, formError, full);

  function showError(message) {
    formError.textContent = message;
    formError.hidden = !message;
  }

  async function onIssue(e) {
    e.preventDefault();
    showError("");
    const name = label.value.trim();
    if (!name) {
      showError("이름을 적으세요. 어느 앱에 붙였는지 알아볼 이름이면 됩니다.");
      label.focus();
      return;
    }
    submit.disabled = true;
    const res = await api("/api/read-tokens", { method: "POST", body: { label: name, days: Number(days.value) } });
    submit.disabled = false;
    if (res.status === 201) {
      label.value = "";
      showIssued(res.data);
      await load();
      return;
    }
    if (res.status === 409 && res.data?.error === "read_token_limit")
      showError(`토큰이 이미 ${res.data.limit} 개입니다. 아래에서 하나를 폐기한 뒤 다시 발급하세요.`);
    else if (res.status === 400) showError(res.data?.message ?? "이름이나 기간이 틀렸습니다.");
    else showError(`발급하지 못했습니다 (${res.status}).`);
    await load();
  }

  function showIssued(t) {
    const value = el("input", {
      type: "text",
      class: "rt-token mono",
      value: t.token,
      readonly: true,
      "aria-label": "새 토큰",
      spellcheck: "false",
      onfocus: (e) => e.target.select(),
    });
    const copy = el("button", {
      type: "button",
      class: "btn primary",
      text: "복사",
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(t.token);
          copy.textContent = "복사했습니다";
          toast("토큰을 복사했습니다. WorkBench 설정에 붙여 넣으세요.");
        } catch {
          value.focus();
          value.select();
          toast("자동 복사가 막혔습니다. 선택된 토큰을 Ctrl+C 로 복사하세요.", "error");
        }
      },
    });
    issued.replaceChildren(
      el("div", { class: "rt-issued-h" }, [
        el("b", { text: "새 토큰" }),
        el("span", { class: "rt-issued-label", text: t.label }),
        el("span", { class: "dim", text: `${localDay(t.expiresAt)} 까지` }),
      ]),
      el("div", { class: "rt-token-row" }, [value, copy]),
      el("p", { class: "rt-warn" }, [
        el("b", { text: "이 창을 닫으면 다시 볼 수 없습니다." }),
        " 지금 복사해 WorkBench 설정에 붙여 넣으세요. 잃어버리면 이 토큰을 폐기하고 새로 발급합니다.",
      ]),
      el("div", { class: "rt-issued-foot" }, [
        el("button", {
          type: "button",
          class: "btn",
          text: "닫기",
          onclick: () => {
            issued.hidden = true;
            issued.replaceChildren();
            label.focus();
          },
        }),
      ]),
    );
    issued.hidden = false;
    value.focus();
  }

  async function revoke(t) {
    if (!confirm(`"${t.label}" 토큰을 폐기할까요? 이 토큰을 쓰는 앱은 바로 문서를 읽지 못합니다.`)) return;
    const res = await api(`/api/read-tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    if (res.status === 204) toast(`"${t.label}" 토큰을 폐기했습니다.`);
    else if (res.status === 404) toast("이미 없는 토큰입니다. 목록을 다시 읽습니다.", "error");
    else toast(`폐기하지 못했습니다 (${res.status}).`, "error");
    await load();
  }

  async function load() {
    const res = await api("/api/read-tokens");
    if (!res.ok) {
      listArea.replaceChildren(el("p", { class: "rt-error", text: `목록을 읽지 못했습니다 (${res.status}).` }));
      return;
    }
    const { tokens, limit } = res.data;
    count.textContent = `${tokens.length} / ${limit}`;
    const atLimit = tokens.length >= limit;
    form.hidden = atLimit;
    full.hidden = !atLimit;
    full.textContent = atLimit ? `토큰이 ${limit} 개 다 찼습니다. 새로 받으려면 아래에서 쓰지 않는 토큰을 폐기하세요.` : "";
    if (atLimit) showError("");
    if (!tokens.length) {
      listArea.replaceChildren(
        el("div", { class: "rt-empty" }, [
          el("p", { class: "rt-empty-h", text: "발급한 토큰이 없습니다." }),
          el("p", { class: "dim", text: "위에서 이름과 기간을 고르고 발급하세요. 토큰은 발급 직후 한 번만 보입니다." }),
        ]),
      );
      return;
    }
    listArea.replaceChildren(
      el("div", { class: "tbl-wrap" }, [
        el("table", { class: "rt-table" }, [
          el("thead", {}, el("tr", {}, [
            el("th", { scope: "col", text: "이름" }),
            el("th", { scope: "col", text: "발급" }),
            el("th", { scope: "col", text: "만료" }),
            el("th", { scope: "col", text: "마지막 사용" }),
            el("th", { scope: "col", class: "rt-act", "aria-label": "폐기" }),
          ])),
          el(
            "tbody",
            {},
            tokens.map((t) =>
              el("tr", {}, [
                el("td", { class: "rt-name" }, [el("span", { text: t.label }), el("span", { class: "chip rev", text: t.id.slice(0, 6), title: `토큰 id ${t.id}` })]),
                el("td", { class: "dim", text: localDay(t.createdAt) }),
                el("td", { text: localDay(t.expiresAt) }),
                el("td", { class: t.lastUsedAt ? "" : "dim", text: t.lastUsedAt ? localAt(t.lastUsedAt) : "쓴 적 없음" }),
                el("td", { class: "rt-act" }, el("button", {
                  type: "button",
                  class: "btn danger sm",
                  text: "폐기",
                  "aria-label": `${t.label} 토큰 폐기`,
                  onclick: () => revoke(t),
                })),
              ]),
            ),
          ),
        ]),
      ]),
      el("p", { class: "note rt-note", text: "마지막 사용은 1 시간에 한 번 적습니다." }),
    );
  }

  load();
  $("rt-label")?.focus();
}
