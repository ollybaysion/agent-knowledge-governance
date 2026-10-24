// If-Match reaches `git show <rev>:<path>`. Only a full commit hash is a base
// rev: "-x" is a git option, and "HEAD" / "HEAD~1" / a short hash are
// expressions the server never handed out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { commitFiles, initStore, readJsonAtRev } from "../../server/store.mjs";

const auth = (token) => ({ authorization: `Bearer ${token}` });

function newDbSchemaDoc() {
  return {
    schema: "db-schema/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: "X",
      catalog: {
        columns: [{ name: "A", type: "NUMBER", nullable: false }],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

test("readJsonAtRev answers null for anything but a 40-hex rev", () => {
  const dir = mkdtempSync(join(tmpdir(), "akg-base-rev-test-"));
  initStore(dir);
  const p = "db-schema/x.json";
  const rev1 = commitFiles(dir, {
    author: "renoir",
    message: "v1",
    writes: [{ relpath: p, content: '{"a":1}\n' }],
  });
  commitFiles(dir, {
    author: "renoir",
    message: "v2",
    writes: [{ relpath: p, content: '{"a":2}\n' }],
  });
  for (const rev of ["-x", "--stat", "HEAD", "HEAD~1", rev1.slice(0, 7), undefined]) {
    assert.equal(readJsonAtRev(dir, p, rev), null, String(rev));
  }
  assert.deepEqual(readJsonAtRev(dir, p, rev1), { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("PUT /api/docs/:type/:id with If-Match HEAD is a 409 unknown_base_rev", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-base-rev-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  assert.equal(created.statusCode, 201);
  const rev = created.json().rev;

  const body = newDbSchemaDoc().body;
  body.purpose = { text: "목적", tier: "inferred", evidence: ["e:1"] };
  for (const ifMatch of ["HEAD", "-x", rev.slice(0, 7)]) {
    const res = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/x",
      headers: { ...auth("edtok"), "if-match": ifMatch },
      payload: body,
    });
    assert.equal(res.statusCode, 409, ifMatch);
    assert.equal(res.json().error, "unknown_base_rev");
    assert.equal(res.json().currentRev, rev);
  }
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
