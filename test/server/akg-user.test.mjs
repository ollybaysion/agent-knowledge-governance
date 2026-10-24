// server/cli/akg-user.mjs run as a child process: the exit code and the
// users.json it leaves are what an operator sees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashToken, loadUsers, saveUsers } from "../../server/auth.mjs";

const CLI = fileURLToPath(
  new URL("../../server/cli/akg-user.mjs", import.meta.url),
);

function freshUsersFile(users) {
  const home = mkdtempSync(join(tmpdir(), "akg-user-cli-test-"));
  const path = join(home, "users.json");
  saveUsers(path, users);
  return { home, path };
}

const run = (path, ...args) =>
  spawnSync("node", [CLI, ...args], {
    env: { ...process.env, AKG_USERS_PATH: path },
    encoding: "utf8",
  });

const renoir = { id: "renoir", role: "approver", tokenHash: hashToken("t") };

test("add refuses an id the store cannot use as a git author", () => {
  const { home, path } = freshUsersFile([renoir]);
  const before = readFileSync(path, "utf8");
  const r = run(path, "add", "kim.minsu", "editor");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /유효하지 않은 id/);
  assert.equal(readFileSync(path, "utf8"), before);
  rmSync(home, { recursive: true, force: true });
});

test("add on a users.json it cannot load fails and leaves the file as it was", () => {
  const { home, path } = freshUsersFile([renoir]);
  chmodSync(path, 0o644);
  const before = readFileSync(path, "utf8");
  const r = run(path, "add", "kim", "editor");
  assert.equal(r.status, 1);
  assert.equal(readFileSync(path, "utf8"), before);
  rmSync(home, { recursive: true, force: true });
});

test("add after revoking the last user starts a new list", () => {
  const { home, path } = freshUsersFile([renoir]);
  assert.equal(run(path, "revoke", "renoir").status, 0);
  const r = run(path, "add", "kim", "editor");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    loadUsers(path).map((u) => u.id),
    ["kim"],
  );
  rmSync(home, { recursive: true, force: true });
});
