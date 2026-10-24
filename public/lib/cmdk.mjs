// ⌘K's lists as plain data: the ranked document results (with the section a
// query hit), and the order the groups stand in. No DOM here; node tests it.

const lower = (s) => String(s ?? "").toLowerCase();

/** The first `##` heading whose section holds `q`, and the hit line. */
export function sectionHit(markdown, q) {
  const needle = lower(q);
  if (!needle) return null;
  let heading = null;
  let fence = false;
  // A rendered SKILL.md opens with frontmatter (--- … ---): not a section.
  const text = String(markdown ?? "").replace(/^---\n[\s\S]*?\n---\n/, "");
  for (const line of text.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(line)) fence = !fence;
    const h = !fence && /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1];
      if (lower(heading).includes(needle)) return { heading, line: heading };
      continue;
    }
    if (/^#\s/.test(line)) continue;
    if (lower(line).includes(needle)) return { heading: heading ?? "본문", line: line.replace(/^[-*>\s#]+/, "").trim() };
  }
  return null;
}

/**
 * Documents for a query, best first: id equal · id start · id · title ·
 * keyword · body. `bodies` maps "type/id" → md (absent = not read yet).
 * → [{doc, score, section, line}] — section "제목" when the name matched.
 */
export function rankDocs(docs, q, { order = [], bodies = new Map(), limit = 8 } = {}) {
  const terms = lower(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const rank = (t) => {
    const i = order.indexOf(t);
    return i < 0 ? order.length : i;
  };
  const out = [];
  for (const d of docs) {
    const id = lower(d.id);
    const title = lower(d.title);
    const kws = (d.keywords ?? []).map((k) => lower(k.kw));
    const body = bodies.get(`${d.type}/${d.id}`);
    let score = 0;
    let named = true;
    for (const t of terms) {
      let s = 0;
      if (id === t) s = 100;
      else if (id.startsWith(t)) s = 80;
      else if (id.includes(t)) s = 60;
      else if (title.includes(t)) s = 50;
      else if (kws.some((k) => k.includes(t))) s = 40;
      else if (body && lower(body).includes(t)) {
        s = 20;
        named = false;
      }
      if (!s) {
        score = 0;
        break;
      }
      score += s;
    }
    if (!score) continue;
    const hit = body ? sectionHit(body, terms[0]) : null;
    out.push({ doc: d, score, section: named && !hit ? "제목" : hit?.heading ?? "제목", line: hit?.line ?? null });
  }
  return out
    .sort((a, b) => b.score - a.score || rank(a.doc.type) - rank(b.doc.type) || a.doc.id.localeCompare(b.doc.id))
    .slice(0, limit);
}

/** The groups in the order they stand: an empty box puts 즐겨찾기 · 최근 first. */
export function groupOrder(q) {
  return String(q ?? "").trim()
    ? ["results", "types", "favorites", "recent", "commands"]
    : ["shelf", "types", "commands"];
}

/** Rows of a group that match the query (all of them when it is empty). */
export function matching(rows, q, text) {
  const terms = lower(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return rows;
  return rows.filter((r) => terms.every((t) => lower(text(r)).includes(t)));
}
