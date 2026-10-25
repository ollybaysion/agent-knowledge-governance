// What every screen reads: who is signed in, the type list, the FE address,
// and the page's own address parameters (?embed · ?from · ?section).
import { api } from "./api.mjs";
import { acceptFrom, answerIdOf } from "/lib/from-url.mjs";

export const THEME_KEY = "akg_theme";
export let currentUser = null; // {id, group, logout}
export let csrfToken = null; // the shared session's CSRF token, from /api/me
export let lastDoc = null; // {type, id} — the doc the 문서 · 그래프 tabs come back to

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
export let TYPES_REV = null;
export let DOC_TYPES = TYPES.map((t) => t.id);
export let TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
export const typeInfo = (type) => TYPES.find((t) => t.id === type) ?? null;
export const isMdType = (type) => typeInfo(type)?.kind === "md";
export const activeMdTypes = () => TYPES.filter((t) => t.kind === "md" && t.status === "active");
export const typeColor = (type) => typeInfo(type)?.color ?? "#8a8f98";
export async function loadTypes() {
  const r = await api("/api/types");
  if (!r.ok || !Array.isArray(r.data?.types)) return;
  setTypes(r.data);
}
export function setTypes({ types, rev }) {
  TYPES = types;
  TYPES_REV = rev ?? null;
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
export const isAdmin = () => currentUser?.group === "admin";
/** Writes to a document (PUT · links · role · status) are admin's, as the server has them; FE's drawer (?embed=1) only reads. */
export const canEdit = () => isAdmin() && !embed;
/** 타입 없이 올리기 is open to every person who writes. */
export const canUpload = () => currentUser?.group === "admin" || currentUser?.group === "user";

// GET /api/config: the FE address. Null until boot reads it.
export let feUrl = null;
export function setConfig(config) {
  feUrl = typeof config?.feUrl === "string" && config.feUrl ? config.feUrl.replace(/\/$/, "") : null;
  const q = new URLSearchParams(location.search);
  from = acceptFrom(q.get("from"), feUrl);
  answerId = q.get("answer") || (from ? answerIdOf(from) : null);
}

const query = new URLSearchParams(location.search);
/** ?embed=1: only the body column, for FE's drawer iframe. */
export const embed = query.get("embed") === "1";
/** ?section=<절 제목>: the section the FE answer used. */
export const answerSection = query.get("section") || null;
/** ?from=<FE 답 주소>: kept only when it starts with the FE address. */
export let from = null;
export let answerId = null;
