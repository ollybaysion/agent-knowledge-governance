import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-promote-route-test-"));
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
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function newDbSchemaDoc() {
  return {
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
  };
}

async function createDoc(app, token) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth(token),
    payload: newDbSchemaDoc(),
  });
  return res.json().rev;
}

test("promote: an agent token gets 403 (D6 — agents never promote)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "agent:x", role: "agent", tokenHash: hashToken("agtok") },
  ]);
  const rev = await createDoc(app, "edtok");
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: { ...auth("agtok"), "if-match": rev },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await cleanup();
});

test("promote: editor also gets 403 — only approver may promote", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const rev = await createDoc(app, "edtok");
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: { ...auth("edtok"), "if-match": rev },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await cleanup();
});

test("promote: If-Match mismatch on the TARGETED slot is 409 (S4); non-overlapping slot promote still succeeds", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "boss", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  const rev0 = await createDoc(app, "edtok");
  const editRes = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: (() => {
      const b = newDbSchemaDoc().body;
      b.purpose = { text: "목적", tier: "confirmed", evidence: ["p:1"] };
      b.columnDescs.A = {
        text: "A 설명",
        tier: "confirmed",
        evidence: ["a:1"],
      };
      return b;
    })(),
  });
  const rev1 = editRes.json().rev; // both purpose and columnDescs.A are now inferred

  // Reviewer looked at rev1, but someone edits columnDescs.A again before the promote lands.
  const secondEdit = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev1 },
    payload: (() => {
      const b = editRes.json().json.body;
      b.columnDescs.A = {
        text: "A 재편집",
        tier: "confirmed",
        evidence: ["a:2"],
      };
      return b;
    })(),
  });
  assert.equal(secondEdit.statusCode, 200);

  // Approver's promote request still carries the STALE rev1 and targets the slot that just changed.
  const conflictPromote = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: { ...auth("aptok"), "if-match": rev1 },
    payload: { slots: ["columnDescs.A"] },
  });
  assert.equal(conflictPromote.statusCode, 409);
  assert.deepEqual(conflictPromote.json().overlap, ["columnDescs.A"]);

  // Promoting the UNTOUCHED slot (purpose) against the same stale rev1 must still succeed (S6 fused into S4).
  const okPromote = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: { ...auth("aptok"), "if-match": rev1 },
    payload: { slots: ["purpose"] },
  });
  assert.equal(okPromote.statusCode, 200);
  assert.equal(okPromote.json().json.body.purpose.tier, "confirmed");
  assert.equal(okPromote.json().json.body.purpose.by, "promote:boss");
  assert.equal(okPromote.json().json.body.purpose.text, "목적"); // text/evidence unchanged by promote

  await cleanup();
});

test("proposals: submit -> list pending -> adopt lands the slot as inferred and archives the proposal", async () => {
  const { app, cleanup } = await setup([
    { id: "agent:x", role: "agent", tokenHash: hashToken("agtok") },
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const rev0 = await createDoc(app, "edtok");

  const submit = await app.inject({
    method: "POST",
    url: "/api/proposals",
    headers: auth("agtok"),
    payload: {
      type: "db-schema",
      id: "t.x",
      slots: { purpose: { text: "제안된 목적", evidence: ["code.ts:1"] } },
    },
  });
  assert.equal(submit.statusCode, 201);
  const pid = submit.json().id;

  const pending = await app.inject({
    method: "GET",
    url: "/api/proposals?state=pending",
    headers: auth("edtok"),
  });
  assert.equal(pending.json().proposals.length, 1);
  assert.equal(pending.json().proposals[0].id, pid);

  const adopt = await app.inject({
    method: "POST",
    url: `/api/proposals/${pid}/adopt`,
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: {},
  });
  assert.equal(adopt.statusCode, 200);
  assert.equal(adopt.json().json.body.purpose.tier, "inferred");
  assert.equal(adopt.json().json.body.purpose.by, "adopt:renoir");

  const pendingAfter = await app.inject({
    method: "GET",
    url: "/api/proposals?state=pending",
    headers: auth("edtok"),
  });
  assert.equal(pendingAfter.json().proposals.length, 0);

  // Double-adopt of the same (now-archived) proposal is 409, not a crash (S8).
  const doubleAdopt = await app.inject({
    method: "POST",
    url: `/api/proposals/${pid}/adopt`,
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: {},
  });
  assert.equal(doubleAdopt.statusCode, 409);

  await cleanup();
});

test("proposals: agent role cannot adopt or reject, only submit", async () => {
  const { app, cleanup } = await setup([
    { id: "agent:x", role: "agent", tokenHash: hashToken("agtok") },
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/proposals/some-uuid/adopt",
    headers: { ...auth("agtok"), "if-match": "deadbeef" },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await cleanup();
});

test("proposals: identical resubmission from an agent dedups to the existing pending proposal", async () => {
  const { app, cleanup } = await setup([
    { id: "agent:x", role: "agent", tokenHash: hashToken("agtok") },
  ]);
  const payload = {
    type: "db-schema",
    id: "t.x",
    slots: { purpose: { text: "동일", evidence: ["e:1"] } },
  };
  const first = await app.inject({
    method: "POST",
    url: "/api/proposals",
    headers: auth("agtok"),
    payload,
  });
  const second = await app.inject({
    method: "POST",
    url: "/api/proposals",
    headers: auth("agtok"),
    payload,
  });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().deduped, true);
  assert.equal(second.json().id, first.json().id);
  await cleanup();
});

test("audit: GET /api/audit reflects the exact commit trail (author, message) for a doc's writes", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const rev0 = await createDoc(app, "edtok");
  await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: (() => {
      const b = newDbSchemaDoc().body;
      b.purpose = { text: "목적", tier: "confirmed", evidence: ["p:1"] };
      return b;
    })(),
  });

  const audit = await app.inject({
    method: "GET",
    url: "/api/audit?doc=db-schema/t.x",
    headers: auth("edtok"),
  });
  assert.equal(audit.statusCode, 200);
  const entries = audit.json().entries;
  assert.equal(entries.length, 2); // create + edit
  assert.ok(entries.every((e) => e.author === "renoir"));
  assert.match(entries[0].message, /edit db-schema\/t\.x/); // git log is newest-first
  assert.match(entries[1].message, /create db-schema\/t\.x/);
  await cleanup();
});
