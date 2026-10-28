// The pictures an md body shows: ![글](주소). A picture is the store's alone —
// ![글](asset:<sha256>), the sha256 one of the document's assets[]. The
// envelope check (src/envelope.mjs) reads them with mdImages; the reading
// view parses the same syntax (public/lib/md-parse.mjs). Fenced code and
// `inline code` hold no pictures.

const FENCE = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/;
const IMAGE = /!\[([^\]\n]*)\]\(([^)\s]*)\)/g;
const CODE_SPAN = /`[^`\n]+`/g;

/** asset:<sha256> → the sha256; anything else → null. */
export function assetRef(src) {
  const m = /^asset:([0-9a-f]{64})$/.exec(String(src ?? ""));
  return m ? m[1] : null;
}

/**
 * @param {string} markdown
 * @returns {{line: number, alt: string, src: string, sha256: string|null}[]}
 *   line: the md line, 1-based; sha256 null when src is not asset:<sha256>
 */
export function mdImages(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  lines.forEach((text, i) => {
    if (fence) {
      if (text.trim().startsWith(fence)) fence = null;
      return;
    }
    const f = FENCE.exec(text);
    if (f) {
      fence = f[1];
      return;
    }
    const bare = text.replace(CODE_SPAN, (s) => " ".repeat(s.length));
    for (const m of bare.matchAll(IMAGE)) out.push({ line: i + 1, alt: m[1], src: m[2], sha256: assetRef(m[2]) });
  });
  return out;
}
