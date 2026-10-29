// The stored documents as the list routes read them, in memory: one
// projection per document file, read once at boot and changed by each commit
// (store.onCommit). The list, the tag panel, the type counts, backlinks and
// the link and [[ ]] checks read this instead of every document file — a
// store of 10,000 documents is 50 MB of JSON.
import { parseWikilinks, wikiTexts } from "../src/wikilinks.mjs";
import { coverageOf } from "../src/table-class.mjs";
import { tierSummary } from "./slots.mjs";
import { listIds, onCommit, readJson } from "./store.mjs";

// The types whose markdown the list reads (an active one's 조회 make a table 주요).
const AGENT_TYPES = ["domain-skill", "domain"];

const NONE = Object.freeze([]);
const listOf = (xs) => (Array.isArray(xs) && xs.length ? xs : NONE);

/**
 * The name people know a document by, for the dashboard's search: a manual's
 * title, a screen's name, a skill's name, a table, a command.
 */
export function titleOf(doc) {
  const b = doc.body ?? {};
  return b.title ?? b.name ?? b.table ?? b.command ?? null;
}

/**
 * What the catalog keeps of one document. Field by field:
 * keywords · tags · links · status · origin · role as stored; tiers the slot
 * counts; title {@link titleOf}; assetCount the length of assets[];
 * wikis the body's `[[ ]]`, unresolved; absorbed the sidecar's mark.
 * db-schema only: kind · unusedColumns · table as in body, coverage
 * {@link coverageOf}, columns the catalog's column names ({@link columnsOf}).
 * domain-skill and domain only: markdown.
 */
function project(type, id, doc, bodySchema, absorbed) {
  const body = doc.body;
  const entry = {
    id,
    status: doc.status,
    tiers: tierSummary(bodySchema, body),
    keywords: doc.keywords ?? NONE,
    tags: doc.tags ?? NONE,
    assetCount: (doc.assets ?? NONE).length,
    links: doc.links ?? NONE,
    title: titleOf(doc),
    origin: doc.origin,
    role: doc.role,
    wikis: listOf(parseWikilinks(wikiTexts(type, body))),
    absorbed,
  };
  if (type === "db-schema") {
    entry.kind = body?.kind;
    entry.unusedColumns = body?.unusedColumns;
    entry.table = body?.table ?? doc.id;
    entry.coverage = coverageOf(body);
    // One string, not an array: 6,000 tables' names cost ~6 MB as arrays, ~2 MB as strings.
    entry.columns = (body?.catalog?.columns ?? NONE).map((c) => c.name).join("\n");
  }
  if (AGENT_TYPES.includes(type) && typeof body?.markdown === "string") entry.markdown = body.markdown;
  return entry;
}

/** A db-schema entry's column names as the list serves them. */
export const columnsOf = (entry) => (entry.columns ? entry.columns.split("\n") : []);

const readOrNull = (storeDir, relpath) => {
  try {
    return readJson(storeDir, relpath);
  } catch {
    return null;
  }
};

const DOC_FILE = /^([^/]+)\/([^/]+?)(\.meta)?\.json$/;

/**
 * @param {string} storeDir
 * @param {{ids: () => string[], bodySchema: (type: string) => object | null}} types
 */
