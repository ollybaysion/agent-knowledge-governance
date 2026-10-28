// A document's tags on the screen: the rule a typed tag must meet (the same
// as the envelope's, src/envelope.mjs TAG_PATTERN · TAGS_MAX) and the tag
// panel's rows. No DOM here; node tests it.

export const TAG_RE = /^[a-z0-9-]{1,32}$/;
export const TAGS_MAX = 20;

/**
 * The tags after one typed tag is added: trimmed and lower-cased. → {tags}
 * (the same list when it is there already) or {error} for the reader.
 */
export function addTag(tags, typed) {
  const tag = String(typed ?? "").trim().toLowerCase();
  if (!TAG_RE.test(tag)) return { error: "태그는 영문 소문자 · 숫자 · - 로 1~32 자입니다" };
  if (tags.includes(tag)) return { tags };
  if (tags.length >= TAGS_MAX) return { error: `태그는 문서마다 ${TAGS_MAX} 개까지입니다` };
  return { tags: [...tags, tag] };
}

/** GET /api/tags's {tag: count} as panel rows: the most used first, then by name; `q` keeps the names that hold it. */
export function tagRows(counts, q = "") {
  const want = String(q).trim().toLowerCase();
  return Object.entries(counts ?? {})
    .filter(([tag]) => !want || tag.includes(want))
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** The rows that carry `tag`. */
export const withTag = (docs, tag) => docs.filter((d) => (d.tags ?? []).includes(tag));
