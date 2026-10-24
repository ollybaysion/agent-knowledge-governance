import { api } from "./api.mjs";

export const THEME_KEY = "akg_theme";
/** 왼쪽 트리에서 접어 둔 갈래 — 트리를 다시 그려도(저장 · 이동 · 새로고침) 접힌 채로 둔다. */
export const TREE_FOLD_KEY = "akg_tree_closed";
export function closedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(TREE_FOLD_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
export function setGroupClosed(type, closed) {
  const set = closedGroups();
  if (closed) set.add(type);
  else set.delete(type);
  localStorage.setItem(TREE_FOLD_KEY, JSON.stringify([...set]));
}
export let currentUser = null; // {id, group, logout}
export let csrfToken = null; // the shared session's CSRF token, from /api/me
export let lastDoc = null; // {type, id} — for the "문서" nav tab

// The type list in order (GET /api/types), loaded at boot. These defaults are
// the server's list while it has no store/types.json.
export let TYPES = [
  { id: "db-schema", label: "DB 스키마", color: "#3f7d8a", kind: "structured", status: "active" },
  { id: "msg-format", label: "설비 커맨드", color: "#e8a55a", kind: "structured", status: "active" },
  { id: "domain-skill", label: "에이전트", color: "#4657cf", kind: "structured", status: "active" },
  { id: "screen-map", label: "화면", color: "#b05a8a", kind: "structured", status: "active" },
  { id: "manual", label: "매뉴얼", color: "#8a5fbf", kind: "structured", status: "active" },
  { id: "fab-line", label: "라인", color: "#7a6a4f", kind: "structured", status: "active" },
  { id: "voc", label: "VOC", color: "#4e9a5a", kind: "md", status: "active" },
  { id: "unclassified", label: "미분류", color: "#8a8f98", kind: "md", status: "active" },
];
export let DOC_TYPES = TYPES.map((t) => t.id);
export let TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
export const typeInfo = (type) => TYPES.find((t) => t.id === type) ?? null;
export const isMdType = (type) => typeInfo(type)?.kind === "md";
export const activeMdTypes = () => TYPES.filter((t) => t.kind === "md" && t.status === "active");
export async function loadTypes() {
  const r = await api("/api/types");
  if (!r.ok || !Array.isArray(r.data?.types)) return;
  TYPES = r.data.types;
  DOC_TYPES = TYPES.map((t) => t.id);
  TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
}
export const TIER_LABEL = {
  scaffold: "빈칸",
  inferred: "추정",
  confirmed: "확정",
  deprecated: "폐기",
};
export const TIER_ABBR = {
  scaffold: "sc",
  inferred: "inf",
  confirmed: "conf",
  deprecated: "dep",
};

export function setLastDoc(v) {
  lastDoc = v;
}
export function setUser(user, csrf) {
  currentUser = user;
  csrfToken = csrf;
}
