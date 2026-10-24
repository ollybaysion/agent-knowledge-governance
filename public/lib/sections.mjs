// An md as section blocks, for the reading view and the section editor.
// A skill splits on its five known `##` sections (src/skill-sections.mjs,
// passed in as `skill`) and joins back with joinSkill; any other md splits on
// every `##` and joins back byte for byte. No DOM here; node tests it.

/** Trim blank lines at both ends of a line list. */
function trimLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}

/**
 * @param {string} markdown
 * @param {{skill?: {splitSkill: Function, joinSkill: Function, scan: Function}, order?: object[]}} opts
 *   `skill` + `order` (the skill's sections) split a skill md; without them, `scan` from
 *   `skill` (or a plain line scan) splits on every `##`.
 * @returns {{mode: "skill"|"plain", title: string|null, head: string, blocks: {key: string, heading: string, body: string}[]}}
 *   Throws what splitSkill throws for a skill md it cannot split.
 */
export function splitBlocks(markdown, { skill = null, order = null } = {}) {
  const md = String(markdown ?? "");
  if (skill && order) {
    const { title, sections } = skill.splitSkill(md, order);
    return { mode: "skill", title, head: title === null ? "" : `# ${title}`, blocks: sections.map((s) => ({ ...s })) };
  }
  const rows = skill?.scan ? skill.scan(md) : plainScan(md);
  const head = [];
  const blocks = [];
  const seen = new Map();
  let cur = null;
  for (const { line, heading } of rows) {
    if (heading !== null) {
      const base = heading.trim();
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      cur = { key: n > 1 ? `${base}#${n}` : base, heading, lines: [] };
      blocks.push(cur);
    } else if (cur) cur.lines.push(line);
    else head.push(line);
  }
  const title = head.map((l) => /^#\s+(.*?)\s*#*\s*$/.exec(l)?.[1]).find((t) => t !== undefined) ?? null;
  return {
    mode: "plain",
    title,
    head: trimLines(head).join("\n"),
    blocks: blocks.map((b) => ({ key: b.key, heading: b.heading, body: trimLines(b.lines).join("\n") })),
  };
}

// The `##` lines outside fenced code, as src/skill-sections.mjs scan() gives them.
function plainScan(md) {
  const out = [];
  let fence = null;
  for (const line of md.split(/\r?\n/)) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    let heading = null;
    if (fence === null && f) fence = f[1];
    else if (fence !== null && line.trim().startsWith(fence)) fence = null;
    else if (fence === null) heading = /^##\s+(.*?)\s*#*\s*$/.exec(line)?.[1] ?? null;
    out.push({ line, heading });
  }
  return out;
}

/**
 * The md of a split, blocks possibly changed. A skill goes through
 * joinSkill; a plain md is the head, then each `## heading` and its body,
 * one blank line between, one trailing newline.
 */
export function joinBlocks(split, blocks = split.blocks, { skill = null, order = null } = {}) {
  if (split.mode === "skill") return skill.joinSkill(split.title ?? "", blocks, order);
  const parts = [];
  if (split.head !== "") parts.push(split.head);
  for (const b of blocks) {
    parts.push(`## ${b.heading}`);
    if (b.body.trim() !== "") parts.push(b.body);
  }
  return parts.join("\n\n") + "\n";
}

/** The md with only `key`'s body replaced: what 절 저장 sends. */
export function withBlock(split, key, body, opts = {}) {
  return joinBlocks(
    split,
    split.blocks.map((b) => (b.key === key ? { ...b, body } : b)),
    opts,
  );
}

/** The keys whose body differs between two block lists (same split). */
export function changedKeys(saved, edited) {
  const before = new Map(saved.map((b) => [b.key, b.body]));
  return edited.filter((b) => before.get(b.key) !== b.body).map((b) => b.key);
}

/**
 * Each block's line range in the joined md (1-based, heading line to last
 * body line). A skill block left empty is not in the md: its range is null.
 */
export function lineRanges(split, blocks = split.blocks, opts = {}) {
  const md = joinBlocks(split, blocks, opts);
  const lines = md.split("\n");
  const out = new Map();
  let at = 0;
  for (const b of blocks) {
    const h = `## ${b.heading}`;
    const start = lines.indexOf(h, at);
    if (start < 0 || (split.mode === "skill" && b.body.trim() === "")) {
      out.set(b.key, null);
      continue;
    }
    const bodyLines = b.body.trim() === "" ? 0 : b.body.split("\n").length;
    const end = bodyLines ? start + 2 + bodyLines - 1 : start;
    out.set(b.key, { from: start + 1, to: end + 1, bodyFrom: bodyLines ? start + 3 : start + 1 });
    at = end + 1;
  }
  return out;
}
