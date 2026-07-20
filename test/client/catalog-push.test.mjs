// akg CLI `catalog-push` (design §8.1) — src/client/catalog-push.mjs against
// a REAL in-process server (Phase 1's buildApp(), app.inject — no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { catalogPush } from "../../src/client/catalog-push.mjs";
import { AkgApiError } from "../../src/client/errors.mjs";

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-catalog-push-server-"));
  saveUsers(join(home, "users.json"), [
    { id: "editor1", role: "editor", tokenHash: hashToken("ed-tok") },
    { id: "agent1", role: "agent", tokenHash: hashToken("agent-tok") },
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

function fetchImplFromApp(app) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    const res = await app.inject({
      method: opts.method ?? "GET",
      url: u.pathname + u.search,
      headers: opts.headers,
      payload: opts.body,
    });
    return {
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] },
      json: async () => res.json(),
    };
  };
}

async function seedSensorDoc(app) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: { authorization: "Bearer ed-tok" },
    payload: {
      schema: "db-schema/v1",
      id: "t.sensor",
      keywords: [{ kw: "t.sensor", inject: "full" }],
      status: "active",
      body: {
        owner: "T",
        table: "SENSOR",
        catalog: {
          columns: [
            { name: "A", type: "NUMBER", nullable: false },
            { name: "B", type: "VARCHAR2(10)", nullable: true },
          ],
          primaryKey: ["A"],
          fetchedAt: "2026-01-01T00:00:00Z",
        },
        purpose: { text: null, tier: "scaffold" },
        columnDescs: {
          A: {
            text: "센서 식별자.",
            tier: "inferred",
            evidence: ["human-reviewed"],
          }, // "confirmed" needs promote (approver-only, D4) — no write path can create it directly
          B: { text: null, tier: "scaffold" },
        },
      },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

test("catalog-push: success replaces catalog, preserves a non-scaffold columnDesc, drops vanished scaffold", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await seedSensorDoc(app);
    const newCatalog = {
      columns: [{ name: "A", type: "NUMBER", nullable: false }], // B disappeared, C is new
      primaryKey: ["A"],
      fetchedAt: "2026-02-01T00:00:00Z",
    };
    newCatalog.columns.push({ name: "C", type: "DATE", nullable: true });

    const result = await catalogPush({
      serverUrl: "http://x",
      token: "agent-tok",
      id: "t.sensor",
      catalog: newCatalog,
      fetchImpl: fetchImplFromApp(app),
    });
    assert.equal(typeof result.rev, "string");

    const got = await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/t.sensor",
      headers: { authorization: "Bearer ed-tok" },
    });
    const doc = got.json().json;
    assert.deepEqual(doc.body.catalog, newCatalog, "catalog fully replaced");
    assert.equal(
      doc.body.columnDescs.A.tier,
      "inferred",
      "non-scaffold slot for a still-present column is untouched",
    );
    assert.equal(doc.body.columnDescs.A.text, "센서 식별자.");
    assert.ok(
      !("B" in doc.body.columnDescs),
      "scaffold slot for a vanished column is dropped, not deprecated",
    );
    assert.equal(
      doc.body.columnDescs.C.tier,
      "scaffold",
      "new column gets a fresh scaffold slot",
    );
  } finally {
    await cleanup();
  }
});

test("catalog-push: vanished column with a non-scaffold slot is deprecated, not dropped", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await seedSensorDoc(app); // A is "inferred", B is "scaffold" (see seedSensorDoc)
    // Push a catalog where A (inferred) has vanished — B (scaffold) vanishing
    // is already covered by the previous test, so this pushes A out instead.
    const result = await catalogPush({
      serverUrl: "http://x",
      token: "agent-tok",
      id: "t.sensor",
      catalog: {
        columns: [{ name: "B", type: "VARCHAR2(10)", nullable: true }],
        primaryKey: [],
        fetchedAt: "2026-02-01T00:00:00Z",
      },
      fetchImpl: fetchImplFromApp(app),
    });
    assert.equal(typeof result.rev, "string");

    const got = await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/t.sensor",
      headers: { authorization: "Bearer ed-tok" },
    });
    const doc = got.json().json;
    assert.equal(
      doc.body.columnDescs.A.tier,
      "deprecated",
      "non-scaffold slot for a vanished column is deprecated, text/evidence preserved",
    );
    assert.equal(doc.body.columnDescs.A.text, "센서 식별자.");
  } finally {
    await cleanup();
  }
});

test("catalog-push: doc does not exist -> AkgApiError(404)", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await assert.rejects(
      catalogPush({
        serverUrl: "http://x",
        token: "agent-tok",
        id: "t.nosuchtable",
        catalog: {
          columns: [{ name: "A", type: "NUMBER", nullable: false }],
          primaryKey: ["A"],
          fetchedAt: "2026-01-01T00:00:00Z",
        },
        fetchImpl: fetchImplFromApp(app),
      }),
      (err) => {
        assert.ok(err instanceof AkgApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("catalog-push: invalid catalog (empty columns) -> AkgApiError(400)", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await seedSensorDoc(app);
    await assert.rejects(
      catalogPush({
        serverUrl: "http://x",
        token: "agent-tok",
        id: "t.sensor",
        catalog: {
          columns: [],
          primaryKey: [],
          fetchedAt: "2026-01-01T00:00:00Z",
        }, // minItems 1 violated
        fetchImpl: fetchImplFromApp(app),
      }),
      (err) => {
        assert.ok(err instanceof AkgApiError);
        assert.equal(err.status, 400);
        assert.match(err.message, /validation_failed/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});
