// The sidebar's people-search: filters the document list envelopes the
// dashboard already fetched (/api/docs?type=), in the browser. No DOM here, so
// node tests it directly (test/client/search.test.mjs).

/** The text a document is found by: id, every keyword, and its title. */
function haystack(doc) {
  return [doc.id, ...(doc.keywords ?? []).map((k) => k.kw), doc.title ?? ""]
    .join("\n")
    .toLowerCase();
}

/**
 * Documents matching every whitespace-separated term of `q` (case-insensitive
 * substring of id · keywords · title), limited to `types` when it is
 * non-empty, grouped by type in `order`. An empty query with no type chosen
 * matches nothing — the caller shows its tree instead.
 * @param {{type: string, id: string, keywords?: {kw: string}[], title?: string|null}[]} docs
 * @param {{q?: string, types?: string[], order: string[]}} opts
 * @returns {{type: string, docs: object[]}[]}
 */
export function searchDocs(docs, { q = "", types = [], order }) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0 && types.length === 0) return [];
  const byType = new Map(order.map((t) => [t, []]));
  for (const doc of docs) {
    if (types.length && !types.includes(doc.type)) continue;
    const text = haystack(doc);
    if (!terms.every((t) => text.includes(t))) continue;
    byType.get(doc.type)?.push(doc);
  }
  return [...byType]
    .filter(([, list]) => list.length)
    .map(([type, list]) => ({ type, docs: list.sort((a, b) => a.id.localeCompare(b.id)) }));
}
