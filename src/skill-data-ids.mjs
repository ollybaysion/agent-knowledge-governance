// The item ids of a skill md's `## 데이터` section — the keys the consumer
// procures and asks by, so they must be unique across every skill.
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
 * first token is the id and title is null. `query` is whether the item's body
 * opens a ```sql fence — the consumer (SkillMarkdownTool) reads such an item
 * as a query it looks up by id across every skill; any other item is a
 * question the skill asks for itself. `sql` and `ask` are the first such
 * fence's text and `text` the prose outside fences, each trimmed of blank
 * lines the way the consumer reads them (null when there is none).
 * @returns {{id: string, title: string|null, line: number, query: boolean,
 *   sql: string|null, ask: string|null, text: string|null}[]} line is 1-based
 */
export function skillDataIds(markdown) {
  const out = [];
  const bodies = [];
  let inData = false;
  let wasFenced = false;
  let open = null; // the open fence's marker and language
  scan(markdown).forEach(({ line, heading, fenced }, i) => {
    const opens = fenced && !wasFenced;
    wasFenced = fenced;
    if (heading !== null) {
      inData = normalizeHeading(heading) === DATA_SECTION;
      return;
    }
    if (!inData) return;
    const body = bodies[bodies.length - 1];
    if (fenced) {
      const lang = opens ? /^(?:`{3,}|~{3,})\s*(\S*)/.exec(line)?.[1] : null;
      if (lang && lang.toLowerCase() === "sql" && out.length) out[out.length - 1].query = true;
      if (!body) return;
      const f = FENCE.exec(line);
      if (open === null && f) {
        open = { marker: f[1], lang: f[2].toLowerCase() };
        body.fences.push({ lang: open.lang, lines: [] });
      } else if (open !== null && line.trim().startsWith(open.marker)) open = null;
      else if (open !== null) body.fences[body.fences.length - 1].lines.push(line);
      return;
    }
    const rest = /^###\s+(.*?)\s*$/.exec(line)?.[1];
    if (!rest) {
      body?.prose.push(line);
      return;
    }
    const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(rest);
    out.push(
      m
        ? { id: m[1].trim(), title: m[2].trim(), line: i + 1, query: false }
        : { id: rest.split(/\s+/)[0], title: null, line: i + 1, query: false },
    );
    bodies.push({ prose: [], fences: [] });
  });
  return out.map((item, i) => {
    const { prose, fences } = bodies[i];
    const fence = (lang) => {
      const f = fences.find((x) => x.lang === lang);
      return f ? trimBlankLines(f.lines) : null;
    };
    return { ...item, sql: fence("sql"), ask: fence("ask"), text: trimBlankLines(prose) };
  });
}
