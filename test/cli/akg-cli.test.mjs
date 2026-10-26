// End-to-end CLI tests: a REAL listening HTTP server (buildApp().listen)
// plus an actual `node bin/akg.mjs ...` child process — proves argument
// parsing, JSON file reading, env-based config resolution, and exit codes
// all work as wired, not just the underlying src/client/*.mjs functions
// (which test/client/*.test.mjs already covers via app.inject).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const BIN = fileURLToPath(new URL("../../bin/akg.mjs", import.meta.url));

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-server-"));
  const signedIn = await signIn(home, [
    { id: "editor1", group: "admin", token: "ed-tok" },
    { id: "agent1", group: "agent", token: "agent-tok" },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    auth: signedIn,
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
      headers: as("ed-tok"),
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

test("cli propose: the type is checked against the mirror's types.json, or the CLI's own list without one", async () => {
  const { serverUrl, cleanup } = await setupServer();
  const dir = mkdtempSync(join(tmpdir(), "akg-cli-propose-type-"));
  try {
    const proposalPath = join(dir, "proposal.json");
    writeFileSync(proposalPath, JSON.stringify({ slots: { x: { text: "y", tier: "inferred", evidence: ["z"] } } }));
    const run = (spec, mirror) =>
      runCli(["propose", spec, proposalPath, "--mirror", mirror], { serverUrl });

    const bare = join(dir, "bare");
    const unknown = await run("meeting-notes/w1", bare);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /모르는 타입 "meeting-notes"/);

    const synced = join(dir, "synced");
    mkdirSync(synced);
    writeFileSync(join(synced, "types.json"), JSON.stringify({ types: [{ id: "db-schema" }, { id: "meeting-notes" }] }));
    const listed = await run("meeting-notes/w1", synced);
    assert.doesNotMatch(listed.stderr, /모르는 타입/, "the type check passes; the server answers the rest");
    const dropped = await run("voc/v", synced);
    assert.match(dropped.stderr, /모르는 타입 "voc"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await cleanup();
  }
});

test("cli catalog-push: end-to-end success -> exit 0, catalog replaced on the doc", async () => {
  const { app, serverUrl, cleanup } = await setupServer();
  try {
    const seeded = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: as("ed-tok"),
      payload: {
        schema: "db-schema/v1",
        id: "sensor",
        keywords: [{ kw: "sensor", inject: "full" }],
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

    // a qualified owner.table argument is still accepted — the CLI strips the
    // owner part, so the API call targets the bare-table id "sensor"
    const r = await runCli(["catalog-push", "t.sensor", describePath], {
      serverUrl,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^catalog pushed: db-schema\/sensor \(rev /);

    const got = await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/sensor",
      headers: as("ed-tok"),
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

// --- push (issue #18) ------------------------------------------------------

const GOLDEN_SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../examples/domain-skill/fdc-explain-sensor-origin.json", import.meta.url),
    ),
    "utf8",
  ),
).body;

/** A child with NO akg env at all, and a HOME with no token file. */
function runCliBare(args, home) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home };
    delete env.AKG_TOKEN;
    delete env.AKG_SERVER;
    delete env.AKG_MIRROR;
    const child = spawn("node", [BIN, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("cli push: --create a .md, edit it, a stale --rev is exit 1 with 'sync 뒤 다시'", async () => {
  const { app, serverUrl, cleanup } = await setupServer();
  const dir = mkdtempSync(join(tmpdir(), "akg-cli-push-"));
  try {
    const md = join(dir, "n.md");
    writeFileSync(md, "# n\n\n첫 글\n");
    const missing = await runCli(["push", "voc/n", md], { serverUrl });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--create 로 만든다/);

    const created = await runCli(["push", "voc/n", md, "--create"], { serverUrl });
    assert.equal(created.status, 0, created.stderr);
    const rev0 = created.stdout.match(/pushed voc\/n \(rev (\w+)\)/)[1];

    writeFileSync(md, "# n\n\n고친 글\n");
    const edited = await runCli(["push", "voc/n", md, "--note", "cc 수정"], { serverUrl });
    assert.equal(edited.status, 0, edited.stderr);
    assert.match(edited.stdout, /pushed voc\/n \(rev \w+\)/);

    writeFileSync(md, "# n\n\n옛 rev 위 글\n");
    const stale = await runCli(["push", "voc/n", md, "--rev", rev0], { serverUrl });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /sync 뒤 다시/);

    const got = await app.inject({ method: "GET", url: "/api/docs/voc/n", headers: as("ed-tok") });
    assert.equal(got.json().json.body.markdown, "# n\n\n고친 글\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await cleanup();
  }
});

test("cli push --dry-run: checks the file with no token and no server", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-push-dry-"));
  try {
    const good = join(home, "n.json");
    writeFileSync(good, JSON.stringify({ schema: "voc/v1", id: "n", status: "active", body: { name: "n", markdown: "# n\n" } }));
    const ok = await runCliBare(["push", "voc/n", good, "--dry-run"], home);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /dry-run ok: voc\/n/);

    const wrongId = await runCliBare(["push", "voc/m", good, "--dry-run"], home);
    assert.equal(wrongId.status, 1);
    assert.match(wrongId.stderr, /id 가 "m"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
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
