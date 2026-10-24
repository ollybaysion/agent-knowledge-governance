// Identity = { id, group }, the same record BE puts in the shared session
// (fdc.identity). group ∈ admin · user · agent. Permission checks look at the
// group only — where the identity came from (Keycloak or the password file)
// never enters them.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { parse } from "yaml";

export class AuthBootError extends Error {}

const GROUPS = ["admin", "user", "agent"];
const RANK = { user: 1, admin: 2 }; // agent is intentionally not on this ladder (D6)

const digest = (text) => createHash("sha256").update(text, "utf8").digest();
const text = (value) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
};

/**
 * The per-person password file (YAML), same rules as BE's UserSource: a
 * missing, empty, or group/other-readable file refuses boot (S1).
 * @returns {{id: string, group: string, digest: Buffer}[]}
 */
export function loadUserFile(path) {
  if (!path) {
    throw new AuthBootError(
      "FDC_AUTH_USERS_FILE 이 비었습니다 — Keycloak issuer 도 비면 비밀번호 파일이 있어야 뜹니다",
    );
  }
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new AuthBootError(`${path} 이 없습니다 — 비밀번호 파일 없이는 뜨지 않습니다`);
  }
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new AuthBootError(
      `${path} 의 권한이 ${mode.toString(8)} 입니다 — 0600 이어야 합니다(다른 사용자가 비밀번호를 읽습니다)`,
    );
  }
  let root;
  try {
    root = parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new AuthBootError(`${path} 을 읽지 못했습니다: ${err.message}`);
  }
  const users = root?.users;
  if (!Array.isArray(users) || users.length === 0) {
    throw new AuthBootError(`${path} 에 users 가 없습니다 — 뜨지 않습니다`);
  }
  const ids = new Set();
  return users.map((row) => {
    const id = text(row?.id);
    const password = text(row?.password);
    if (id == null || password == null || ids.has(id)) {
      throw new AuthBootError(
        `${path} 의 사용자 줄이 틀렸습니다(id · password 가 비었거나 id 가 겹침): id=${id}`,
      );
    }
    ids.add(id);
    const group = text(row?.group)?.toLowerCase();
    if (!GROUPS.includes(group)) {
      throw new AuthBootError(
        `${path} 의 ${id} 줄: group 은 ${GROUPS.join(" · ")} 가운데 하나입니다: ${row?.group}`,
      );
    }
    return { id, group, digest: digest(password) };
  });
}

/**
 * The agent line whose password is `password`. Compares against every line —
 * which line matched must not show in the response time. Digests are all
 * SHA-256, so the lengths are equal.
 * @returns {{id: string, group: "agent"} | null}
 */
export function matchAgent(entries, password) {
  if (!password) return null;
  const given = digest(password);
  let found = null;
  for (const e of entries) {
    if (timingSafeEqual(given, e.digest) && e.group === "agent") found = e;
  }
  return found && { id: found.id, group: "agent" };
}

/** Keycloak client roles → group. Same order as BE's Group.ofClientRoles. */
export function groupOfClientRoles(roles) {
  if (roles.includes("admin")) return "admin";
  if (roles.includes("agent")) return "agent";
  return "user";
}

/** allowed: groups a route accepts. user/admin form a ladder (admin satisfies
 * a user requirement); agent is a separate bucket that only ever passes when
 * explicitly named in `allowed` (D6). */
export function hasGroup(identity, allowed) {
  if (allowed.includes(identity.group)) return true;
  const rank = RANK[identity.group];
  if (rank === undefined) return false;
  return allowed.some((g) => RANK[g] !== undefined && RANK[g] <= rank);
}

export function isIdentity(value) {
  return (
    typeof value?.id === "string" && value.id !== "" && GROUPS.includes(value.group)
  );
}

// S14: naive in-memory failed-auth rate limit, per process (single-process
// server per D7 — a multi-instance deployment would need shared state, out
// of Phase 1 rehearsal scope).
const FAIL_WINDOW_MS = 5 * 60 * 1000;
const FAIL_LIMIT = 20;
const FAIL_SWEEP_SIZE = 256;
const failuresByKey = new Map(); // key -> timestamps[]

export function recordAuthFailure(key, { now = Date.now() } = {}) {
  const arr = (failuresByKey.get(key) ?? []).filter(
    (t) => now - t < FAIL_WINDOW_MS,
  );
  arr.push(now);
  failuresByKey.set(key, arr);
  // One key per source address that ever failed: past this size, drop the
  // keys whose window has passed so the map does not only ever grow.
  if (failuresByKey.size > FAIL_SWEEP_SIZE) {
    for (const [k, times] of failuresByKey) {
      if (times.every((t) => now - t >= FAIL_WINDOW_MS)) failuresByKey.delete(k);
    }
  }
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

export { GROUPS };
