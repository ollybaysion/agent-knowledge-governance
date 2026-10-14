// The envelope's links[] (json-spec §2): only the forward edge is stored. The
// reverse is derived on read by scanning the store, so there is no second copy
// that can drift from the first.
import { parseWikilinks, wikiTexts } from "../src/wikilinks.mjs";
import { listIds, readJson } from "./store.mjs";

const docPath = (link) => `${link.type}/${link.id}.json`;

/** Links whose target document is not in the store. An archived target still counts as present. */
export function missingLinkTargets(storeDir, links = []) {
  return links
    .filter((link) => !readJson(storeDir, docPath(link)))
    .map(({ type, id }) => ({ type, id }));
}

/** The doc's own links, each with the target's current status. */
export function resolveLinks(storeDir, links = []) {
  return links.map((link) => ({
    ...link,
    status: readJson(storeDir, docPath(link))?.status ?? "missing",
  }));
}

/** Every stored document of `types` that links to type/id, with the linking doc's status. */
export function backlinksOf(storeDir, types, type, id) {
  const out = [];
  for (const t of types) {
    for (const sid of listIds(storeDir, t)) {
      const doc = readJson(storeDir, `${t}/${sid}.json`);
      for (const link of doc?.links ?? []) {
        if (link.type === type && link.id === id)
          out.push({ type: t, id: sid, rel: link.rel, status: doc.status });
      }
    }
  }
  return out;
}

// ---- `[[ ]]` in the body (src/wikilinks.mjs) ----
// A bare [[id]] is looked up in every type; found in two or more it cannot be
// resolved, and a write names those so the author can write [[type/id]].

/**
 * Each `[[ ]]` of the doc's body with where it points: {text, type, id, found},
 * plus `types` when a bare id is in more than one type (found false then).
 * A `[[ ]]` naming the doc itself is found but never becomes a link.
 */
export function resolveWikilinks(storeDir, types, type, doc) {
  return parseWikilinks(wikiTexts(type, doc.body)).map(({ text, type: t, id }) => {
    if (id === null) return { text, type: null, id: null, found: false };
    const exists = (tt) => !!readJson(storeDir, docPath({ type: tt, id }));
    if (t !== null) return { text, type: t, id, found: types.includes(t) && exists(t) };
    const hits = types.filter(exists);
    if (hits.length === 1) return { text, type: hits[0], id, found: true };
    return hits.length > 1
      ? { text, type: null, id, found: false, types: hits }
      : { text, type: null, id, found: false };
  });
}

const edgeKey = (l) => `${l.type}/${l.id}#${l.rel}`;

/** The links[] a doc's body contributes: found targets, rel related, not itself. */
function bodyLinks(wikis, type, id) {
  return wikis
    .filter((w) => w.found && !(w.type === type && w.id === id))
    .map((w) => ({ type: w.type, id: w.id, rel: "related" }));
}

/**
 * The links[] a type always carries, whatever the author lists: a golden set
 * points at the skill it scores (same id), so the skill screen finds it as a
 * backlink.
 */
function typeLinks(type, doc) {
  if (type === "golden-set" && typeof doc.id === "string")
    return [{ type: "domain-skill", id: doc.id, rel: "skill" }];
  return [];
}

// links sits before body, the order json-spec §2 lists the keys in; an empty
// list drops the key.
export function withLinks(doc, links) {
  const { links: _old, body, ...head } = doc;
  return links.length ? { ...head, links, body } : { ...head, body };
}

/**
 * The doc to store after a write, its links[] recomputed from the body:
 * (handLinks − what the previous body contributed) ∪ the type's own links ∪
 * what this body contributes. `handLinks` defaults to the doc's own links[]; PUT …/links
 * passes the list it received instead. Returns {error} when a bare [[id]] is
 * ambiguous.
 */
export function mergeBodyLinks(storeDir, types, type, prevDoc, doc, handLinks = doc.links ?? []) {
  // A links value the validator is about to reject is left for it to report.
  if (!Array.isArray(handLinks)) return { doc };
  const wikis = resolveWikilinks(storeDir, types, type, doc);
  const ambiguous = wikis.filter((w) => w.types);
  if (ambiguous.length)
    return {
      error: {
        error: "ambiguous_link_target",
        message: `여러 타입에 같은 id 가 있습니다 — [[타입/id]] 로 적으세요: ${ambiguous
          .map((w) => `[[${w.text}]] (${w.types.join(" · ")})`)
          .join(", ")}`,
        targets: ambiguous.map((w) => ({ text: w.text, types: w.types })),
      },
    };
  const before = prevDoc
    ? new Set(bodyLinks(resolveWikilinks(storeDir, types, type, prevDoc), type, prevDoc.id).map(edgeKey))
    : new Set();
  const kept = handLinks.filter((l) => !before.has(edgeKey(l)));
  const keptKeys = new Set(kept.map(edgeKey));
  const added = [...typeLinks(type, doc), ...bodyLinks(wikis, type, doc.id)].filter((l) => {
    if (keptKeys.has(edgeKey(l))) return false;
    keptKeys.add(edgeKey(l));
    return true;
  });
  return { doc: withLinks(doc, [...kept, ...added]) };
}
