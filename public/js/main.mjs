import { route } from "./router.mjs";
import { applyTheme, gateMessage, renderMeta, showApp, showGate } from "./shell.mjs";
import { THEME_KEY, loadTypes, setUser } from "./state.mjs";
import { renderDocTree } from "./tabs/docs.mjs";

// ---------- boot ----------
export async function enterApp() {
  await loadTypes();
  await renderDocTree();
  route();
}
(async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
  let res;
  try {
    res = await fetch("/api/me");
  } catch {
    return showGate(gateMessage(0));
  }
  const data = await res.json().catch(() => null);
  // No session: log in at FE (BE's login), then come back.
  if (res.status === 401 && data?.login) return location.assign(data.login);
  if (!res.ok) return showGate(gateMessage(res.status));
  setUser(data, res.headers.get("x-csrf-token"));
  renderMeta();
  showApp();
  enterApp();
})();
