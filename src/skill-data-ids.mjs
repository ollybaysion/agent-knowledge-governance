// The item ids of a skill md's `## 데이터` section — the keys the consumer
// procures and asks by, so they must be unique across every skill.
import { normalizeHeading, scan } from "./skill-sections.mjs";

const DATA_SECTION = "데이터";

/**
 * Each `### id — title` line of the `## 데이터` section(s), skipping fenced
 * code. The dash is —, – or -, with a space on both sides; without one the
 * first token is the id and title is null. `query` is whether the item's body
 * opens a ```sql fence — the consumer (SkillMarkdownTool) reads such an item
 * as a query it looks up by id across every skill; any other item is a
 * question the skill asks for itself.
 * @returns {{id: string, title: string|null, line: number, query: boolean}[]} line is 1-based
 */
export function skillDataIds(markdown) {
  const out = [];
  let inData = false;
  let wasFenced = false;
  scan(markdown).forEach(({ line, heading, fenced }, i) => {
    const opens = fenced && !wasFenced;
    wasFenced = fenced;
    if (heading !== null) {
      inData = normalizeHeading(heading) === DATA_SECTION;
      return;
    }
    if (!inData) return;
    if (fenced) {
      const lang = opens ? /^(?:`{3,}|~{3,})\s*(\S*)/.exec(line)?.[1] : null;
      if (lang && lang.toLowerCase() === "sql" && out.length) out[out.length - 1].query = true;
      return;
    }
    const rest = /^###\s+(.*?)\s*$/.exec(line)?.[1];
    if (!rest) return;
    const m = /^(.*?)\s+[—–-]\s+(.*)$/.exec(rest);
    out.push(
      m
        ? { id: m[1].trim(), title: m[2].trim(), line: i + 1, query: false }
        : { id: rest.split(/\s+/)[0], title: null, line: i + 1, query: false },
    );
  });
  return out;
}
