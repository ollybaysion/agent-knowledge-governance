// db-schema unusedColumns: the columns BE leaves out of the prompt. A person
// sets it with the document PUT; the collector's pushes keep it; 확정
// 커버리지 counts the used columns only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-unused-columns-"));
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
const inferred = (text) => ({ text, tier: "inferred", evidence: ["x:1"] });
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
    purpose: inferred("센서 표"),
    columnDescs: { A: inferred("a"), B: inferred("b"), C: scaffold() },
    ...extra,
  },
});
const post = (app, doc) => app.inject({ method: "POST", url: "/api/docs/db-schema", headers: as("edtok"), payload: doc });
const read = async (app) => (await app.inject({ method: "GET", url: "/api/docs/db-schema/t1", headers: as("rtok") })).json();
const listRow = async (app) =>
  (await app.inject({ method: "GET", url: "/api/docs?type=db-schema", headers: as("rtok") })).json().docs.find((d) => d.id === "t1");
const put = (app, token, rev, body) =>
  app.inject({ method: "PUT", url: "/api/docs/db-schema/t1", headers: { ...as(token), "if-match": rev }, payload: body });

test("unusedColumns: the document PUT sets it; GET and the list carry it as stored; a user is refused", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, table())).statusCode, 201);
    assert.equal("unusedColumns" in (await listRow(app)), false);
    const before = await read(app);
    const r = await put(app, "edtok", before.rev, { ...before.json.body, unusedColumns: ["B", "GONE"] });
    assert.equal(r.statusCode, 200, r.body);
    const after = await read(app);
    assert.deepEqual(after.json.body.unusedColumns, ["B", "GONE"]);
    assert.deepEqual((await listRow(app)).unusedColumns, ["B", "GONE"]);
    assert.deepEqual(after.json.body.columnDescs, before.json.body.columnDescs);
    const asUser = await put(app, "rtok", after.rev, { ...after.json.body, unusedColumns: [] });
    assert.equal(asUser.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test("unusedColumns: a repeated name is refused by the PUT", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table());
    const before = await read(app);
    const r = await put(app, "edtok", before.rev, { ...before.json.body, unusedColumns: ["A", "A"] });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, "validation_failed");
  } finally {
    await cleanup();
  }
});

test("unusedColumns: 확정 커버리지 leaves an unused column's slot out of both sides, in the doc view and the list", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table());
    const posted = await read(app);
    const promote = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/t1/promote",
      headers: { ...as("edtok"), "if-match": posted.rev },
      payload: { slots: ["purpose", "columnDescs.A", "columnDescs.B"] },
    });
    assert.equal(promote.statusCode, 200, promote.body);
    const before = await read(app);
    assert.deepEqual(before.coverage, { confirmed: 3, total: 4, ratio: 0.75 });
    await put(app, "edtok", before.rev, { ...before.json.body, unusedColumns: ["C"] });
    assert.deepEqual((await read(app)).coverage, { confirmed: 3, total: 3, ratio: 1 });
    const mid = await read(app);
    await put(app, "edtok", mid.rev, { ...mid.json.body, unusedColumns: ["B", "C"] });
    assert.deepEqual((await read(app)).coverage, { confirmed: 2, total: 2, ratio: 1 });
    assert.deepEqual((await listRow(app)).coverage, { confirmed: 2, total: 2, ratio: 1 });
  } finally {
    await cleanup();
  }
});

test("unusedColumns: catalog-push and facts-push keep it, a vanished name stays stored", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table({ unusedColumns: ["C", "B"] }));
    const cat = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1/catalog", headers: as("bottok"), payload: catalog(["A", "B", "D"]) });
    assert.equal(cat.statusCode, 200, cat.body);
    assert.deepEqual(cat.json().json.body.unusedColumns, ["C", "B"]);
    const facts = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/t1/facts",
      headers: as("bottok"),
      payload: { body: { table: "T1", catalog: catalog(["A", "B"]), purpose: scaffold(), columnDescs: { A: scaffold(), B: scaffold() } } },
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.deepEqual(facts.json().json.body.unusedColumns, ["C", "B"]);
    assert.deepEqual((await read(app)).json.body.unusedColumns, ["C", "B"]);
  } finally {
    await cleanup();
  }
});

test("unusedColumns: facts-push leaves a table without it without it", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table());
    const facts = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/t1/facts",
      headers: as("bottok"),
      payload: { body: { table: "T1", catalog: catalog(["A"]), purpose: scaffold(), columnDescs: { A: scaffold() }, unusedColumns: ["A"] } },
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.equal("unusedColumns" in facts.json().json.body, false);
  } finally {
    await cleanup();
  }
});
