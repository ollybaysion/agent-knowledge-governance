import { $, el } from "./dom.mjs";
import { THEME_KEY, csrfToken, currentUser } from "./state.mjs";

// ---------- theme ----------
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-toggle").textContent =
    theme === "dark" ? "라이트 모드" : "다크 모드";
}
$("theme-toggle").addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------- shell ----------
// Before the app shows, one line on the gate: why the dashboard cannot open.
export function showGate(message) {
  $("topbar").hidden = true;
  $("app-layout").hidden = true;
  $("gate").hidden = false;
  $("gate-msg").textContent = message;
}
export function showApp() {
  $("topbar").hidden = false;
  $("app-layout").hidden = false;
  $("gate").hidden = true;
}
export function renderMeta() {
  $("meta-store").replaceChildren(
    el("span", {
      class: "whoami",
      text: `${currentUser.id} · ${currentUser.group}`,
    }),
    el("button", {
      type: "button",
      id: "auth-toggle",
      class: "btn ghost sm",
      text: "로그아웃",
      onclick: logout,
    }),
  );
}
// Login and logout both live in BE, on the FE address. Logout is BE's form
// POST with the session's CSRF token, so it ends the shared session (and the
// Keycloak one) for FE and AKG together.
export function logout() {
  const form = el("form", { method: "post", action: currentUser.logout }, [
    el("input", { type: "hidden", name: "_csrf", value: csrfToken || "" }),
  ]);
  document.body.appendChild(form);
  form.submit();
}
export function gateMessage(status) {
  if (status === 0) return "서버에 연결할 수 없습니다.";
  if (status === 429) return "인증 실패가 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (status === 503) return "세션 저장소(Redis)에 닿지 않습니다. 관리자에게 문의하세요.";
  return `로그인 정보를 읽지 못했습니다 (${status}).`;
}

// ---------- sidebar (prototype: side-toggle + grp folding) ----------
$("side-toggle").addEventListener("click", () => {
  const layout = document.querySelector(".layout");
  const hidden = !layout.classList.contains("hide-side");
  layout.classList.toggle("hide-side", hidden);
  $("side-toggle").setAttribute("aria-pressed", String(hidden));
});
