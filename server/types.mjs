// The document type list: code types (a schema and a renderer in this repo)
// plus md types an admin registers. store/types.json holds the order and the
// registered types; while it is absent the defaults below are the list.
import { readJson, revOfPath } from "./store.mjs";

export const TYPES_PATH = "types.json";
export const RENDERED_TYPES_PATH = "rendered/types.json";

export const CODE_TYPES = [
  { id: "db-schema", label: "DB 스키마", color: "#3f7d8a" },
  { id: "msg-format", label: "설비 커맨드", color: "#e8a55a" },
  { id: "domain-skill", label: "에이전트", color: "#4657cf" },
  { id: "domain", label: "도메인", color: "#4f6d8a" },
  { id: "screen-map", label: "화면", color: "#b05a8a" },
  { id: "manual", label: "매뉴얼", color: "#8a5fbf" },
  { id: "fab-line", label: "라인", color: "#7a6a4f" },
];

export const UNCLASSIFIED = { id: "unclassified", label: "미분류", color: "#8a8f98" };

const DEFAULT_REGISTERED = [
  { id: "voc", label: "VOC", color: "#4e9a5a", status: "active" },
];

export const TYPE_ID_RE = /^[a-z][a-z0-9-]*$/;
export const COLOR_RE = /^#[0-9a-f]{6}$/;

// Route words and store folders a type id would collide with.
export const RESERVED_TYPE_IDS = new Set([
  "types",
  "docs",
  "assets",
  "audit",
  "score",
  "proposals",
  "graph",
  "order",
  "rendered",
  "md",
  "common",
]);

const CODE_IDS = new Set(CODE_TYPES.map((t) => t.id));

export function isBuiltinTypeId(id) {
  return CODE_IDS.has(id) || id === UNCLASSIFIED.id;
}

/** store/types.json as stored, or the defaults when the file is absent. */
export function readTypesFile(storeDir) {
  const file = readJson(storeDir, TYPES_PATH);
  if (file) return { rev: revOfPath(storeDir, TYPES_PATH), file };
  return {
    rev: null,
    file: {
      order: [...CODE_TYPES.map((t) => t.id), ...DEFAULT_REGISTERED.map((t) => t.id)],
      registered: DEFAULT_REGISTERED.map((t) => ({ ...t })),
    },
  };
}

function entry(t, kind, builtin) {
  return {
    id: t.id,
    label: t.label,
    color: t.color,
    ...(t.description ? { description: t.description } : {}),
    kind,
    builtin,
    status: t.status ?? "active",
  };
}

/**
 * The types in order, without counts. A code type the file does not name
 * (added by a later release) goes after the named ones; unclassified is last.
 */
export function typeEntries(file) {
  const byId = new Map();
  for (const t of CODE_TYPES) byId.set(t.id, entry(t, "structured", true));
  for (const t of file.registered ?? []) {
    if (!isBuiltinTypeId(t.id)) byId.set(t.id, entry(t, "md", false));
  }
  const out = [];
  const seen = new Set();
  for (const id of file.order ?? []) {
    if (byId.has(id) && !seen.has(id)) {
      out.push(byId.get(id));
      seen.add(id);
    }
  }
  for (const [id, t] of byId) if (!seen.has(id)) out.push(t);
  out.push(entry(UNCLASSIFIED, "md", true));
  return out;
}

/**
 * GET /api/types: {rev, types[]} with each type's non-archived document count.
 * @param {(type: string) => number} countOf the catalog's count
 */
export function listTypes(storeDir, countOf) {
  const { rev, file } = readTypesFile(storeDir);
  return {
    rev,
    types: typeEntries(file).map((t) => ({ ...t, count: countOf(t.id) })),
  };
}

const stableJson = (obj) => JSON.stringify(obj, null, 2) + "\n";

/** The writes one change to the type list commits: the store file and its copy for mirrors. */
export function typesWrites(file) {
  return [
    { relpath: TYPES_PATH, content: stableJson(file) },
    { relpath: RENDERED_TYPES_PATH, content: stableJson({ types: typeEntries(file) }) },
  ];
}

export function isMdType(storeDir, type) {
  return typeEntries(readTypesFile(storeDir).file).some((t) => t.id === type && t.kind === "md");
}

/** What the routes read: app.akg.types. */
export function createTypes(storeDir, refs) {
  const entries = () => typeEntries(readTypesFile(storeDir).file);
  const get = (id) => entries().find((t) => t.id === id) ?? null;
  return {
    /** @param {{count: (type: string) => number}} catalog */
    list: (catalog) => listTypes(storeDir, catalog.count),
    entries,
    get,
    ids: () => entries().map((t) => t.id),
    mdIds: () => entries().filter((t) => t.kind === "md").map((t) => t.id),
    isMd: (id) => get(id)?.kind === "md",
    isActive: (id) => get(id)?.status === "active",
    isArchived: (id) => get(id)?.status === "archived",
    /** The body schema of a listed type; null for anything else. */
    bodySchema(id) {
      const t = get(id);
      if (!t) return null;
      return refs[`${id}/v1`] ?? (t.kind === "md" ? refs["md/v1"] : null) ?? null;
    },
  };
}
