// The frame every screen sits in: the app rail (채팅 · 지식 · 관리 · 테마),
// the 56px head (app grid · 답으로 돌아가기 · breadcrumbs · pill tabs ·
// search · who · 로그아웃) and the body columns. ?embed=1 draws none of it:
// only the body column, for FE's drawer.
import { $, el, icon } from "./dom.mjs";
import { pushRecentAnswer } from "/lib/from-url.mjs";
import {
  THEME_KEY,
  answerId,
  csrfToken,
  currentUser,
  embed,
  feUrl,
  from,
  isAdmin,
} from "./state.mjs";

export const TABS = [
  { id: "overview", label: "개요", hash: "#/overview" },
  { id: "agents", label: "에이전트", hash: "#/agents" },
  { id: "docs", label: "문서", hash: "#/docs" },
  { id: "graph", label: "그래프", hash: "#/graph" },
  { id: "review", label: "검토", hash: "#/review" },
  { id: "audit", label: "감사", hash: "#/audit" },
  { id: "types", label: "타입", hash: "#/types", admin: true },
];
export const tabLabel = (id) => TABS.find((t) => t.id === id)?.label ?? id;

// ---------- theme ----------
export function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $("theme-toggle");
  if (!btn) return;
  const dark = theme === "dark";
  btn.replaceChildren(icon(dark ? "sun" : "moon", 18), el("span", { class: "rail-l", text: dark ? "밝게" : "어둡게" }));
  btn.setAttribute("aria-label", dark ? "밝은 테마로" : "어두운 테마로");
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage off: the theme holds until reload */
  }
  applyTheme(next);
}

// ---------- gate ----------
export function showGate(message) {
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-msg").textContent = message;
}
export function gateMessage(status) {
  if (status === 0) return "서버에 연결할 수 없습니다.";
  if (status === 429) return "인증 실패가 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (status === 503) return "세션 저장소(Redis)에 닿지 않습니다. 관리자에게 문의하세요.";
  return `로그인 정보를 읽지 못했습니다 (${status}).`;
}

// Login and logout both live in BE, on the FE address. Logout is BE's form
// POST with the session's CSRF token, so it ends the shared session (and the
// Keycloak one) for FE and AKG together.
function logout() {
  const form = el("form", { method: "post", action: currentUser.logout }, [
    el("input", { type: "hidden", name: "_csrf", value: csrfToken || "" }),
  ]);
  document.body.appendChild(form);
  form.submit();
}

// ---------- recent answers (the app grid's list) ----------
const ANSWERS_KEY = "akg_recent_answers";
function recentAnswers() {
  try {
    const list = JSON.parse(localStorage.getItem(ANSWERS_KEY) || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x?.url === "string") : [];
  } catch {
    return [];
  }
}
/** The FE answer this page was opened from goes first in the list. */
export function rememberAnswer() {
  if (!from) return;
  try {
    localStorage.setItem(ANSWERS_KEY, JSON.stringify(pushRecentAnswer(recentAnswers(), { url: from, id: answerId, at: new Date().toISOString() })));
  } catch {
    /* storage off: the list stays as it was */
  }
}

// ---------- rail ----------
function railItem({ label, iconName, href, current, disabled, hidden }) {
  if (hidden) return null;
  const attrs = { class: `rail-i${current ? " on" : ""}${disabled ? " off" : ""}` };
  if (current) attrs["aria-current"] = "page";
  if (disabled) {
    attrs["aria-disabled"] = "true";
    attrs.title = "FE 주소가 설정되지 않았습니다";
  }
  return el(disabled ? "span" : "a", { ...attrs, ...(disabled ? {} : { href }) }, [
    icon(iconName, 18),
    el("span", { class: "rail-l", text: label }),
  ]);
}
function rail() {
  return el("nav", { class: "rail", id: "rail", "aria-label": "앱" }, [
    el("div", { class: "rail-top" }, [
      railItem({ label: "채팅", iconName: "chat", href: feUrl ?? "#", disabled: !feUrl }),
      railItem({ label: "지식", iconName: "book", href: "#/overview", current: true }),
      railItem({ label: "관리", iconName: "admin", href: feUrl ? `${feUrl}/admin` : "#", disabled: !feUrl, hidden: !isAdmin() }),
    ]),
    el("div", { class: "rail-bottom" }, [
      el("button", { type: "button", class: "rail-i", id: "theme-toggle", onclick: toggleTheme }),
    ]),
  ]);
}

// ---------- app grid ----------
function closeGrid() {
  const pop = $("grid-pop");
  if (!pop) return;
  pop.remove();
  $("grid-btn")?.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", outsideGrid, true);
}
function outsideGrid(e) {
  if (!$("grid-pop")?.contains(e.target) && !$("grid-btn")?.contains(e.target)) closeGrid();
}
function openGrid() {
  if ($("grid-pop")) return closeGrid();
  const answers = recentAnswers();
  const pop = el("div", { class: "grid-pop", id: "grid-pop", role: "dialog", "aria-label": "앱 고르기" }, [
    el("div", { class: "grid-apps" }, [
      feUrl
        ? el("a", { class: "grid-app", href: feUrl }, [icon("chat", 22), el("span", { text: "채팅" })])
        : el("span", { class: "grid-app off", "aria-disabled": "true" }, [icon("chat", 22), el("span", { text: "채팅" })]),
      el("a", { class: "grid-app on", href: "#/overview", "aria-current": "page", onclick: closeGrid }, [icon("book", 22), el("span", { text: "지식" })]),
    ]),
    el("div", { class: "grid-h", text: "최근 답" }),
    answers.length
      ? el(
          "ul",
          { class: "grid-answers" },
          answers.map((a) =>
            el("li", {}, el("a", { href: a.url }, [
              el("span", { class: "mono", text: a.id ?? "답" }),
              el("span", { class: "dim", text: a.url.replace(/^https?:\/\/[^/]+/, "") }),
            ])),
          ),
        )
      : el("p", { class: "dim grid-empty", text: "FE 답에서 넘어온 기록이 없습니다." }),
  ]);
  pop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeGrid();
      $("grid-btn")?.focus();
    }
  });
  $("top").appendChild(pop);
  $("grid-btn").setAttribute("aria-expanded", "true");
  setTimeout(() => document.addEventListener("pointerdown", outsideGrid, true), 0);
  pop.querySelector("a")?.focus();
}

