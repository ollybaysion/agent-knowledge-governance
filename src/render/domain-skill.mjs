// domain-skill/v1 body { name, markdown } -> SKILL.md.
//
// The document is the author's md, stored verbatim (user decision 2026-09-21:
// one authoring format, and the consumer — fdc-agent-be-spring — already reads
// that md). So there is nothing to synthesize: rendering is the frontmatter
// Claude Code's skill discovery needs (name, description) followed by the text
// as written. The description is the first paragraph under `## 한 줄 설명`,
// which is what that section is for; a document without one falls back to the
// name so the frontmatter stays well-formed.
//
// Schema validation (unknown keys, `\S`, known `##` sections) is the caller's
// job via envelope.mjs — this module only renders.

/** The first non-empty line under `## 한 줄 설명`, or null when there is none. */
export function skillSummary(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  let inSummary = false;
  for (const line of lines) {
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      inSummary = h[1].length === 2 && /^한 줄 설명[?？:：\s]*$/.test(h[2].trim());
      continue;
    }
    if (inSummary && line.trim() !== "") return line.trim();
  }
  return null;
}

function frontmatter(body) {
  return [
    "---",
    `name: ${body.name}`,
    "disable-model-invocation: true",
    "description: >-",
    `  ${skillSummary(body.markdown) ?? body.name}`,
    "---",
  ].join("\n");
}

export function renderDomainSkillMd(doc) {
  const body = doc.body;
  return `${frontmatter(body)}\n\n${String(body.markdown).replace(/\s+$/, "")}\n`;
}
