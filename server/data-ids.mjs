import { flowSubgraphIds } from "../src/envelope.mjs";
import { skillDataIds } from "../src/skill-data-ids.mjs";
import { coverageOf, tableUses } from "../src/table-class.mjs";
import { listIds, readJson } from "./store.mjs";

// The types whose md carries a ## 데이터 section the consumer reads.
const DATA_ID_TYPES = ["domain-skill", "domain"];

/**
 * Add one skill's names to `owners`: its data ids, its flow fence's subgraph
 * ids and its own name ({@link dataIdOwners}).
 */
export function addOwner(owners, id, markdown) {
  const add = (name, kind) => owners.set(name, [...(owners.get(name) ?? []), { doc: id, kind }]);
  for (const item of skillDataIds(markdown)) add(item.id, "data");
  for (const sub of new Set(flowSubgraphIds(markdown))) add(sub, "subgraph");
  add(id, "md");
  return owners;
}

/**
 * Name → the stored domain-skill and domain documents that hold it and as
 * what (a data id, a subgraph id, the document's own name), over every such
 * document except `selfType/selfId` (any type when `selfType` is absent) and
 * the archived ones. Read on each call: skills are few.
 * @returns {Map<string, {doc: string, kind: "data"|"subgraph"|"md"}[]>}
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
      addOwner(owners, id, doc.body.markdown);
    }
  }
  return owners;
}

/**
 * The active domain-skill and domain documents — the agent mds the consumer
 * registers, in store order. Read on each call, like dataIdOwners.
 * @returns {{type: string, id: string, markdown: string}[]}
 */
export function agentRegistry(storeDir) {
  const out = [];
  for (const type of DATA_ID_TYPES) {
    for (const id of listIds(storeDir, type)) {
      let doc;
      try {
        doc = readJson(storeDir, `${type}/${id}.json`);
      } catch {
        continue;
      }
      if (doc?.status === "active" && typeof doc.body?.markdown === "string") out.push({ type, id, markdown: doc.body.markdown });
    }
  }
  return out;
}

/**
 * Table → the 조회 of the active domain-skill and domain documents that read
 * it ({@link tableUses}). Read on each call, like dataIdOwners.
 */
export function activeTableUses(storeDir) {
  return tableUses(agentRegistry(storeDir));
}

/** A db-schema document's 주요 · 쓰는 조회 · 확정 커버리지, as the list and the doc view carry them. */
export function tableClassOf(doc, uses) {
  return tableClass(doc.body?.table ?? doc.id, coverageOf(doc.body), uses);
}

/** {@link tableClassOf} from the table name and the coverage, as the catalog keeps them. */
export function tableClass(table, coverage, uses) {
  const usedBy = uses.get(String(table).toUpperCase()) ?? [];
  return { major: usedBy.length > 0, usedBy, coverage };
}
