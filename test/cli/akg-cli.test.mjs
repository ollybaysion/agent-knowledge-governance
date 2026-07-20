// End-to-end CLI tests: a REAL listening HTTP server (buildApp().listen)
// plus an actual `node bin/akg.mjs ...` child process — proves argument
// parsing, JSON file reading, env-based config resolution, and exit codes
// all work as wired, not just the underlying src/client/*.mjs functions
// (which test/client/*.test.mjs already covers via app.inject).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

const BIN = fileURLToPath(new URL("../../bin/akg.mjs", import.meta.url));

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-server-"));
  saveUsers(join(home, "users.json"), [
    { id: "editor1", role: "editor", tokenHash: hashToken("ed-tok") },
    { id: "agent1", role: "agent", tokenHash: hashToken("agent-tok") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const serverUrl = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app,
    serverUrl,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

// Async spawn, not spawnSync: spawning a child that itself makes outbound
// network calls (propose/catalog-push use fetch()) hangs indefinitely under
// spawnSync in this environment's sandboxed child_process — async spawn does
// not have that problem (confirmed by isolated repro before writing this).
function runCli(args, { token = "agent-tok", serverUrl }) {
  return new Promise((resolve) => {
    const child = spawn("node", [BIN, ...args], {
      env: { ...process.env, AKG_TOKEN: token, AKG_SERVER: serverUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("cli propose: end-to-end success -> exit 0, proposal lands in the queue", async () => {
  const { app, serverUrl, cleanup } = await setupServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "akg-cli-propose-"));
    const proposalPath = join(dir, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        slots: {
          purpose: {
            text: "센서 로그.",
            tier: "inferred",
            evidence: ["ingest.py:1"],
          },
        },
      }),
    );

    const r = await runCli(["propose", "db-schema/t.sensor", proposalPath], {
      serverUrl,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^proposed db-schema\/t\.sensor: /);

    const list = await app.inject({
      method: "GET",
      url: "/api/proposals",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(list.json().proposals.length, 1);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("cli propose: malformed proposal file (no slots key) -> exit 1, no HTTP call needed", async () => {
  const { serverUrl, cleanup } = await setupServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "akg-cli-propose-bad-"));
    const proposalPath = join(dir, "proposal.json");
    writeFileSync(proposalPath, JSON.stringify({ notSlots: true }));

    const r = await runCli(["propose", "db-schema/t.sensor", proposalPath], {
      serverUrl,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /must contain a non-empty "slots" object/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("cli propose: missing <type>/<id> slash -> exit 1, usage printed", async () => {
  const { serverUrl, cleanup } = await setupServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "akg-cli-propose-usage-"));
    const proposalPath = join(dir, "proposal.json");
    writeFileSync(
      proposalPath,
      JSON.stringify({
        slots: { x: { text: "y", tier: "inferred", evidence: ["z"] } },
      }),
    );

    const r = await runCli(["propose", "not-a-type-slash-id", proposalPath], {
      serverUrl,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage:/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("cli catalog-push: end-to-end success -> exit 0, catalog replaced on the doc", async () => {
  const { app, serverUrl, cleanup } = await setupServer();
  try {
    const seeded = await app.inject({
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
            columns: [{ name: "A", type: "NUMBER", nullable: false }],
            primaryKey: ["A"],
            fetchedAt: "2026-01-01T00:00:00Z",
          },
          purpose: { text: null, tier: "scaffold" },
          columnDescs: { A: { text: null, tier: "scaffold" } },
        },
      },
    });
    assert.equal(seeded.statusCode, 201, seeded.body);

    const dir = mkdtempSync(join(tmpdir(), "akg-cli-catalog-"));
    const describePath = join(dir, "describe.json");
    writeFileSync(
      describePath,
      JSON.stringify({
        columns: [
          { name: "A", type: "NUMBER", nullable: false },
          { name: "B", type: "DATE", nullable: true },
        ],
        primaryKey: ["A"],
        fetchedAt: "2026-03-01T00:00:00Z",
      }),
    );

    const r = await runCli(["catalog-push", "t.sensor", describePath], {
      serverUrl,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^catalog pushed: db-schema\/t\.sensor \(rev /);

    const got = await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/t.sensor",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(got.json().json.body.catalog.columns.length, 2);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("cli catalog-push: target doc missing -> exit 1, 404 hint printed", async () => {
  const { serverUrl, cleanup } = await setupServer();
  try {
    const dir = mkdtempSync(join(tmpdir(), "akg-cli-catalog-404-"));
    const describePath = join(dir, "describe.json");
    writeFileSync(
      describePath,
      JSON.stringify({
        columns: [{ name: "A", type: "NUMBER", nullable: false }],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      }),
    );

    const r = await runCli(["catalog-push", "t.nosuchtable", describePath], {
      serverUrl,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /does not exist yet/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await cleanup();
  }
});

test("cli: unknown command -> exit 1, usage printed", async () => {
  const { serverUrl, cleanup } = await setupServer();
  try {
    const r = await runCli(["bogus-command"], { serverUrl });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /usage:/);
  } finally {
    await cleanup();
  }
});
