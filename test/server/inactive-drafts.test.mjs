// Inactive documents are drafts: they save under a RELAXED schema (build them
// up over time), and the full schema is enforced only when someone activates.
// See src/envelope.mjs validateForStore / relaxSchema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-drafts-"));
  saveUsers(join(home, "users.json"), [
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
    { id: "ap", role: "approver", tokenHash: hashToken("aptok") },
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
const auth = (t) => ({ authorization: `Bearer ${t}` });
const post = (app, type, payload, t = "edtok") =>
  app.inject({ method: "POST", url: `/api/docs/${type}`, headers: auth(t), payload });

// A complete db-schema doc (what a draft must become before it can go active).
function completeDbSchema(status) {
  return {
    schema: "db-schema/v1",
    id: "fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status,
    body: {
      table: "FDC_SENSOR",
      catalog: {
        columns: [{ name: "SENSOR_ID", type: "NUMBER", nullable: false }],
        primaryKey: ["SENSOR_ID"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { SENSOR_ID: { text: null, tier: "scaffold" } },
    },
  };
}

test("inactive draft saves with only the id-source field (relaxed schema)", async () => {
  const { app, cleanup } = await setup();
  // db-schema: just a table name, no catalog/purpose/columnDescs.
  const r = await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "inactive",
    body: { table: "FDC_SENSOR" },
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().json.status, "inactive");

  // msg-format: just a command.
  const m = await post(app, "msg-format", {
    schema: "msg-format/v1",
    id: "cmd-start-lot",
    keywords: [{ kw: "cmd-start-lot", inject: "full" }],
    status: "inactive",
    body: { command: "CMD_START_LOT" },
  });
  assert.equal(m.statusCode, 201, m.body);

  // domain-skill: just a name.
  const d = await post(app, "domain-skill", {
    schema: "domain-skill/v1",
    id: "explain-sensor",
    keywords: [{ kw: "explain-sensor", inject: "full" }],
    status: "inactive",
    body: { name: "explain-sensor" },
  });
  assert.equal(d.statusCode, 201, d.body);
  await cleanup();
});

test("a draft with no id-source (empty body) is rejected — nothing to save under", async () => {
  const { app, cleanup } = await setup();
  const r = await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "inactive",
    body: {},
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, "validation_failed");
  await cleanup();
});

test("id must still match the derived id, even for a draft", async () => {
  const { app, cleanup } = await setup();
  const r = await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "wrong",
    keywords: [{ kw: "wrong", inject: "full" }],
    status: "inactive",
    body: { table: "FDC_SENSOR" }, // derives to "fdc_sensor", not "wrong"
  });
  assert.equal(r.statusCode, 400);
  await cleanup();
});

test("activation is the completeness gate: an incomplete draft cannot go active", async () => {
  const { app, cleanup } = await setup();
  const create = await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "inactive",
    body: { table: "FDC_SENSOR" }, // no catalog/purpose/columnDescs
  });
  assert.equal(create.statusCode, 201);
  const rev = create.json().rev;

  const activate = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/fdc_sensor/activate",
    headers: { ...auth("aptok"), "if-match": rev },
  });
  assert.equal(activate.statusCode, 400, activate.body);
  assert.equal(activate.json().error, "validation_failed");
  // the gate names what is still missing (full schema required fields)
  assert.ok(activate.json().details.some((d) => d.includes("catalog")), activate.body);
  await cleanup();
});

test("a complete inactive doc activates cleanly (gate passes)", async () => {
  const { app, cleanup } = await setup();
  const create = await post(app, "db-schema", completeDbSchema("inactive"));
  assert.equal(create.statusCode, 201, create.body);
  const activate = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/fdc_sensor/activate",
    headers: { ...auth("aptok"), "if-match": create.json().rev },
  });
  assert.equal(activate.statusCode, 200, activate.body);
  assert.equal(activate.json().json.status, "active");
  await cleanup();
});

test("creating directly as ACTIVE still enforces the full schema (unchanged)", async () => {
  const { app, cleanup } = await setup();
  const r = await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "active",
    body: { table: "FDC_SENSOR" }, // incomplete
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, "validation_failed");
  await cleanup();
});

test("GET on an incomplete draft does not crash the renderer (md null-safe)", async () => {
  const { app, cleanup } = await setup();
  await post(app, "db-schema", {
    schema: "db-schema/v1",
    id: "fdc_sensor",
    keywords: [{ kw: "fdc_sensor", inject: "full" }],
    status: "inactive",
    body: { table: "FDC_SENSOR" },
  });
  const g = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/fdc_sensor",
    headers: auth("edtok"),
  });
  assert.equal(g.statusCode, 200, g.body);
  assert.equal(g.json().json.body.table, "FDC_SENSOR");
  // md could not be rendered from the partial body — served as null, not a 500
  assert.equal(g.json().md, null);
  await cleanup();
});
