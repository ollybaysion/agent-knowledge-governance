// The envelope's links[] (json-spec §2): only the forward edge is stored. The
// reverse is derived on read by scanning the store, so there is no second copy
// that can drift from the first.
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
