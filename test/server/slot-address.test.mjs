// A slot address walks the document's own data. Before this, setSlot followed
// `cur[key]` blindly, so one proposal slot named "__proto__.public" wrote onto
// Object.prototype: every route's `cfg.public` became true and token-less
// requests passed auth until restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";
import { getSlot, setSlot } from "../../server/slots.mjs";

const POISON = ["__proto__.public", "constructor.prototype.public"];

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-slot-address-test-"));
  const signedIn = await signIn(home, [
    { id: "agent:x", group: "agent", token: "agtok" },
    { id: "renoir", group: "admin", token: "edtok" },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    auth: signedIn,
  });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const auth = (token) => as(token);

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

async function createDoc(app) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  assert.equal(res.statusCode, 201);
  return res.json().rev;
}

const slotValue = { text: "값", evidence: ["code.ts:1"] };

test("setSlot throws on __proto__ / constructor / prototype tokens and leaves Object.prototype alone", () => {
  for (const address of [
    ...POISON,
    "purpose.__proto__",
    "columnDescs.prototype",
    "columnDescs.constructor",
  ]) {
    const body = newDbSchemaDoc().body;
    assert.throws(() => setSlot(body, address, slotValue), TypeError, address);
  }
  assert.equal(Object.prototype.public, undefined);
  assert.equal({}.public, undefined);
});

test("getSlot answers only from own properties", () => {
  const body = newDbSchemaDoc().body;
  assert.equal(getSlot(body, "constructor"), undefined);
  assert.equal(getSlot(body, "__proto__"), undefined);
  assert.equal(getSlot(body, "purpose.toString"), undefined);
  assert.deepEqual(getSlot(body, "purpose"), { text: null, tier: "scaffold" });
});

test("submit: a prototype address is a 400 and token-less requests stay 401", async () => {
  const { app, cleanup } = await setup();
  await createDoc(app);

  for (const address of POISON) {
    const res = await app.inject({
      method: "POST",
      url: "/api/proposals",
      headers: auth("agtok"),
      payload: { type: "db-schema", id: "x", slots: { [address]: slotValue } },
    });
    assert.equal(res.statusCode, 400, address);
    assert.deepEqual(res.json(), { error: "invalid_slot_address", address });
  }
  assert.equal(Object.prototype.public, undefined);

  const anon = await app.inject({ method: "GET", url: "/api/proposals" });
  assert.equal(anon.statusCode, 401);
  await cleanup();
});

test("adopt: a reviewer's override slots with a prototype address are a 400", async () => {
  const { app, cleanup } = await setup();
  const rev = await createDoc(app);
  const submitted = await app.inject({
    method: "POST",
    url: "/api/proposals",
    headers: auth("agtok"),
    payload: { type: "db-schema", id: "x", slots: { purpose: slotValue } },
  });
  assert.equal(submitted.statusCode, 201);
  const pid = submitted.json().id;

  for (const address of POISON) {
    const res = await app.inject({
      method: "POST",
      url: `/api/proposals/${pid}/adopt`,
      headers: { ...auth("edtok"), "if-match": rev },
      payload: { slots: { [address]: slotValue } },
    });
    assert.equal(res.statusCode, 400, address);
    assert.deepEqual(res.json(), { error: "invalid_slot_address", address });
  }
  assert.equal(Object.prototype.public, undefined);

  const anon = await app.inject({ method: "GET", url: "/api/proposals" });
  assert.equal(anon.statusCode, 401);
  await cleanup();
});
