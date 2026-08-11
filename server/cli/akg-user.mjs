#!/usr/bin/env node
// User/token management CLI (design §D6). Operates directly on users.json —
// no server round trip needed since this file IS the auth state.
import { existsSync } from "node:fs";
import {
  hashToken,
  generateToken,
  saveUsers,
  loadUsers,
  ROLES,
} from "../auth.mjs";

const USERS_PATH = process.env.AKG_USERS_PATH ?? "./.akg-data/users.json";
const DEFAULT_EXPIRY_DAYS = 90; // S14

// An absent file is an empty user list — that is the bootstrap case, and the
// first `add` legitimately creates it. A file that EXISTS but will not load is
// not empty, and must never be treated as such: every caller below follows
// this with saveUsers(), so returning [] would silently replace all existing
// users with whatever the current command produces. On a shared server that is
// every colleague's token gone at once, with no copy anywhere (users.json is
// the one piece of state outside git). The likeliest trigger is mundane — a
// deploy step or an editor leaving the file 0644, which loadUsers rejects.
function readUsers(path) {
  if (!existsSync(path)) return [];
  try {
    return loadUsers(path);
  } catch (err) {
    throw new Error(
      `${path}을(를) 읽지 못했습니다 — 그대로 진행하면 기존 사용자가 전부 사라지므로 중단합니다.\n` +
        `  원인: ${err.message}\n` +
        `  권한 문제라면: chmod 600 ${path} 후 다시 실행하세요.`,
    );
  }
}

function cmdAdd(id, role, { expiresDays = DEFAULT_EXPIRY_DAYS } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`알 수 없는 역할: ${role} (허용: ${ROLES.join(", ")})`);
  }
  const users = readUsers(USERS_PATH).filter((u) => u.id !== id);
  const token = generateToken();
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + expiresDays * 86400000,
  ).toISOString();
  users.push({
    id,
    role,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt,
  });
  saveUsers(USERS_PATH, users);
  console.log(`발급됨 — id=${id} role=${role} expiresAt=${expiresAt}`);
  console.log(`토큰(다시 표시되지 않습니다): ${token}`);
}

function cmdRevoke(id) {
  const users = readUsers(USERS_PATH);
  const next = users.filter((u) => u.id !== id);
  if (next.length === users.length) {
    console.log(`${id} 없음 — 변경 없음`);
    return;
  }
  saveUsers(USERS_PATH, next);
  console.log(`회수됨 — id=${id}`);
}

function cmdList() {
  const users = readUsers(USERS_PATH);
  for (const u of users) {
    console.log(`${u.id}\t${u.role}\texpiresAt=${u.expiresAt ?? "-"}`);
  }
  if (users.length === 0) console.log("(사용자 없음)");
}

const [, , cmd, ...rest] = process.argv;
// Refusals from readUsers() are operator-facing instructions ("chmod 600 …"),
// not crashes — print the message and exit nonzero rather than dumping a stack
// trace that buries it.
function run(fn) {
  try {
    fn();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (cmd === "add") {
  run(() => cmdAdd(rest[0], rest[1]));
} else if (cmd === "revoke") {
  run(() => cmdRevoke(rest[0]));
} else if (cmd === "list") {
  run(cmdList);
} else {
  console.error("사용법: akg-user.mjs add <id> <role> | revoke <id> | list");
  console.error(`  role ∈ ${ROLES.join(", ")}`);
  console.error(
    `  users.json 경로는 AKG_USERS_PATH 환경변수(기본 ./.akg-data/users.json)`,
  );
  process.exit(1);
}
