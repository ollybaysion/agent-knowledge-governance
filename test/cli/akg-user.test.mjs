// server/cli/akg-user.mjs writes users.json — the one piece of state that is
// not in git and has no other copy. These tests are about what happens when it
// cannot read the file it is about to replace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { saveUsers, hashToken } from "../../server/auth.mjs";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "server",
  "cli",
  "akg-user.mjs",
);

function run(usersPath, args) {
  return spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, AKG_USERS_PATH: usersPath },
  });
}

function freshUsersPath() {
  return join(mkdtempSync(join(tmpdir(), "akg-user-cli-test-")), "users.json");
}

function idsIn(path) {
  return JSON.parse(readFileSync(path, "utf8")).users.map((u) => u.id);
}

test("add bootstraps a missing users.json at 0600", () => {
  const path = freshUsersPath();
  const res = run(path, ["add", "alice", "approver"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(idsIn(path), ["alice"]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  rmSync(dirname(path), { recursive: true, force: true });
});

test("add keeps the users already there", () => {
  const path = freshUsersPath();
  run(path, ["add", "alice", "approver"]);
  const res = run(path, ["add", "bob", "editor"]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(idsIn(path).sort(), ["alice", "bob"]);
  rmSync(dirname(path), { recursive: true, force: true });
});

test("add refuses rather than wiping a users.json it cannot read", () => {
  const path = freshUsersPath();
  saveUsers(path, [
    { id: "alice", role: "approver", tokenHash: hashToken("t") },
    { id: "bob", role: "editor", tokenHash: hashToken("u") },
  ]);
  // Anything that leaves the file group/world-readable — a deploy step, an
  // editor, an unpacked backup — makes loadUsers reject it. Treating that as
  // "no users yet" would replace both of them with just carol.
  chmodSync(path, 0o644);

  const res = run(path, ["add", "carol", "editor"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /chmod 600/);
  assert.deepEqual(idsIn(path).sort(), ["alice", "bob"], "nothing was lost");

  // And the documented recovery actually works.
  chmodSync(path, 0o600);
  const after = run(path, ["add", "carol", "editor"]);
  assert.equal(after.status, 0, after.stderr);
  assert.deepEqual(idsIn(path).sort(), ["alice", "bob", "carol"]);

  rmSync(dirname(path), { recursive: true, force: true });
});

test("revoke refuses on the same unreadable file", () => {
  const path = freshUsersPath();
  saveUsers(path, [
    { id: "alice", role: "approver", tokenHash: hashToken("t") },
  ]);
  chmodSync(path, 0o644);
  const res = run(path, ["revoke", "alice"]);
  assert.equal(res.status, 1);
  assert.deepEqual(idsIn(path), ["alice"]);
  rmSync(dirname(path), { recursive: true, force: true });
});

test("saveUsers repairs permissions instead of leaving the server unbootable", () => {
  const path = freshUsersPath();
  saveUsers(path, [
    { id: "alice", role: "approver", tokenHash: hashToken("t") },
  ]);
  chmodSync(path, 0o644);
  // writeFileSync's `mode` only applies on create, so a plain rewrite would
  // leave 0644 and loadUsers would keep refusing to boot.
  saveUsers(path, [
    { id: "alice", role: "approver", tokenHash: hashToken("t") },
  ]);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  rmSync(dirname(path), { recursive: true, force: true });
});
