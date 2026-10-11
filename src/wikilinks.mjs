// `[[id]]` · `[[type/id]]` written in a document's text — the server turns them
// into links[] (rel "related") and the dashboard draws them as links. Shared by
// both (served as /wikilinks.mjs), so the two read the same brackets. No node
// imports: this file runs in the browser as it is.

const WIKI = /\[\[([^[\]\n]+?)\]\]/g;
const TYPE_RE = /^[a-z][a-z-]*$/;
const ID_RE = /^[a-z0-9._-]+$/;

/**
 * A text cut into plain runs and `[[ ]]` runs, in order. A `[[ ]]` inside a
 * fenced code block (``` or ~~~) is plain text.
 * @returns {({text: string} | {text: string, link: {text: string, type: string|null, id: string|null}})[]}
 */
export function wikiSegments(text) {
  const out = [];
  let fence = null;
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    const nl = i < lines.length - 1 ? "\n" : "";
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (fence === null && f) fence = f[1];
    else if (fence !== null && line.trim().startsWith(fence)) fence = null;
    else if (fence === null) {
      let last = 0;
      for (const m of line.matchAll(WIKI)) {
        if (m.index > last) out.push({ text: line.slice(last, m.index) });
        out.push({ text: m[0], link: target(m[1]) });
        last = m.index + m[0].length;
      }
      out.push({ text: line.slice(last) + nl });
      return;
    }
    out.push({ text: line + nl });
  });
  return out.filter((s) => s.text !== "");
}

// "type/id" names both; a bare "id" leaves the type to be looked up. Anything
// that cannot be an id stays a `[[ ]]` with no target (id null).
function target(inner) {
  const t = inner.trim();
  const slash = t.indexOf("/");
  const [type, id] = slash < 0 ? [null, t] : [t.slice(0, slash), t.slice(slash + 1)];
  const ok = ID_RE.test(id) && (type === null || TYPE_RE.test(type));
  return { text: t, type: ok ? type : null, id: ok ? id : null };
}

/** The distinct `[[ ]]` of the texts, first occurrence order. */
export function parseWikilinks(texts) {
  const seen = new Map();
  for (const text of [].concat(texts)) {
    for (const s of wikiSegments(text)) {
      if (s.link && !seen.has(s.link.text)) seen.set(s.link.text, s.link);
    }
  }
  return [...seen.values()];
}

/** The body texts a type's `[[ ]]` are read from. */
export function wikiTexts(type, body) {
  // A malformed body yields no text; the schema reports it.
  if (type === "domain-skill") return typeof body?.markdown === "string" ? [body.markdown] : [];
  if (type === "manual")
    return Array.isArray(body?.steps)
      ? body.steps.map((s) => s?.text).filter((t) => typeof t === "string")
      : [];
  return [];
}
