// SVG as a stored picture. It is text, so there is no magic number: the root
// element is the fact, and its width · height (or viewBox) is the size.
//
// An SVG can also carry script. Two guards, one here and one at the door:
// svgProblems refuses the constructs that run code or reach outside the file
// before anything is stored, and the asset route serves every SVG under a
// sandbox CSP (server/routes/assets.mjs) for the reader who opens the address
// directly. An <img> never runs an SVG's script either way.

export const SVG_MEDIA_TYPE = "image/svg+xml";

const NS = "http://www.w3.org/2000/svg";
// Prolog, comments and a plain DOCTYPE may come before the root tag.
const ROOT = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:(?:<!--[\s\S]*?-->|<!DOCTYPE[^>[]*>)\s*)*<svg((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*\/?>/i;

/** The text when the bytes look like an SVG document, else null. */
function svgText(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 11) return null;
  // First byte that is not BOM or whitespace must open a tag.
  let i = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i += 1;
  if (buf[i] !== 0x3c) return null;
  const text = buf.toString("utf8");
  return text.includes("\u0000") || text.includes("�") ? null : text;
}

const attrOf = (attrs, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  return m ? (m[1] ?? m[2]) : null;
};

// A plain number or px. Percent and em have no pixel size of their own.
const px = (v) => {
  const m = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/.exec(v ?? "");
  return m ? Number(m[1]) : null;
};

/**
 * Format and pixel size of an SVG, read from its root tag: width · height
 * when both are plain numbers, else the viewBox (one given side scales the
 * other by the viewBox ratio).
 * @returns {{mediaType: string, width: number, height: number} | null} null when not an SVG or without a size
 */
export function svgHead(buf) {
  const text = svgText(buf);
  const root = text && ROOT.exec(text);
  if (!root) return null;
  const attrs = root[1];
  let width = px(attrOf(attrs, "width"));
  let height = px(attrOf(attrs, "height"));
  const box = /^\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*$/.exec(attrOf(attrs, "viewBox") ?? "");
  if (box) {
    const [bw, bh] = [Number(box[1]), Number(box[2])];
    if (width === null && height === null) [width, height] = [bw, bh];
    else if (width === null && bh > 0) width = (height * bw) / bh;
    else if (height === null && bw > 0) height = (width * bh) / bw;
  }
  if (width === null || height === null) return null;
  return { mediaType: SVG_MEDIA_TYPE, width: Math.round(width), height: Math.round(height) };
}

// What an address inside the file may point at: its own parts, or bytes it
// carries itself (a raster picture or a font). Anything else leaves the file.
const INSIDE = /^(?:#|data:(?:image\/(?:png|jpeg|webp|gif)|font\/[a-z0-9]+|application\/(?:x-)?font-[a-z0-9]+)[;,])/i;
const REFUSED_ELEMENTS = new Set(["script", "foreignobject", "iframe", "embed", "object", "audio", "video", "handler", "listener"]);
// One well-formed start tag: a name, then quoted attributes only (XML has no other kind).
const TAG = /<([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// What is not a start tag and may hold a "<": comments, CDATA, the prolog, a plain DOCTYPE, end tags.
const NOT_TAGS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*>|<\/[A-Za-z_][\w:.-]*\s*>/gi;

const local = (name) => name.slice(name.indexOf(":") + 1).toLowerCase();
const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
// Character references as the browser reads them, so a spelled-out `&#106;avascript:` is seen.
const decoded = (s) =>
  s.replace(/&#(x[0-9a-f]+|\d+);?/gi, (all, n) => {
    const code = n[0] === "x" || n[0] === "X" ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });

/**
 * Why an SVG is refused, one line each; empty when it may be stored.
 * Refused: code (script, on* attributes, javascript: addresses), a document
 * inside the picture (foreignObject and the embedding elements), entity
 * declarations, every address that leaves the file (href · src · CSS url() ·
 * @import), and any tag this reader cannot take apart — what it cannot read
 * it cannot vouch for.
 * @returns {string[]}
 */
export function svgProblems(buf) {
  const raw = svgText(buf);
  if (raw === null) return ["SVG 글자로 읽지 못했습니다"];
  const problems = [];
  const root = ROOT.exec(raw);
  if (root && attrOf(root[1], "xmlns") !== NS) problems.push(`뿌리 <svg> 에 xmlns="${NS}" 가 없습니다`);
  if (/<!ENTITY/i.test(raw)) problems.push("ENTITY 선언이 있습니다");

  const outside = new Set();
  const elements = new Set();
  const handlers = new Set();
  const body = raw.replace(NOT_TAGS, " ");
  for (const tag of body.matchAll(TAG)) {
    if (REFUSED_ELEMENTS.has(local(tag[1]))) elements.add(tag[1]);
    for (const attr of tag[2].matchAll(ATTR)) {
      const name = local(attr[1]);
      if (name.startsWith("on")) handlers.add(attr[1]);
      if (name === "href" || name === "src") {
        const target = decoded(attr[2] ?? attr[3]).trim();
        if (!INSIDE.test(target)) outside.add(clip(target));
      }
    }
  }
  if (body.replace(TAG, " ").includes("<")) problems.push("읽지 못한 태그가 있습니다");
  for (const name of elements) problems.push(`<${name}> 요소가 있습니다`);
  for (const name of handlers) problems.push(`이벤트 속성이 있습니다: ${name}`);

  const text = decoded(raw);
  if (/javascript:/i.test(text.replace(/[\s\u0000-\u001f]+/g, ""))) problems.push("javascript: 주소가 있습니다");
  if (/@import/i.test(text)) problems.push("CSS @import 가 있습니다");
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gi)) {
    const target = (m[1] ?? m[2] ?? m[3]).trim();
    if (!INSIDE.test(target)) outside.add(clip(target));
  }
  for (const target of outside) problems.push(`파일 밖을 가리키는 주소가 있습니다: ${target}`);
  return problems;
}
