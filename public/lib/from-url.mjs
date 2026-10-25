// The way back to an FE answer: ?from=<address> is taken only when it is an
// address inside the FE app (same origin, under the FE path), so the page is
// never an open redirect. No DOM here; node tests it directly.

function parse(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** `from` when it starts with the FE address; null otherwise. */
export function acceptFrom(from, feUrl) {
  if (typeof from !== "string" || !from || typeof feUrl !== "string" || !feUrl) return null;
  const fe = parse(feUrl);
  const f = parse(from);
  if (!fe || !f || f.origin !== fe.origin) return null;
  if (f.username || f.password) return null;
  const base = fe.pathname.endsWith("/") ? fe.pathname : `${fe.pathname}/`;
  if (f.pathname !== fe.pathname && !f.pathname.startsWith(base)) return null;
  return f.href;
}

/** The answer id an FE address names (m_7f3a2c), or null. */
export function answerIdOf(url) {
  return /\bm_[0-9a-z]+\b/i.exec(String(url ?? ""))?.[0] ?? null;
}

/**
 * What the embedded page (FE's drawer) posts to its parent on a key: Escape
 * with no dialog or popup open → { message: {type: "akg:close"}, targetOrigin:
 * the FE origin }. Null otherwise, and null without an FE address (the
 * message is never sent to "*").
 */
export function embedCloseMessage({ embed, feUrl, key, popupOpen }) {
  if (!embed || key !== "Escape" || popupOpen) return null;
  const fe = typeof feUrl === "string" ? parse(feUrl) : null;
  return fe ? { message: { type: "akg:close" }, targetOrigin: fe.origin } : null;
}

/** The answers list with `entry` first, the same address once, at most `cap`. */
export function pushRecentAnswer(list, entry, cap = 5) {
  const rest = (Array.isArray(list) ? list : []).filter((x) => x && x.url !== entry.url);
  return [entry, ...rest].slice(0, cap);
}
