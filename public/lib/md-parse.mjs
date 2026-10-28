// The md the reading view draws: blocks (headings · paragraphs · lists ·
// fenced code · tables · quotes · rules · a picture alone on its line) and
// the inline runs inside them (`code` · **bold** · [[id]] · [text](https://…)
// · ![글](asset:<sha256>)). A picture is the store's alone; another address
// stays text. No DOM here; node tests it.

const FENCE = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(asset:([0-9a-f]{64})\)\s*$/;

const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/**
 * @returns {({type: "h", level: number, text: string, line: number}
 *   | {type: "p" | "quote", text: string, line: number}
 *   | {type: "ul" | "ol", items: string[], line: number}
 *   | {type: "code", lang: string, text: string, line: number}
 *   | {type: "table", head: string[], rows: string[][], line: number}
 *   | {type: "img", alt: string, sha256: string, line: number}
 *   | {type: "hr", line: number})[]}
 */
export function parseBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      const body = [];
      const start = i;
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(f[1])) body.push(lines[i++]);
      i++;
      out.push({ type: "code", lang: f[2] || "", text: body.join("\n"), line: start });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ type: "h", level: h[1].length, text: h[2], line: i });
      i++;
      continue;
    }
    const img = IMAGE_LINE.exec(line);
    if (img) {
      out.push({ type: "img", alt: img[1], sha256: img[2], line: i });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: "hr", line: i });
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const start = i;
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") rows.push(cells(lines[i++]));
      out.push({ type: "table", head, rows, line: start });
      continue;
    }
    const list = BULLET.exec(line) ? "ul" : NUMBERED.exec(line) ? "ol" : null;
    if (list) {
      const re = list === "ul" ? BULLET : NUMBERED;
      const items = [];
      const start = i;
      while (i < lines.length) {
        const m = re.exec(lines[i]);
        if (m) {
          items.push(m[2]);
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      out.push({ type: list, items, line: start });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      const start = i;
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push({ type: "quote", text: body.join(" "), line: start });
      continue;
    }
    const body = [];
    const start = i;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !NUMBERED.test(lines[i]) &&
      !IMAGE_LINE.test(lines[i])
    )
      body.push(lines[i++].trim());
    out.push({ type: "p", text: body.join(" "), line: start });
  }
  return out;
}

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[\[[^[\]\n]+?\]\])|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(!\[([^\]\n]*)\]\(asset:([0-9a-f]{64})\))/g;

/**
 * Inline runs: {text} plain, {code}, {bold}, {wiki: inner}, {link: text, href},
 * {img: sha256, alt}. Only http(s) addresses become links.
 */
export function inlineRuns(text) {
  const s = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) });
    if (m[1]) out.push({ code: m[1].slice(1, -1) });
    else if (m[2]) out.push({ bold: m[2].slice(2, -2) });
    else if (m[3]) out.push({ wiki: m[3].slice(2, -2).trim() });
    else if (m[6]) out.push({ img: m[8], alt: m[7] });
    else out.push({ link: m[4].slice(1, m[4].indexOf("](")), href: m[5] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ text: s.slice(last) });
  return out;
}
