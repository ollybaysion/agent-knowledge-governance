// users.json — the one non-git state (design §D2, §D6). fail-closed by
// design (§11 S1): missing/empty/unreadable users.json must refuse server
// boot, never silently run with auth off the way the observability server's
// loopback-trust model does.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export class AuthBootError extends Error {}

const ROLES = ["viewer", "editor", "approver", "agent"];
const RANK = { viewer: 1, editor: 2, approver: 3 }; // agent is intentionally not on this ladder (D6)

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken() {
  return randomBytes(24).toString("hex");
}

/**
 * Load + validate users.json. Throws AuthBootError (caller should refuse to
 * start the server) if the file is missing, empty, unreadable, or has 0600
 * permissions violated in a way that leaks tokens to other local users.
 */
export function loadUsers(path) {
  if (!existsSync(path)) {
    throw new AuthBootError(
      `${path} 없음 — users.json 없이는 기동하지 않습니다(S1)`,
    );
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new AuthBootError(
      `${path}의 권한이 ${mode.toString(8)}입니다 — 0600이어야 합니다(그룹/기타 사용자에게 토큰 해시가 읽힘)`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AuthBootError(`${path} 파싱 실패: ${err.message}`);
  }
  const users = parsed?.users;
  if (!Array.isArray(users) || users.length === 0) {
    throw new AuthBootError(`${path}에 사용자가 0명입니다 — 기동 거부(S1)`);
  }
  for (const u of users) {
    if (!u.id || !ROLES.includes(u.role) || !u.tokenHash) {
      throw new AuthBootError(
        `${path}: 유효하지 않은 사용자 항목 ${JSON.stringify(u)}`,
      );
    }
  }
  return users;
}

export function saveUsers(path, users) {
  writeFileSync(path, JSON.stringify({ users }, null, 2) + "\n", {
    mode: 0o600,
  });
}

function isExpired(user, now) {
  return user.expiresAt != null && new Date(user.expiresAt).getTime() <= now;
}

function safeEqualHex(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** @returns the matching, non-expired user, or null. */
export function authenticate(users, token, { now = Date.now() } = {}) {
  if (!token) return null;
  const hash = hashToken(token);
  let found = null;
  // Compare against every user (not early-return) so auth latency doesn't
  // leak which position in the list matched.
  for (const u of users) {
    if (safeEqualHex(hash, u.tokenHash) && !isExpired(u, now)) found = u;
  }
  return found;
}

/** allowed: role names a route accepts. viewer/editor/approver form a ladder
 * (higher rank satisfies a lower requirement); agent is a separate bucket
 * that only ever passes when explicitly named in `allowed` (D6). */
export function hasRole(user, allowed) {
  if (allowed.includes(user.role)) return true;
  const userRank = RANK[user.role];
  if (userRank === undefined) return false;
  return allowed.some((r) => RANK[r] !== undefined && RANK[r] <= userRank);
}

// S14: naive in-memory failed-auth rate limit, per process (single-process
// server per D7 — a multi-instance deployment would need shared state, out
// of Phase 1 rehearsal scope).
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 20;
const failuresByKey = new Map(); // key -> timestamps[]

export function recordAuthFailure(key, { now = Date.now() } = {}) {
  const arr = (failuresByKey.get(key) ?? []).filter(
    (t) => now - t < FAIL_WINDOW_MS,
  );
  arr.push(now);
  failuresByKey.set(key, arr);
}

export function isRateLimited(key, { now = Date.now() } = {}) {
  const arr = (failuresByKey.get(key) ?? []).filter(
    (t) => now - t < FAIL_WINDOW_MS,
  );
  return arr.length >= FAIL_LIMIT;
}

export function clearAuthFailures(key) {
  failuresByKey.delete(key);
}

export { ROLES };
