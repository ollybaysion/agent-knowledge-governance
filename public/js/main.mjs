// Boot: the theme, the FE address, who is signed in, the type list, then the
// frame and the first screen.
import { api } from "./api.mjs";
import { route } from "./router.mjs";
import { applyTheme, gateMessage, mountShell, readTheme, rememberAnswer, setReviewCount, showGate } from "./shell.mjs";
import { isAdmin, loadTypes, setConfig, setUser } from "./state.mjs";

/** 검토 badge: inferred slots across the corpus, plus pending proposals for admin. */
export async function refreshReviewCount() {
  const [docs, props] = await Promise.all([
    api("/api/docs?tier=inferred"),
    isAdmin() ? api("/api/proposals?state=pending") : null,
  ]);
  const slots = docs.ok ? docs.data.docs.reduce((n, d) => n + (d.tiers?.inferred || 0), 0) : 0;
  setReviewCount(slots + (props?.ok ? props.data.proposals.length : 0));
}

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
  route();
  refreshReviewCount();
})();
