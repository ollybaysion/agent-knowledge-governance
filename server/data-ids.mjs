import { skillDataIds } from "../src/skill-data-ids.mjs";
import { listIds, readJson } from "./store.mjs";

/**
 * Data id → the stored domain-skill that has it and whether its item is a
 * query, over every skill except `selfId` and the archived ones. A query
 * owner wins over a question owner of the same id. Read on each call: skills
 * are few.
 * @returns {Map<string, {doc: string, query: boolean}>}
 */
export function dataIdOwners(storeDir, selfId) {
  const owners = new Map();
  for (const id of listIds(storeDir, "domain-skill")) {
    if (id === selfId) continue;
    let doc;
    try {
      doc = readJson(storeDir, `domain-skill/${id}.json`);
    } catch {
      continue;
    }
    if (!doc || doc.status === "archived" || typeof doc.body?.markdown !== "string") continue;
    for (const item of skillDataIds(doc.body.markdown))
      if (!owners.has(item.id) || (item.query && !owners.get(item.id).query))
        owners.set(item.id, { doc: id, query: item.query });
  }
  return owners;
}
