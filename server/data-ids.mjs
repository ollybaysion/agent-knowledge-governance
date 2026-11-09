import { flowSubgraphIds } from "../src/envelope.mjs";
import { skillDataIds } from "../src/skill-data-ids.mjs";
import { coverageOf } from "../src/table-class.mjs";
import { listIds, readJson } from "./store.mjs";

// The agent mds: the documents whose 조회 count for 주요 · 쓰는 조회 and the flow check.
const AGENT_TYPES = ["domain-skill", "domain"];
// The types whose md carries a ## 데이터 section the consumer reads: one query
// id across all of them.
const DATA_ID_TYPES = [...AGENT_TYPES, "starter"];

/**
 * Add one document's names to `owners`: its data ids, and for an agent md its
 * flow fence's subgraph ids and its own name ({@link dataIdOwners}). A
 * starter document holds data ids only.
 */
export function addOwner(owners, id, markdown, type = "domain-skill") {
  const add = (name, kind) => owners.set(name, [...(owners.get(name) ?? []), { doc: id, kind }]);
  for (const item of skillDataIds(markdown)) add(item.id, "data");
  if (!AGENT_TYPES.includes(type)) return owners;
  for (const sub of new Set(flowSubgraphIds(markdown))) add(sub, "subgraph");
  add(id, "md");
  return owners;
}

/**
 * Name → the stored domain-skill, domain and starter documents that hold it
 * and as what (a data id, a subgraph id, the document's own name), over every
 * such document except `selfType/selfId` (any type when `selfType` is absent)
 * and the archived ones. Read on each call: skills are few.
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
      addOwner(owners, id, doc.body.markdown, type);
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
  for (const type of AGENT_TYPES) {
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

/** A db-schema document's 주요 · 쓰는 조회 · 확정 커버리지, as the list and the doc view carry them. */
export function tableClassOf(doc, uses) {
  return tableClass(doc.body?.table ?? doc.id, coverageOf(doc.body), uses);
}

/** {@link tableClassOf} from the table name and the coverage, as the catalog keeps them. */
export function tableClass(table, coverage, uses) {
  const usedBy = uses.get(String(table).toUpperCase()) ?? [];
  return { major: usedBy.length > 0, usedBy, coverage };
}

/**
 * Table (upper case) → the `kind` of its active db-schema document, undefined
 * when the document has none. A table missing from the map has no active
 * document. The consumer reads the active db-schema documents only.
 * @param {{entries: (type: string) => {status: string, table: string, kind?: string}[]}} catalog
 * @returns {Map<string, string|undefined>}
 */
export function tableKinds(catalog) {
  const out = new Map();
  for (const e of catalog.entries("db-schema")) if (e.status === "active") out.set(String(e.table).toUpperCase(), e.kind);
  return out;
}
