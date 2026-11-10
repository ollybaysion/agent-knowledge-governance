// 정리(curation): what the curator (fdc-agent-be-spring, role `curator`)
// leaves in the store, and what a person decides about it.
//
// - 중복 후보: store/curation/duplicates/<key>.json, one file per pair of
//   documents. The key is the two addresses sorted: `<type>~<id>~<type>~<id>`.
//   `~` is in no type id and no document id, so the key splits back.
// - 흡수 기록: store/curation/absorptions/<uuid>.json, one file per absorption
//   the curator applied.
//
// Both live in the git store like proposals/: each change is a commit, so the
// 감사 log shows who opened, dismissed, resolved or reverted what.
import { isValidId, listIds, readJson } from "./store.mjs";
import { TYPE_ID_RE } from "./types.mjs";

export const PAIRS_DIR = "curation/duplicates";
export const ABSORPTIONS_DIR = "curation/absorptions";

export const PAIR_STATUSES = ["open", "dismissed", "resolved"];
export const ABSORPTION_STATUSES = ["applied", "reverted"];

/** Most pairs one POST /api/curation/duplicates takes. */
export const PAIRS_MAX = 500;
/** Longest summary an absorption record keeps. */
export const SUMMARY_MAX = 1000;

const REV_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[\w.:-]{1,64}$/;
const KEY_RE = /^([a-z][a-z0-9-]*)~([a-z0-9._-]+)~([a-z][a-z0-9-]*)~([a-z0-9._-]+)$/;

export const stableJson = (obj) => JSON.stringify(obj, null, 2) + "\n";
export const pairPath = (key) => `${PAIRS_DIR}/${key}.json`;
export const absorptionPath = (id) => `${ABSORPTIONS_DIR}/${id}.json`;

const addr = (d) => `${d.type}/${d.id}`;
const isRev = (v) => typeof v === "string" && REV_RE.test(v);
const isScore = (v) => typeof v === "number" && Number.isFinite(v) && v >= -1 && v <= 1;

/** One line of text: control characters and runs of space become one space. */
function oneLine(raw, max) {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
}

/** The pair's two sides in key order: the smaller `type/id` first. */
export function sortPair(x, y) {
  return addr(x) <= addr(y) ? [x, y] : [y, x];
}

/** `<type>~<id>~<type>~<id>` of two documents, sorted. */
export function pairKey(x, y) {
  const [a, b] = sortPair(x, y);
  return `${a.type}~${a.id}~${b.type}~${b.id}`;
}

/** The two addresses a key names, or null when it is not a key. */
export function parseKey(key) {
  const m = typeof key === "string" ? KEY_RE.exec(key) : null;
  if (!m || key.includes("..")) return null;
  const a = { type: m[1], id: m[2] };
  const b = { type: m[3], id: m[4] };
  if (addr(a) >= addr(b)) return null; // not sorted, or the same document twice
  return { a, b };
}

const docRef = (raw, revKeys) => {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.type !== "string" || !TYPE_ID_RE.test(raw.type) || !isValidId(raw.id)) return null;
  const out = { type: raw.type, id: raw.id };
  for (const k of revKeys) {
    if (!isRev(raw[k])) return null;
    out[k] = raw[k];
  }
  return out;
};

/**
 * POST /api/curation/duplicates's body → {runId, model, pairs: [{key, a, b, score}]}
 * with each pair's sides in key order, or {error, rejected?} for a body to refuse.
 */
export function readPairsBody(body) {
  const runId = body?.runId;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return { error: "invalid_run_id" };
  const model = oneLine(body?.model, 200);
  if (!model) return { error: "invalid_model" };
  const raw = body?.pairs;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PAIRS_MAX) return { error: "pairs_required" };
  const pairs = [];
  const rejected = [];
  const seen = new Set();
  raw.forEach((p, index) => {
    const x = docRef(p?.a, ["rev"]);
    const y = docRef(p?.b, ["rev"]);
    if (!x || !y) return rejected.push({ index, error: "invalid_doc" });
    if (addr(x) === addr(y)) return rejected.push({ index, error: "same_doc" });
    if (!isScore(p.score)) return rejected.push({ index, error: "invalid_score" });
    const key = pairKey(x, y);
    if (seen.has(key)) return rejected.push({ index, key, error: "duplicate_in_request" });
    seen.add(key);
    const [a, b] = sortPair(x, y);
    pairs.push({ index, key, a, b, score: p.score });
  });
  if (rejected.length) return { error: "pairs_rejected", rejected };
  return { runId, model, pairs };
}

/**
 * The stored pair after one sighting, and what happened to it:
 * `opened` (new, or a decided pair whose documents changed since the
 * decision), `updated` (open, seen again), `kept` (decided, and both
 * documents are at the revs the person decided on — the file stays).
 * @returns {{outcome: "opened"|"updated"|"kept", pair: object | null}} pair null for kept
 */
export function sightPair(stored, seen, { runId, model, at }) {
  const sighting = { a: seen.a, b: seen.b, score: seen.score, model, runId, seenAt: at };
  if (!stored) return { outcome: "opened", pair: { key: seen.key, ...sighting, status: "open", firstSeenAt: at } };
  if (stored.status === "open") return { outcome: "updated", pair: { ...stored, ...sighting } };
  const revs = stored.decision?.revs;
  if (revs && revs.a === seen.a.rev && revs.b === seen.b.rev) return { outcome: "kept", pair: null };
  const { decision: _old, ...rest } = stored;
  return { outcome: "opened", pair: { ...rest, ...sighting, status: "open" } };
}

/**
 * The writes that close the pairs naming `type/id` once the document leaves
 * that address (deleted, or retyped to another type): each such pair not yet
 * resolved becomes `resolved` with `reason`. Read inside the write queue.
 */
export function pairsLeaving(storeDir, type, id, { by, at, reason }) {
  const writes = [];
  for (const key of listIds(storeDir, PAIRS_DIR)) {
    const sides = parseKey(key);
    if (!sides) continue;
    const names = (d) => d.type === type && d.id === id;
    if (!names(sides.a) && !names(sides.b)) continue;
    const pair = readJson(storeDir, pairPath(key));
    if (!pair || pair.status === "resolved") continue;
    writes.push({
      relpath: pairPath(key),
      content: stableJson({ ...pair, status: "resolved", decision: { status: "resolved", by, at, reason } }),
    });
  }
  return writes;
}

/**
 * POST /api/curation/absorptions's body → the record's fields, or {error, param?}.
 */
export function readAbsorptionBody(body) {
  const runId = body?.runId;
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return { error: "invalid_run_id" };
  const model = oneLine(body?.model, 200);
  if (!model) return { error: "invalid_model" };
  const source = docRef(body?.source, ["rev"]);
  if (!source) return { error: "invalid_doc", param: "source" };
  const target = docRef(body?.target, ["fromRev", "toRev"]);
  if (!target) return { error: "invalid_doc", param: "target" };
  if (addr(source) === addr(target)) return { error: "same_doc" };
  if (target.fromRev === target.toRev) return { error: "same_rev", param: "target" };
  const summary = oneLine(body?.summary, SUMMARY_MAX);
  if (!summary) return { error: "invalid_summary", max: SUMMARY_MAX };
  if (body.score !== undefined && !isScore(body.score)) return { error: "invalid_score" };
  return { runId, model, source, target, summary, ...(body.score !== undefined ? { score: body.score } : {}) };
}
