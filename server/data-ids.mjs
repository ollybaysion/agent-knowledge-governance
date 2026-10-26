import { skillDataIds } from "../src/skill-data-ids.mjs";
import { coverageOf, tableUses } from "../src/table-class.mjs";
import { listIds, readJson } from "./store.mjs";

// The types whose md carries a ## 데이터 section the consumer reads.
const DATA_ID_TYPES = ["domain-skill", "domain"];

/**
 * Data id → the stored domain-skill or domain document that has it and
 * whether its item is a query, over every such document except
 * `selfType/selfId` (any type when `selfType` is absent) and the archived
 * ones. A query owner wins over a question owner of the same id. Read on each
 * call: skills are few.
 * @returns {Map<string, {doc: string, query: boolean}>}
 */
export function dataIdOwners(storeDir, selfId, selfType = null) {
  const owners = new Map();
  for (const type of DATA_ID_TYPES) {
    for (const id of listIds(storeDir, type)) {
      if (id === selfId && (selfType === null || selfType === type)) continue;
      let doc;
      try {
        doc = readJson(storeDir, `${type}/${id}.json`);
      } catch {
        continue;
      }
      if (!doc || doc.status === "archived" || typeof doc.body?.markdown !== "string") continue;
      for (const item of skillDataIds(doc.body.markdown))
        if (!owners.has(item.id) || (item.query && !owners.get(item.id).query))
          owners.set(item.id, { doc: id, query: item.query });
    }
  }
  return owners;
}

/**
 * Table → the 조회 of the active domain-skill and domain documents that read
 * it ({@link tableUses}). Read on each call, like dataIdOwners.
 */
export function activeTableUses(storeDir) {
  const docs = [];
  for (const type of DATA_ID_TYPES) {
    for (const id of listIds(storeDir, type)) {
      let doc;
      try {
        doc = readJson(storeDir, `${type}/${id}.json`);
      } catch {
        continue;
      }
      if (doc?.status === "active") docs.push({ type, id, markdown: doc.body?.markdown });
    }
  }
  return tableUses(docs);
}

/** A db-schema document's 주요 · 쓰는 조회 · 확정 커버리지, as the list and the doc view carry them. */
export function tableClassOf(doc, uses) {
  const usedBy = uses.get(String(doc.body?.table ?? doc.id).toUpperCase()) ?? [];
  return { major: usedBy.length > 0, usedBy, coverage: coverageOf(doc.body) };
}
