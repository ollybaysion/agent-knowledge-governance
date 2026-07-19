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

function readUsersOrEmpty(path) {
  if (!existsSync(path)) return [];
  try {
    return loadUsers(path);
  } catch {
    return []; // e.g. permission mismatch on a hand-edited file — let saveUsers fix it below
  }
}

function cmdAdd(id, role, { expiresDays = DEFAULT_EXPIRY_DAYS } = {}) {
  if (!ROLES.includes(role)) {
    throw new Error(`알 수 없는 역할: ${role} (허용: ${ROLES.join(", ")})`);
  }
  const users = readUsersOrEmpty(USERS_PATH).filter((u) => u.id !== id);
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
  const users = readUsersOrEmpty(USERS_PATH);
  const next = users.filter((u) => u.id !== id);
  if (next.length === users.length) {
    console.log(`${id} 없음 — 변경 없음`);
    return;
  }
  saveUsers(USERS_PATH, next);
  console.log(`회수됨 — id=${id}`);
}

function cmdList() {
  const users = readUsersOrEmpty(USERS_PATH);
  for (const u of users) {
    console.log(`${u.id}\t${u.role}\texpiresAt=${u.expiresAt ?? "-"}`);
  }
  if (users.length === 0) console.log("(사용자 없음)");
}

const [, , cmd, ...rest] = process.argv;
if (cmd === "add") {
  cmdAdd(rest[0], rest[1]);
} else if (cmd === "revoke") {
  cmdRevoke(rest[0]);
} else if (cmd === "list") {
  cmdList();
} else {
  console.error("사용법: akg-user.mjs add <id> <role> | revoke <id> | list");
  console.error(`  role ∈ ${ROLES.join(", ")}`);
  console.error(
    `  users.json 경로는 AKG_USERS_PATH 환경변수(기본 ./.akg-data/users.json)`,
  );
  process.exit(1);
}
