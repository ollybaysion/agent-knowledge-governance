import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadUserFile,
  matchAgent,
  hasGroup,
  groupOfClientRoles,
  AuthBootError,
} from "../../server/auth.mjs";

function file(text, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), "akg-auth-test-"));
  const path = join(dir, "users.yml");
  writeFileSync(path, text, { mode });
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadUserFile refuses a missing path, a missing file, no users, a bad line, a repeated id, an unknown group (S1)", () => {
  assert.throws(() => loadUserFile(""), AuthBootError);
  assert.throws(() => loadUserFile("/nonexistent/users.yml"), AuthBootError);
  for (const text of [
    "users: []\n",
    "nope: 1\n",
    "users:\n  - { id: kim, group: admin }\n",
    "users:\n  - { id: kim, group: admin, password: a }\n  - { id: kim, group: user, password: b }\n",
    "users:\n  - { id: kim, group: editor, password: a }\n",
    "users: [\n",
  ]) {
    const f = file(text);
    assert.throws(() => loadUserFile(f.path), AuthBootError, text);
    f.done();
  }
});

test("loadUserFile reads id · group · password lines; group is case-blind like BE's Group.fromWire", () => {
  const f = file("users:\n  - { id: kim, group: Admin, password: kim-pw }\n  - { id: bot, group: agent, password: 1234 }\n");
  const entries = loadUserFile(f.path);
  assert.deepEqual(
    entries.map((e) => [e.id, e.group]),
    [["kim", "admin"], ["bot", "agent"]],
  );
  // A bare number is a password too, read as its text.
  assert.deepEqual(matchAgent(entries, "1234"), { id: "bot", group: "agent" });
  f.done();
});

test("matchAgent: only agent lines match", () => {
  const f = file("users:\n  - { id: kim, group: admin, password: kim-pw }\n  - { id: bot, group: agent, password: bot-pw }\n");
  const entries = loadUserFile(f.path);
  assert.deepEqual(matchAgent(entries, "bot-pw"), { id: "bot", group: "agent" });
  assert.equal(matchAgent(entries, "kim-pw"), null);
  assert.equal(matchAgent(entries, "nope"), null);
  assert.equal(matchAgent(entries, ""), null);
  f.done();
});

test("hasGroup: admin satisfies user; agent passes only where named (D6)", () => {
  assert.equal(hasGroup({ group: "admin" }, ["user"]), true);
  assert.equal(hasGroup({ group: "user" }, ["admin"]), false);
  assert.equal(hasGroup({ group: "user" }, ["user", "agent"]), true);
  assert.equal(hasGroup({ group: "agent" }, ["user"]), false);
  assert.equal(hasGroup({ group: "agent" }, ["admin"]), false);
  assert.equal(hasGroup({ group: "agent" }, ["admin", "agent"]), true);
});

test("groupOfClientRoles: admin > agent > user, same order as BE", () => {
  assert.equal(groupOfClientRoles(["agent", "admin"]), "admin");
  assert.equal(groupOfClientRoles(["agent"]), "agent");
  assert.equal(groupOfClientRoles([]), "user");
  assert.equal(groupOfClientRoles(["offline_access"]), "user");
});
