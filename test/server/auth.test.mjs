import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadUsers,
  saveUsers,
  authenticate,
  hasRole,
  hashToken,
  generateToken,
  AuthBootError,
  recordAuthFailure,
  isRateLimited,
} from "../../server/auth.mjs";

function freshUsersFile(users) {
  const dir = mkdtempSync(join(tmpdir(), "akg-auth-test-"));
  const path = join(dir, "users.json");
  saveUsers(path, users);
  return path;
}

test("loadUsers refuses to boot when the file is missing (S1)", () => {
  assert.throws(() => loadUsers("/nonexistent/users.json"), AuthBootError);
});

test("loadUsers refuses to boot when users.json has zero users (S1)", () => {
  const path = freshUsersFile([]);
  assert.throws(() => loadUsers(path), AuthBootError);
});

test("loadUsers refuses to boot when the file is group/world readable", () => {
  const path = freshUsersFile([
    { id: "a", role: "viewer", tokenHash: hashToken("x") },
  ]);
  chmodSync(path, 0o644);
  assert.throws(() => loadUsers(path), AuthBootError);
});

test("loadUsers succeeds for a well-formed 0600 file with at least one user", () => {
  const path = freshUsersFile([
    { id: "renoir", role: "approver", tokenHash: hashToken("secret") },
  ]);
  const users = loadUsers(path);
  assert.equal(users.length, 1);
  assert.equal(users[0].id, "renoir");
});

test("authenticate matches the right user by token and rejects wrong tokens", () => {
  const token = generateToken();
  const users = [
    { id: "renoir", role: "approver", tokenHash: hashToken(token) },
    { id: "other", role: "viewer", tokenHash: hashToken("different") },
  ];
  assert.equal(authenticate(users, token)?.id, "renoir");
  assert.equal(authenticate(users, "not-a-real-token"), null);
  assert.equal(authenticate(users, ""), null);
});

test("authenticate rejects an expired token", () => {
  const token = generateToken();
  const users = [
    {
      id: "renoir",
      role: "approver",
      tokenHash: hashToken(token),
      expiresAt: "2020-01-01T00:00:00Z",
    },
  ];
  assert.equal(
    authenticate(users, token, { now: Date.parse("2026-01-01T00:00:00Z") }),
    null,
  );
});

test("hasRole: viewer/editor/approver form a ladder; approver satisfies a viewer-only route", () => {
  assert.equal(hasRole({ role: "approver" }, ["viewer"]), true);
  assert.equal(hasRole({ role: "editor" }, ["approver"]), false);
  assert.equal(hasRole({ role: "viewer" }, ["editor", "approver"]), false);
});

test("hasRole: agent is NOT on the ladder — only passes when explicitly named (D6)", () => {
  assert.equal(hasRole({ role: "agent" }, ["agent", "editor"]), true);
  assert.equal(hasRole({ role: "agent" }, ["viewer"]), false);
  assert.equal(hasRole({ role: "agent" }, ["editor", "approver"]), false);
});

test("rate limiting trips after repeated failures and is independent per key", () => {
  const key = `test-${Date.now()}-${Math.random()}`;
  for (let i = 0; i < 19; i++) recordAuthFailure(key);
  assert.equal(isRateLimited(key), false);
  recordAuthFailure(key);
  assert.equal(isRateLimited(key), true);
  assert.equal(isRateLimited(`${key}-other`), false);
});