export function createCatalog(storeDir, types) {
  const byType = new Map(); // type -> {schema, entries: Map<id, entry>, order: string[] | null}
  const linkedFrom = new Map(); // "type/id" -> Set of "type/id" whose links[] name it

  const unlink = (type, entry) => {
    for (const l of entry.links) linkedFrom.get(`${l.type}/${l.id}`)?.delete(`${type}/${entry.id}`);
  };
  const link = (type, entry) => {
    for (const l of entry.links) {
      const key = `${l.type}/${l.id}`;
      if (!linkedFrom.has(key)) linkedFrom.set(key, new Set());
      linkedFrom.get(key).add(`${type}/${entry.id}`);
    }
  };

  // Reads one document and its sidecar again; a file gone or unreadable leaves the catalog.
  function put(type, slot, id) {
    const before = slot.entries.get(id);
    if (before) unlink(type, before);
    const doc = readOrNull(storeDir, `${type}/${id}.json`);
    let entry = null;
    if (doc) {
      try {
        entry = project(type, id, doc, slot.schema, readOrNull(storeDir, `${type}/${id}.meta.json`)?.absorbed);
      } catch {
        entry = null;
      }
    }
    if (entry) {
      slot.entries.set(id, entry);
      link(type, entry);
    } else slot.entries.delete(id);
    if (!before !== !entry) slot.order = null;
  }

  function loadType(type) {
    const schema = types.bodySchema(type);
    if (!schema) return null;
    const slot = { schema, entries: new Map(), order: null };
    byType.set(type, slot);
    for (const id of listIds(storeDir, type)) put(type, slot, id);
    return slot;
  }
  // A type registered after boot is read the first time it is asked for.
  const slotOf = (type) => byType.get(type) ?? loadType(type);

  function refresh(touched) {
    const changed = new Map(); // type -> Set<id>
    for (const relpath of touched) {
      const m = DOC_FILE.exec(relpath);
      if (!m || !byType.has(m[1])) continue;
      if (!changed.has(m[1])) changed.set(m[1], new Set());
      changed.get(m[1]).add(m[2]);
    }
    for (const [type, ids] of changed) for (const id of ids) put(type, byType.get(type), id);
  }

  /** The type's document ids in listIds order. */
  function ids(type) {
    const slot = slotOf(type);
    if (!slot) return NONE;
    slot.order ??= [...slot.entries.keys()]
      .map((id) => `${id}.json`)
      .sort()
      .map((f) => f.slice(0, -".json".length));
    return slot.order;
  }

  const stop = onCommit(storeDir, refresh);

  return {
    /** Reads every listed type's documents; returns how many. */
    load() {
      let n = 0;
      for (const t of types.ids()) n += slotOf(t)?.entries.size ?? 0;
      return n;
    },
    ids,
    /** The projections of a type's documents in listIds order. */
    entries(type) {
      const slot = slotOf(type);
      return slot ? ids(type).map((id) => slot.entries.get(id)) : NONE;
    },
    get: (type, id) => slotOf(type)?.entries.get(id) ?? null,
    /** Whether `type/id.json` is in the store; a file of a non-document type is looked up on disk. */
    exists(type, id) {
      const slot = slotOf(type);
      return slot ? slot.entries.has(id) : !!readOrNull(storeDir, `${type}/${id}.json`);
    },
    /** The stored status of `type/id`, or null when there is no such document. */
    statusOf(type, id) {
      const slot = slotOf(type);
      if (slot) return slot.entries.get(id)?.status ?? null;
      return readOrNull(storeDir, `${type}/${id}.json`)?.status ?? null;
    },
    /** The type's documents that are not archived. */
    count(type) {
      let n = 0;
      for (const e of slotOf(type)?.entries.values() ?? NONE) if (e.status !== "archived") n += 1;
      return n;
    },
    /**
     * The documents whose links[] name type/id, as [type, id] pairs: by
     * `typeIds` order, then listIds order.
     */
    linkers(typeIds, type, id) {
      const byLinker = new Map(); // type -> ids
      for (const key of linkedFrom.get(`${type}/${id}`) ?? NONE) {
        const slash = key.indexOf("/");
        const t = key.slice(0, slash);
        if (!byLinker.has(t)) byLinker.set(t, []);
        byLinker.get(t).push(`${key.slice(slash + 1)}.json`);
      }
      const out = [];
      for (const t of typeIds)
        for (const f of byLinker.get(t)?.sort() ?? NONE) out.push([t, f.slice(0, -".json".length)]);
      return out;
    },
    /** The active domain-skill and domain documents with their markdown, as agentRegistry lists them. */
    agents() {
      const out = [];
      for (const type of AGENT_TYPES)
        for (const e of this.entries(type))
          if (e.status === "active" && e.markdown !== undefined) out.push({ type, id: e.id, markdown: e.markdown });
      return out;
    },
    close: stop,
  };
}
