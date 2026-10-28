// The item ids of a skill md's `## 데이터` section — the keys the consumer
// looks its queries up by, so they must be unique across every skill. The
// flow fence before the first `###` is no item (src/flow/agent-md.mjs reads it).
import { normalizeHeading, scan } from "./skill-sections.mjs";

const DATA_SECTION = "데이터";
const FENCE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)\s*$/;

const trimBlankLines = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return a === b ? null : lines.slice(a, b).join("\n").trimEnd();
};

/**
 * Each `### id — title` line of the `## 데이터` section(s), skipping fenced
 * code. The dash is —, – or -, with a space on both sides; without one the
 * first token is the id and title is null. `sql` is the item's first ```sql
 * fence and `text` the prose outside fences, each trimmed of blank lines the
 * way the consumer reads them (null when there is none).
 * @returns {{id: string, title: string|null, line: number, sql: string|null, text: string|null}[]} line is 1-based
 */
export function skillDataIds(markdown) {
  const out = [];
  const bodies = [];
  let inData = false;
  let open = null; // the open fence's marker
  scan(markdown).forEach(({ line, heading, fenced }, i) => {
    if (heading !== null) {
      inData = normalizeHeading(heading) === DATA_SECTION;
      return;
    }
    if (!inData) return;
    const body = bodies[bodies.length - 1];
    if (fenced) {
      if (!body) return;
      const f = FENCE.exec(line);
      if (open === null && f) {
        open = f[1];
        body.fences.push({ lang: f[2].toLowerCase(), lines: [] });
      } else if (open !== null && line.trim().startsWith(open)) open = null;
      else if (open !== null) body.fences[body.fences.length - 1].lines.push(line);
      return;
    }
    const rest = /^###\s+(.*?)\s*$/.exec(line)?.[1];
    if (!rest) {
      body?.prose.push(line);
      return;
    }
    const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(rest);
    out.push(m ? { id: m[1].trim(), title: m[2].trim(), line: i + 1 } : { id: rest.split(/\s+/)[0], title: null, line: i + 1 });
    bodies.push({ prose: [], fences: [] });
  });
  return out.map((item, i) => {
    const { prose, fences } = bodies[i];
    const sql = fences.find((x) => x.lang === "sql");
    return { ...item, sql: sql ? trimBlankLines(sql.lines) : null, text: trimBlankLines(prose) };
  });
}