// ---------- head ----------
function head() {
  const tabs = el(
    "nav",
    { class: "tabs", id: "tabs", "aria-label": "화면" },
    TABS.filter((t) => !t.admin || isAdmin()).map((t) =>
      el("a", { class: "tab", href: t.hash, "data-tab": t.id }, [
        t.label,
        t.id === "review" ? el("span", { class: "tab-n", id: "review-count", hidden: true }) : null,
      ]),
    ),
  );
  return el("header", { class: "top", id: "top" }, [
    el("button", {
      type: "button",
      class: "icon-btn",
      id: "grid-btn",
      "aria-label": "앱 고르기",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      onclick: openGrid,
    }, icon("grid", 18)),
    from
      ? el("a", { class: "back-answer", href: from }, [icon("back", 14), "답으로 돌아가기"])
      : null,
    el("ol", { class: "crumbs", id: "crumbs", "aria-label": "지금 위치" }),
    tabs,
    el("div", { class: "top-right" }, [
      el("button", {
        type: "button",
        class: "icon-btn search-btn",
        id: "search-btn",
        "aria-label": "찾기 (⌘K)",
        "aria-keyshortcuts": "Meta+K Control+K",
        onclick: () => document.dispatchEvent(new CustomEvent("akg:cmdk")),
      }, [icon("search", 16), el("kbd", { text: "⌘K" })]),
      el("span", { class: "whoami" }, [el("b", { text: currentUser.id }), el("span", { class: "dim", text: ` · ${currentUser.group}` })]),
      el("button", { type: "button", class: "btn ghost sm", text: "로그아웃", onclick: logout }),
    ]),
  ]);
}

export function mountShell() {
  const app = $("app");
  document.body.classList.toggle("embed", embed);
  if (embed) {
    app.replaceChildren(el("div", { class: "body", id: "body" }));
  } else {
    app.replaceChildren(
      el("a", { class: "skip", href: "#body", text: "본문으로 건너뛰기", onclick: (e) => { e.preventDefault(); $("body").focus(); } }),
      rail(),
      head(),
      el("div", { class: "body", id: "body", tabindex: "-1" }),
    );
  }
  app.hidden = false;
  $("gate").hidden = true;
  applyTheme(document.documentElement.dataset.theme || readTheme());
}

export function setActiveTab(id) {
  for (const a of document.querySelectorAll("#tabs .tab")) {
    const on = a.dataset.tab === id;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  document.body.dataset.tab = id;
}

/** FDC 에이전트 › 지식 › {tab} › … — the last part is where you are. */
export function setCrumbs(parts) {
  const ol = $("crumbs");
  const title = parts.length ? parts[parts.length - 1].label : "지식";
  document.title = `${title} · 지식`;
  if (!ol) return;
  const all = [
    { label: "FDC 에이전트", href: feUrl ?? null, strong: true },
    { label: "지식", href: "#/overview" },
    ...parts,
  ];
  ol.replaceChildren(
    ...all.map((p, i) => {
      const last = i === all.length - 1;
      const node = p.href && !last
        ? el("a", { href: p.href, text: p.label })
        : el("span", { text: p.label, ...(last ? { "aria-current": "page" } : {}) });
      return el("li", { class: `${p.strong ? "crumb-root" : ""}${last ? " crumb-last" : ""}` }, [
        i ? icon("right", 12) : null,
        node,
      ]);
    }),
  );
}

export function setReviewCount(n) {
  const b = $("review-count");
  if (!b) return;
  b.hidden = !n;
  b.textContent = n ? String(n) : "";
  b.setAttribute("aria-label", `대기 ${n}`);
}

/** The body, emptied for the next screen. */
export function screen() {
  const b = $("body");
  b.replaceChildren();
  b.className = "body";
  return b;
}

/**
 * The body columns: left panel 288 · main · right panel 288 (each optional).
 * In embed mode only `main` is drawn.
 */
export function cols({ left = null, main, right = null, className = "" }) {
  const wrap = el("div", { class: `cols ${className}`.trim() });
  if (left && !embed) wrap.appendChild(left);
  wrap.appendChild(main);
  if (right && !embed) wrap.appendChild(right);
  wrap.classList.toggle("has-left", !!left && !embed);
  wrap.classList.toggle("has-right", !!right && !embed);
  return wrap;
}
export const panel = (cls, children, label) =>
  el("aside", { class: `panel ${cls}`, ...(label ? { "aria-label": label } : {}) }, children);

/** A wide page card holding one <section id> (검토 · 감사 draw into it). */
export function pageSection(tab, label, id) {
  setActiveTab(tab);
  setCrumbs([{ label }]);
  const section = el("section", { id, class: `page-card ${id}` });
  screen().appendChild(cols({ main: el("main", { class: "main wide" }, section), className: "wide" }));
  return section;
}
