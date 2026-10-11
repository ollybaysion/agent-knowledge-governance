import { skillDataIds } from "../src/skill-data-ids.mjs";
import { listIds, readJson } from "./store.mjs";

/**
 * Data id → the stored domain-skill that has it, over every skill except
 * `selfId` and the archived ones. Read on each call: skills are few.
 * @returns {Map<string, string>}
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
      if (!owners.has(item.id)) owners.set(item.id, id);
  }
  return owners;
}
