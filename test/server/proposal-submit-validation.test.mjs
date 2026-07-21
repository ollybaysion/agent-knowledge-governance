// Issue #21 — a proposal that can never be adopted must not reach the queue.
//
// The failure these cover is not "the request errors". It is WHO finds out and
// WHEN: before this, every one of these was accepted with a 201, and the error
// surfaced later on a reviewer's adopt click, where it could not be fixed. So
// each test asserts the rejection AND that the queue stayed empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-submit-validate-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "agent:x", role: "agent", tokenHash: hashToken("agtok") },
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
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

const auth = (token) => ({ authorization: `Bearer ${token}` });

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

async function createDoc(app) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  return res.json().rev;
}

const submit = (app, slots, id = "t.x") =>
  app.inject({
    method: "POST",
    url: "/api/proposals",
    headers: auth("agtok"),
    payload: { type: "db-schema", id, slots },
  });

async function pendingCount(app) {
  const res = await app.inject({
    method: "GET",
    url: "/api/proposals?state=pending",
    headers: auth("edtok"),
  });
  return res.json().proposals.length;
}

test("submit: a slot with no evidence is refused, not queued for a reviewer to discover", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);

  const res = await submit(app, {
    purpose: { text: "근거 없음" },
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), {
    error: "invalid_slot_value",
    address: "purpose",
  });
  assert.equal(await pendingCount(app), 0);
  await cleanup();
});

test("submit: one bad slot cannot smuggle its good siblings into the queue", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);

  // Before #21 this was accepted whole, and adopt then abandoned at the first
  // bad slot — so the good `purpose` never landed either, and nobody could
  // separate them from the queue.
  const res = await submit(app, {
    purpose: { text: "멀쩡한 제안", evidence: ["code.ts:1"] },
    "columnDescs.A": { text: "근거 없음", evidence: [] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().address, "columnDescs.A");
  assert.equal(await pendingCount(app), 0);
  await cleanup();
});

test("submit: a malformed address is a 400, not the 500 it used to crash with", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);

  for (const address of ["nope.deep.x", "queries[3].note"]) {
    const res = await submit(app, {
      [address]: { text: "값", evidence: ["code.ts:1"] },
    });
    assert.equal(res.statusCode, 400, `${address} should be a clean 400`);
    assert.deepEqual(res.json(), { error: "invalid_slot_address", address });
  }
  assert.equal(await pendingCount(app), 0);
  await cleanup();
});

test("submit: a column absent from the catalog is refused by the type's own semantics", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);

  const res = await submit(app, {
    "columnDescs.GHOST": { text: "없는 컬럼", evidence: ["code.ts:1"] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "validation_failed");
  assert.match(res.json().details.join("\n"), /GHOST: no such column/);
  assert.equal(await pendingCount(app), 0);
  await cleanup();
});

test("submit: proposing against a doc that does not exist yet is still allowed — that failure is not settled", async () => {
  const { app, cleanup } = await setup();
  // No document created. The rehearsal is impossible, but the doc may be
  // created before anyone adopts, so only the document-independent checks run.
  const ok = await submit(
    app,
    { purpose: { text: "미리 제안", evidence: ["code.ts:1"] } },
    "t.later",
  );
  assert.equal(ok.statusCode, 201);

  const bad = await submit(app, { purpose: { text: "근거 없음" } }, "t.later");
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, "invalid_slot_value");

  assert.equal(await pendingCount(app), 1);
  await cleanup();
});

test("adopt: still validates — a reviewer's override slots have never been through submit", async () => {
  const { app, cleanup } = await setup();
  const rev = await createDoc(app);

  const res = await submit(app, {
    purpose: { text: "제안", evidence: ["code.ts:1"] },
  });
  assert.equal(res.statusCode, 201);
  const pid = res.json().id;

  // The reviewer may replace the slots at adopt time; that payload bypassed
  // submit entirely, which is why the adopt-side check has to stay.
  const adopt = await app.inject({
    method: "POST",
    url: `/api/proposals/${pid}/adopt`,
    headers: { ...auth("edtok"), "if-match": rev },
    payload: { slots: { "nope.deep.x": { text: "값", evidence: ["c.ts:1"] } } },
  });
  assert.equal(adopt.statusCode, 400);
  assert.equal(adopt.json().error, "invalid_slot_address");
  assert.equal(await pendingCount(app), 1); // unresolved, still adoptable
  await cleanup();
});

test("submit -> adopt: a well-formed proposal is unaffected", async () => {
  const { app, cleanup } = await setup();
  const rev = await createDoc(app);

  const res = await submit(app, {
    "columnDescs.A": { text: "A 컬럼 설명", evidence: ["code.ts:1"] },
  });
  assert.equal(res.statusCode, 201);

  const adopt = await app.inject({
    method: "POST",
    url: `/api/proposals/${res.json().id}/adopt`,
    headers: { ...auth("edtok"), "if-match": rev },
    payload: {},
  });
  assert.equal(adopt.statusCode, 200);
  const slot = adopt.json().json.body.columnDescs.A;
  assert.equal(slot.text, "A 컬럼 설명");
  assert.equal(slot.tier, "inferred");
  assert.equal(slot.by, "adopt:renoir");
  assert.equal(await pendingCount(app), 0);
  await cleanup();
});
