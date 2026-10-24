// Boot: the theme, the FE address, who is signed in, the type list, then the
// frame and the first screen.
import { bindCmdk } from "./cmdk.mjs";
import { refreshReviewCount } from "./review-count.mjs";
import { route } from "./router.mjs";
import { applyTheme, gateMessage, mountShell, readTheme, rememberAnswer, showGate } from "./shell.mjs";
import { loadTypes, setConfig, setUser } from "./state.mjs";

(async function boot() {
  applyTheme(readTheme());
  let res;
  try {
    const config = await fetch("/api/config").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setConfig(config);
    res = await fetch("/api/me");
  } catch {
    return showGate(gateMessage(0));
  }
  const data = await res.json().catch(() => null);
  // No session: log in at FE (BE's login), then come back.
  if (res.status === 401 && data?.login) return location.assign(data.login);
  if (!res.ok) return showGate(gateMessage(res.status));
  setUser(data, res.headers.get("x-csrf-token"));
  rememberAnswer();
  await loadTypes();
  mountShell();
  bindCmdk();
  route();
  refreshReviewCount();
})();
