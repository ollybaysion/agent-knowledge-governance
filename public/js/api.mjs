import { toast } from "./dom.mjs";
import { csrfToken, currentUser } from "./state.mjs";

// ---------- API ----------
// The SESSION cookie BE set at login rides along on its own (same-site); a
// write also carries the session's CSRF token.
export const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (csrfToken && WRITE_METHODS.has(opts.method || "GET"))
    headers["x-csrf-token"] = csrfToken;
  // opts.raw = bytes sent as they are (a capture upload); the caller sets
  // the content-type. Otherwise opts.body goes as JSON.
  let body = opts.raw ?? opts.body;
  if (opts.raw === undefined && body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  // fetch throws rather than resolving when the network is down. That used to
  // surface as an unhandled rejection, which meant the UI showed nothing at
  // all and left whatever message was on screen before. Status 0 = "the
  // request never went out", distinct from any status a server can return.
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body,
    });
  } catch {
    return { ok: false, status: 0, etag: null, data: null };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* fail-soft: 304 / md text bodies have no JSON */
  }
  // The session ended mid-use (30 minutes idle, or a logout elsewhere).
  if (res.status === 401 && currentUser)
    toast("로그인이 끝났습니다. 새로고침하면 로그인 화면으로 갑니다.", "error");
  return {
    ok: res.ok,
    status: res.status,
    etag: res.headers.get("etag"),
    data,
  };
}
