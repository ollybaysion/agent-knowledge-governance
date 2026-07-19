import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-docs-route-test-"));
}

async function setup(users) {
  const home = freshHome();
  saveUsers(join(home, "users.json"), users);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    home,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function newDbSchemaDoc(overrides = {}) {
  return {
    schema: "db-schema/v1",
    id: "t.x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: "X",
      catalog: {
        columns: [
          { name: "A", type: "NUMBER", nullable: false },
          { name: "B", type: "VARCHAR2(1)", nullable: true },
        ],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {
        A: { text: null, tier: "scaffold" },
        B: { text: null, tier: "scaffold" },
      },
    },
    ...overrides,
  };
}

test("create -> read -> edit round trip, and a fresh POST can never smuggle confirmed", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "reader", role: "viewer", tokenHash: hashToken("vtok") },
  ]);

  const doc = newDbSchemaDoc();
  doc.body.purpose = {
    text: "몰래 confirmed",
    tier: "confirmed",
    evidence: ["sneaky:1"],
  };
  const create = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: doc,
  });
  assert.equal(create.statusCode, 201);
  // D4: no write path may create confirmed directly — even POST demotes it.
  assert.equal(create.json().json.body.purpose.tier, "inferred");

  const get = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/t.x",
    headers: auth("vtok"),
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().json.body.purpose.text, "몰래 confirmed");
  assert.ok(get.json().rev);
  assert.ok(get.json().md.includes("# T.X"));

  await cleanup();
});

test("PUT without If-Match is rejected (428); with a stale but non-overlapping rev it auto-rebases (S6)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const noIfMatch = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: auth("edtok"),
    payload: newDbSchemaDoc().body,
  });
  assert.equal(noIfMatch.statusCode, 428);

  // First edit: touches column A.
  const bodyA = newDbSchemaDoc().body;
  bodyA.columnDescs.A = {
    text: "A 설명",
    tier: "confirmed",
    evidence: ["a:1"],
  };
  const editA = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: bodyA,
  });
  assert.equal(editA.statusCode, 200);
  assert.equal(editA.json().json.body.columnDescs.A.tier, "inferred"); // PUT never creates confirmed

  // Second edit, still against the STALE rev0, touches column B only -> should rebase cleanly.
  const bodyB = newDbSchemaDoc().body;
  bodyB.columnDescs.B = {
    text: "B 설명",
    tier: "confirmed",
    evidence: ["b:1"],
  };
  const editB = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 }, // still rev0, now stale
    payload: bodyB,
  });
  assert.equal(editB.statusCode, 200);
  assert.equal(editB.json().rebased, true);
  assert.equal(editB.json().json.body.columnDescs.A.text, "A 설명"); // alice's change survived the rebase
  assert.equal(editB.json().json.body.columnDescs.B.text, "B 설명");

  await cleanup();
});

test("PUT with an overlapping stale edit gets 409, not a silent overwrite (S6)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const bodyA1 = newDbSchemaDoc().body;
  bodyA1.columnDescs.A = {
    text: "첫 편집",
    tier: "confirmed",
    evidence: ["a:1"],
  };
  await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: bodyA1,
  });

  const bodyA2 = newDbSchemaDoc().body;
  bodyA2.columnDescs.A = {
    text: "충돌하는 두번째 편집",
    tier: "confirmed",
    evidence: ["a:2"],
  };
  const conflict = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 }, // stale AND overlapping
    payload: bodyA2,
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().overlap, ["columnDescs.A"]);
  assert.equal(conflict.json().current.body.columnDescs.A.text, "첫 편집");

  await cleanup();
});

test("DELETE archives a doc (approver only) — dropped from the index, JSON preserved; a nonexistent route is 404 not 500", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "approver", tokenHash: hashToken("aptok") },
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("aptok"),
    payload: newDbSchemaDoc(),
  });

  // editor cannot archive
  const forbidden = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/t.x",
    headers: auth("edtok"),
  });
  assert.equal(forbidden.statusCode, 403);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/t.x",
    headers: auth("aptok"),
  });
  assert.equal(del.statusCode, 200);

  const after = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/t.x",
    headers: auth("aptok"),
  });
  assert.equal(after.json().json.status, "archived"); // JSON preserved, just archived

  // a genuinely unknown route returns a clean 404, never a 500 route_misconfigured
  const unknown = await app.inject({
    method: "DELETE",
    url: "/api/nope/x",
    headers: auth("aptok"),
  });
  assert.equal(unknown.statusCode, 404);

  await cleanup();
});

test("catalog-push replaces catalog and auto-deprecates an inferred slot whose column vanished", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const editB = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: (() => {
      const b = newDbSchemaDoc().body;
      b.columnDescs.B = {
        text: "B 설명",
        tier: "confirmed",
        evidence: ["b:1"],
      };
      return b;
    })(),
  });
  assert.equal(editB.statusCode, 200);

  // Column B drops out of the live catalog — its non-scaffold slot must auto-deprecate, not vanish.
  const push = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x/catalog",
    headers: auth("edtok"),
    payload: {
      columns: [
        { name: "A", type: "NUMBER", nullable: false },
        { name: "C", type: "NUMBER", nullable: true },
      ],
      primaryKey: ["A"],
      fetchedAt: "2026-02-01T00:00:00Z",
    },
  });
  assert.equal(push.statusCode, 200);
  assert.equal(push.json().json.body.columnDescs.B.tier, "deprecated");
  assert.equal(push.json().json.body.columnDescs.B.text, "B 설명"); // preserved, not erased
  assert.deepEqual(push.json().json.body.columnDescs.C, {
    text: null,
    tier: "scaffold",
  }); // new column seeded
  assert.equal(push.json().json.body.columnDescs.A.tier, "scaffold"); // untouched column, untouched slot

  await cleanup();
});
