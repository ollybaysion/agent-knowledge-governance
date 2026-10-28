// The pictures an md body shows: ![글](주소). A picture is the store's alone —
// ![글](asset:<sha256>), the sha256 one of the document's assets[]. The
// envelope check (src/envelope.mjs) reads them with mdImages, akg push swaps
// a local file's address for asset:<sha256> with replaceImageSrc; the reading
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
 * Every picture outside fences and code spans, line by line.
 * @param {(text: string, i: number, pics: RegExpMatchArray[]) => void} onLine
 *   i = 0-based line; each match's index is its place in `text`
 */
function eachLine(markdown, onLine) {
  const lines = String(markdown ?? "").split("\n");
  let fence = null;
  lines.forEach((text, i) => {
    if (fence) {
      if (text.trim().startsWith(fence)) fence = null;
      onLine(text, i, []);
      return;
    }
    const f = FENCE.exec(text);
    if (f) {
      fence = f[1];
      onLine(text, i, []);
      return;
    }
    // Code spans blanked to spaces of the same length: the indexes stay the text's.
    const bare = text.replace(CODE_SPAN, (s) => " ".repeat(s.length));
    onLine(text, i, [...bare.matchAll(IMAGE)]);
  });
  return lines;
}

/**
 * @param {string} markdown
 * @returns {{line: number, alt: string, src: string, sha256: string|null}[]}
 *   line: the md line, 1-based; sha256 null when src is not asset:<sha256>
 */
export function mdImages(markdown) {
  const out = [];
  eachLine(markdown, (_, i, pics) => {
    for (const m of pics) out.push({ line: i + 1, alt: m[1], src: m[2], sha256: assetRef(m[2]) });
  });
  return out;
}

/**
 * The md with each picture's address as `swap({alt, src})` says; null or
 * undefined keeps it. Everything else stays byte for byte.
 */
export function replaceImageSrc(markdown, swap) {
  const out = [];
  eachLine(markdown, (text, _, pics) => {
    let line = text;
    for (const m of pics.reverse()) {
      const src = swap({ alt: m[1], src: m[2] });
      if (src == null) continue;
      line = `${line.slice(0, m.index)}![${m[1]}](${src})${line.slice(m.index + m[0].length)}`;
    }
    out.push(line);
  });
  return out.join("\n");
}
