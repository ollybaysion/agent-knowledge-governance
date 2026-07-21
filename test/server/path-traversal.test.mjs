// Regression tests for the §13-1 path traversal: a route param that names a
// stored object used to flow into a file path unchecked, so `reject` (editor)
// could reach out of proposals/ and delete anything in the store — including
// documents whose real DELETE route is approver-only, and the compiled
// injection index. Reproduced before the fix: honest DELETE 403, traversal
// reject 200 + file gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-traversal-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "editor1", role: "editor", tokenHash: hashToken("edtok") },
    { id: "boss", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({
    storeDir,
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const auth = (t) => ({ authorization: `Bearer ${t}` });

async function createDoc(app) {
  return app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: {
      schema: "db-schema/v1",
      id: "t.x",
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
    },
  });
}

test("reject: a traversing :pid cannot delete a document the caller may not delete", async () => {
  const { app, storeDir, cleanup } = await setup();
  await createDoc(app);
  const docPath = join(storeDir, "db-schema", "t.x.json");
  assert.ok(existsSync(docPath));

  // The honest route is approver-only, so an editor has no legitimate way here.
  const honest = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/t.x",
    headers: auth("edtok"),
  });
  assert.equal(honest.statusCode, 403);

  const res = await app.inject({
    method: "POST",
    url: `/api/proposals/${encodeURIComponent("../../db-schema/t.x")}/reject`,
    headers: auth("edtok"),
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.ok(existsSync(docPath), "문서가 살아있어야 한다");
  await cleanup();
});

test("reject: a traversing :pid cannot delete the compiled injection index", async () => {
  const { app, storeDir, cleanup } = await setup();
  await createDoc(app);
  const idxPath = join(storeDir, "rendered", "db-schema", "index.json");
  assert.ok(existsSync(idxPath));

  const res = await app.inject({
    method: "POST",
    url: `/api/proposals/${encodeURIComponent("../../rendered/db-schema/index")}/reject`,
    headers: auth("edtok"),
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.ok(existsSync(idxPath), "주입 인덱스가 살아있어야 한다");
  await cleanup();
});

// The global onRequest hook answers first, so this reports invalid_path_param
// rather than the route's own invalid_proposal_id. Both layers exist on
// purpose: the hook is what makes a newly added route safe by default, the
// route check is what still holds if the hook is ever narrowed in scope.
test("adopt rejects a traversing :pid before the If-Match check", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({
    method: "POST",
    url: `/api/proposals/${encodeURIComponent("../../db-schema/t.x")}/adopt`,
    headers: { ...auth("edtok"), "if-match": "deadbeef" },
    payload: {},
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_path_param");
  await cleanup();
});

test("the guard is global — a traversing :id on a docs route is refused too", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);
  for (const url of [
    `/api/docs/db-schema/${encodeURIComponent("../../users")}`,
    `/api/docs/db-schema/${encodeURIComponent("../rendered/db-schema/index")}`,
  ]) {
    const res = await app.inject({ method: "GET", url, headers: auth("edtok") });
    assert.equal(res.statusCode, 400, url);
    assert.equal(res.json().error, "invalid_path_param");
  }
  await cleanup();
});

test("ordinary ids still work — the guard rejects traversal, not dots or hyphens", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);
  const res = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/t.x",
    headers: auth("edtok"),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().json.id, "t.x");
  await cleanup();
});
