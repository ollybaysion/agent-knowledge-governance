// db-schema columnOrder: the 열 table's row order on the AKG screen. A person
// sets it with the document PUT; the collector's pushes keep it; columnDescs
// (the order BE reads) stays as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";
import { moveName, orderColumns, orderSteps } from "../../public/lib/column-order.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-column-order-"));
  const signedIn = await signIn(home, [
    { id: "ed", group: "admin", token: "edtok" },
    { id: "bot", group: "agent", token: "bottok" },
    { id: "reader", group: "user", token: "rtok" },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), auth: signedIn });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const scaffold = () => ({ text: null, tier: "scaffold" });
const catalog = (names) => ({
  columns: names.map((name) => ({ name, type: "NUMBER", nullable: true })),
  primaryKey: [names[0]],
  fetchedAt: "2026-01-01T00:00:00Z",
});
const table = (extra = {}) => ({
  schema: "db-schema/v1",
  id: "t1",
  keywords: [{ kw: "t1", inject: "full" }],
  status: "active",
  body: {
    table: "T1",
    catalog: catalog(["A", "B", "C"]),
    purpose: scaffold(),
    columnDescs: { A: scaffold(), B: scaffold(), C: scaffold() },
    ...extra,
  },
});
const post = (app, doc) => app.inject({ method: "POST", url: "/api/docs/db-schema", headers: as("edtok"), payload: doc });
const read = async (app) => (await app.inject({ method: "GET", url: "/api/docs/db-schema/t1", headers: as("rtok") })).json();
const put = (app, token, rev, body) =>
  app.inject({ method: "PUT", url: "/api/docs/db-schema/t1", headers: { ...as(token), "if-match": rev }, payload: body });

test("columnOrder: the document PUT sets it, columnDescs keeps its key order, a user is refused", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, table())).statusCode, 201);
    const before = await read(app);
    const r = await put(app, "edtok", before.rev, { ...before.json.body, columnOrder: ["C", "A", "B"] });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().json.body.columnOrder, ["C", "A", "B"]);
    const after = await read(app);
    assert.deepEqual(after.json.body.columnOrder, ["C", "A", "B"]);
    assert.deepEqual(Object.keys(after.json.body.columnDescs), ["A", "B", "C"]);
    assert.deepEqual(after.json.body.catalog, before.json.body.catalog);
    const asUser = await put(app, "rtok", after.rev, { ...after.json.body, columnOrder: ["A", "B", "C"] });
    assert.equal(asUser.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test("columnOrder: a repeated name is refused by the PUT", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table());
    const before = await read(app);
    const r = await put(app, "edtok", before.rev, { ...before.json.body, columnOrder: ["A", "A"] });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, "validation_failed");
  } finally {
    await cleanup();
  }
});

test("columnOrder: a stale rev rebases at slot level and keeps the stored order", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table({ columnOrder: ["B", "A", "C"] }));
    const base = await read(app);
    const other = structuredClone(base.json.body);
    other.purpose = { text: "센서 표", tier: "inferred", evidence: ["x:1"] };
    assert.equal((await put(app, "edtok", base.rev, other)).statusCode, 200);
    const stale = await put(app, "edtok", base.rev, { ...base.json.body, columnOrder: ["C", "B", "A"] });
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal(stale.json().rebased, true);
    assert.deepEqual(stale.json().json.body.columnOrder, ["B", "A", "C"]);
  } finally {
    await cleanup();
  }
});

test("columnOrder: catalog-push and facts-push keep it, a vanished name stays stored", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table({ columnOrder: ["C", "B", "A"] }));
    const cat = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1/catalog", headers: as("bottok"), payload: catalog(["A", "B", "D"]) });
    assert.equal(cat.statusCode, 200, cat.body);
    assert.deepEqual(cat.json().json.body.columnOrder, ["C", "B", "A"]);
    const facts = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/t1/facts",
      headers: as("bottok"),
      payload: { body: { table: "T1", catalog: catalog(["A", "B"]), purpose: scaffold(), columnDescs: { A: scaffold(), B: scaffold() } } },
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.deepEqual(facts.json().json.body.columnOrder, ["C", "B", "A"]);
    assert.deepEqual((await read(app)).json.body.columnOrder, ["C", "B", "A"]);
  } finally {
    await cleanup();
  }
});

test("columnOrder: facts-push leaves a table without it without it", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table());
    const facts = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/t1/facts",
      headers: as("bottok"),
      payload: { body: { table: "T1", catalog: catalog(["A"]), purpose: scaffold(), columnDescs: { A: scaffold() }, columnOrder: ["A"] } },
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.equal("columnOrder" in facts.json().json.body, false);
  } finally {
    await cleanup();
  }
});

test("columnOrder: 맨 아래로 is one PUT with the column at the end; 맨 위로 brings it to the front", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, table())).statusCode, 201);
    const before = await read(app);
    const names = orderColumns(before.json.body.catalog.columns, before.json.body.columnOrder).map((c) => c.name);
    const down = moveName(names, 0, orderSteps(0, names.length).at(-1).to);
    const r = await put(app, "edtok", before.rev, { ...before.json.body, columnOrder: down });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual((await read(app)).json.body.columnOrder, ["B", "C", "A"]);
    const up = moveName(down, 2, orderSteps(2, 3)[0].to);
    const back = await put(app, "edtok", r.json().rev, { ...r.json().json.body, columnOrder: up });
    assert.equal(back.statusCode, 200, back.body);
    assert.deepEqual((await read(app)).json.body.columnOrder, ["A", "B", "C"]);
  } finally {
    await cleanup();
  }
});
