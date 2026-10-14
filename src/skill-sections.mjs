// The `##` sections of a skill md, shared by the server's validator and the
// dashboard's section editor (served as /skill-sections.mjs) — so the editor
// splits a document exactly where the validator sees its sections. No node
// imports: this file runs in the browser as it is.

// The consumer's heading schema (fdc-agent-be-spring SkillMarkdownTool), in
// the order a document is assembled in. `heading` is what a new section is
// written as; a section that already exists keeps the heading it was written
// with.
export const SKILL_SECTIONS = [
  { key: "한 줄 설명", heading: "한 줄 설명" },
  { key: "언제 호출되는가", heading: "언제 호출되는가?" },
  { key: "도메인 지식", heading: "도메인 지식" },
  { key: "데이터", heading: "데이터" },
  // main only: the questions the agent is scored against (src/verify-set.mjs).
  { key: "답변 품질 검증 Set", heading: "답변 품질 검증 Set" },
];
const KEYS = new Set(SKILL_SECTIONS.map((s) => s.key));

/** A trailing `?`/`:` is noise, as it is for the consumer. */
export const normalizeHeading = (title) =>
  title.trim().replace(/[?？:：\s]+$/u, "").trim();

export const isSkillSection = (title) => KEYS.has(normalizeHeading(title));

/**
 * Each line with the `##` heading it opens (null otherwise), and whether it
 * belongs to a fenced code block (``` or ~~~, the fence lines included). A
 * `##` inside a fence is text, not a heading.
 */
export function scan(markdown) {
  const out = [];
  let fence = null;
  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    let heading = null;
    const fenced = fence !== null || f !== null;
    if (fence === null && f) fence = f[1];
    else if (fence !== null && line.trim().startsWith(fence)) fence = null;
    else if (fence === null) heading = /^##\s+(.*?)\s*#*\s*$/.exec(line)?.[1] ?? null;
    out.push({ line, heading, fenced });
  }
  return out;
}

/** The `##` headings of a markdown text, skipping fenced code blocks. */
export function skillSections(markdown) {
  return scan(markdown)
    .filter((l) => l.heading !== null)
    .map((l) => l.heading);
}

export class SkillSplitError extends Error {}

const trimBlankLines = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b).join("\n");
};

/**
 * Split a skill md into its `# title` line and the sections of `order`
 * (SKILL_SECTIONS by default), in that order (a missing one has body ""). Refuses — throws
 * SkillSplitError — what the section editor could not give back unchanged: an
 * unknown or repeated `##` section, or text before the first section other
 * than the `# title` line.
 * @returns {{title: string|null, sections: {key: string, heading: string, body: string}[]}}
 */
export function splitSkill(markdown, order = SKILL_SECTIONS) {
  const keys = new Set(order.map((s) => s.key));
  let title = null;
  const pre = [];
  const found = new Map(); // key -> {heading, lines}
  let current = null;
  for (const { line, heading } of scan(markdown)) {
    if (heading !== null) {
      const key = normalizeHeading(heading);
      if (!keys.has(key)) throw new SkillSplitError(`모르는 절입니다 — "## ${heading}"`);
      if (found.has(key)) throw new SkillSplitError(`같은 절이 두 번 있습니다 — "## ${heading}"`);
      current = { heading, lines: [] };
      found.set(key, current);
    } else if (current) {
      current.lines.push(line);
    } else if (title === null && /^#\s+/.test(line) && pre.every((l) => l.trim() === "")) {
      title = line.replace(/^#\s+/, "").trim();
    } else {
      pre.push(line);
    }
  }
  if (pre.some((l) => l.trim() !== ""))
    throw new SkillSplitError("첫 ## 절 앞에 # 제목 줄 밖의 글이 있습니다");
  return {
    title,
    sections: order.map(({ key, heading }) => {
      const f = found.get(key);
      return { key, heading: f?.heading ?? heading, body: f ? trimBlankLines(f.lines) : "" };
    }),
  };
}

/**
 * The inverse of splitSkill: `# title`, then each non-empty section in
 * `order`, blank-line separated, one trailing newline. An empty section is
 * left out of the document.
 */
export function joinSkill(title, sections, order = SKILL_SECTIONS) {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const parts = [`# ${title}`];
  for (const { key, heading } of order) {
    const s = byKey.get(key);
    const body = trimBlankLines(String(s?.body ?? "").split(/\r?\n/));
    if (body !== "") parts.push(`## ${s.heading ?? heading}`, body);
  }
  return parts.join("\n\n") + "\n";
}
