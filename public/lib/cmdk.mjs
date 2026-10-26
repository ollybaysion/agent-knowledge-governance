// ⌘K's lists as plain data: the ranked document results (with the section or
// column a query hit), the address a pick opens, and the order the groups
// stand in. No DOM here; node tests it.

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
 * A db-schema's best column for a term: equal 70 · start 55 · holds 45, case
 * ignored. → {name, score, more} (more = the other columns that hit) or null.
 */
export function columnHit(columns, t) {
  let best = null;
  let hits = 0;
  for (const name of columns ?? []) {
    const c = lower(name);
    const s = c === t ? 70 : c.startsWith(t) ? 55 : c.includes(t) ? 45 : 0;
    if (!s) continue;
    hits += 1;
    if (!best || s > best.score) best = { name, score: s };
  }
  return best && { ...best, more: hits - 1 };
}

/** A column hit as the result row's section: "열 MODEL_CD", "열 MODEL_CD 외 2". */
export const columnSection = (hit) => `열 ${hit.name}${hit.more ? ` 외 ${hit.more}` : ""}`;

/**
 * Documents for a query, best first: id equal 100 · id start 80 · column
 * equal 70 · id 60 · column start 55 · title 50 · column 45 · keyword 40 ·
 * body 20; a term takes its best. `bodies` maps "type/id" → md (absent = not
 * read yet). → [{doc, score, section, line, col}] — section "제목" when the
 * name matched; "열 …" and col (the column to open on) when a column did.
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
    let firstCol = null; // the first term's column hit, when it beat the rest
    for (const t of terms) {
      let s = 0;
      if (id === t) s = 100;
      else if (id.startsWith(t)) s = 80;
      else if (id.includes(t)) s = 60;
      else if (title.includes(t)) s = 50;
      else if (kws.some((k) => k.includes(t))) s = 40;
      const col = columnHit(d.columns, t);
      if (col && col.score > s) {
        s = col.score;
        if (t === terms[0]) firstCol = col;
      } else if (!s && body && lower(body).includes(t)) {
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
    if (firstCol) {
      out.push({ doc: d, score, section: columnSection(firstCol), line: null, col: firstCol.name });
      continue;
    }
    const hit = body ? sectionHit(body, terms[0]) : null;
    out.push({ doc: d, score, section: named && !hit ? "제목" : hit?.heading ?? "제목", line: hit?.line ?? null, col: null });
  }
  return out
    .sort((a, b) => b.score - a.score || rank(a.doc.type) - rank(b.doc.type) || a.doc.id.localeCompare(b.doc.id))
    .slice(0, limit);
}

/** The address a result opens: the doc, and ?col=<column> when a column hit. */
export const resultHash = (r) => `#/doc/${r.doc.type}/${encodeURIComponent(r.doc.id)}${r.col ? `?col=${encodeURIComponent(r.col)}` : ""}`;

/** A hash split at "?": the path, and its query's col (null when absent). */
export function splitHash(hash) {
  const s = String(hash ?? "");
  const i = s.indexOf("?");
  if (i < 0) return { path: s, col: null };
  return { path: s.slice(0, i), col: new URLSearchParams(s.slice(i + 1)).get("col") || null };
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
