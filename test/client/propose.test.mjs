// akg CLI `propose` (design §8.1) — src/client/propose.mjs against a REAL
// in-process server (Phase 1's buildApp(), app.inject — no network), same
// adapter pattern as test/mirror/sync.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { propose } from "../../src/client/propose.mjs";
import { AkgApiError } from "../../src/client/errors.mjs";

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-propose-server-"));
  saveUsers(join(home, "users.json"), [
    { id: "viewer1", role: "viewer", tokenHash: hashToken("view-tok") },
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

// Generic app.inject-backed fetchImpl: unlike sync's GET-only adapter, this
// respects opts.method/headers/body so it can drive POST/PUT actions too.
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

const SLOTS = {
  purpose: {
    text: "센서 원시값 로그.",
    tier: "inferred",
    evidence: ["ingest.py:12"],
  },
};

test("propose: success -> 201, lands in the pending queue", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const result = await propose({
      serverUrl: "http://x",
      token: "agent-tok",
      type: "db-schema",
      id: "t.sensor",
      slots: SLOTS,
      fetchImpl: fetchImplFromApp(app),
    });
    assert.equal(result.deduped, false);
    assert.equal(typeof result.id, "string");

    const list = await app.inject({
      method: "GET",
      url: "/api/proposals",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(list.statusCode, 200);
    const { proposals } = list.json();
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].id, result.id);
    assert.equal(proposals[0].type, "db-schema");
    assert.equal(proposals[0].docId, "t.sensor");
    assert.deepEqual(proposals[0].slots, SLOTS);
    assert.equal(proposals[0].submittedBy, "agent1");
  } finally {
    await cleanup();
  }
});

test("propose: identical resubmission dedups (S8) -> same id, deduped true", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const fetchImpl = fetchImplFromApp(app);
    const first = await propose({
      serverUrl: "http://x",
      token: "agent-tok",
      type: "db-schema",
      id: "t.sensor",
      slots: SLOTS,
      fetchImpl,
    });
    const second = await propose({
      serverUrl: "http://x",
      token: "agent-tok",
      type: "db-schema",
      id: "t.sensor",
      slots: SLOTS,
      fetchImpl,
    });
    assert.equal(second.id, first.id);
    assert.equal(second.deduped, true);

    const list = await app.inject({
      method: "GET",
      url: "/api/proposals",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(
      list.json().proposals.length,
      1,
      "dedup must not create a second pending entry",
    );
  } finally {
    await cleanup();
  }
});

test("propose: unknown type -> AkgApiError(400)", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await assert.rejects(
      propose({
        serverUrl: "http://x",
        token: "agent-tok",
        type: "not-a-type",
        id: "x",
        slots: SLOTS,
        fetchImpl: fetchImplFromApp(app),
      }),
      (err) => {
        assert.ok(err instanceof AkgApiError);
        assert.equal(err.status, 400);
        assert.match(err.message, /unknown_type/);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("propose: viewer role (not agent/editor) -> AkgApiError(403)", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await assert.rejects(
      propose({
        serverUrl: "http://x",
        token: "view-tok",
        type: "db-schema",
        id: "t.sensor",
        slots: SLOTS,
        fetchImpl: fetchImplFromApp(app),
      }),
      (err) => {
        assert.ok(err instanceof AkgApiError);
        assert.equal(err.status, 403);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});

test("propose: bad token -> AkgApiError(401)", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await assert.rejects(
      propose({
        serverUrl: "http://x",
        token: "not-a-real-token",
        type: "db-schema",
        id: "t.sensor",
        slots: SLOTS,
        fetchImpl: fetchImplFromApp(app),
      }),
      (err) => {
        assert.ok(err instanceof AkgApiError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});
