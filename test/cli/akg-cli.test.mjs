// End-to-end CLI tests: a REAL listening HTTP server (buildApp().listen)
// plus an actual `node bin/akg.mjs ...` child process — proves argument
// parsing, JSON file reading, env-based config resolution, and exit codes
// all work as wired, not just the underlying src/client/*.mjs functions
// (which test/client/*.test.mjs already covers via app.inject).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// --- push (issue #18) ------------------------------------------------------

const GOLDEN_SPEC = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../../examples/domain-skill/fdc-explain-sensor.json", import.meta.url),
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

test("cli push: a bare spec.json creates the doc, and a second run updates it", async () => {
  const { app, serverUrl, cleanup } = await setupServer();
  const home = mkdtempSync(join(tmpdir(), "akg-cli-push-"));
  try {
    const specPath = join(home, "spec.json");
    writeFileSync(specPath, JSON.stringify(GOLDEN_SPEC));

    const first = await runCli(["push", "domain-skill", specPath], {
      token: "ed-tok",
      serverUrl,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^created domain-skill\/fdc-explain-sensor \(rev /);

    // The hub now serves the skill — this is the whole point of the command.
    const md = await app.inject({
      method: "GET",
      url: "/api/docs/domain-skill/fdc-explain-sensor?format=md",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(md.statusCode, 200);
    assert.match(md.body, /^---\nname: fdc-explain-sensor\n/);

    writeFileSync(
      specPath,
      JSON.stringify({ ...GOLDEN_SPEC, focus: "정체·소속 설비·현재 상태와 이력" }),
    );
    const second = await runCli(["push", "domain-skill", specPath], {
      token: "ed-tok",
      serverUrl,
    });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /^updated domain-skill\/fdc-explain-sensor \(rev /);
  } finally {
    rmSync(home, { recursive: true, force: true });
    await cleanup();
  }
});

test("cli push --dry-run: renders the skill with no token, no server, and writes nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-dryrun-"));
  try {
    const specPath = join(home, "spec.json");
    writeFileSync(specPath, JSON.stringify(GOLDEN_SPEC));

    const r = await runCliBare(["push", "domain-skill", specPath, "--dry-run"], home);
    assert.equal(r.status, 0, r.stderr);
    // The preview IS the SKILL.md the factory used to print locally.
    assert.match(r.stdout, /^---\nname: fdc-explain-sensor\n/);
    assert.match(r.stdout, /## 조회 절차/);
    assert.match(r.stderr, /DRY-RUN/);
    // Nothing about a missing token or server, because it needs neither.
    assert.doesNotMatch(r.stderr, /no token|no server URL/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli push: an invalid spec fails on validation, before it ever calls the server", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-badspec-"));
  try {
    const specPath = join(home, "spec.json");
    // A v1 field that spec v2 removed — the exact thing "unknown keys are
    // rejected" exists to catch.
    writeFileSync(
      specPath,
      JSON.stringify({ ...GOLDEN_SPEC, description: "손으로 쓴 라우팅 문장" }),
    );

    // A server URL that cannot possibly answer: if validation did not happen
    // first, this would fail with a connection error instead.
    const r = await runCli(["push", "domain-skill", specPath], {
      token: "ed-tok",
      serverUrl: "http://127.0.0.1:1",
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /검증 실패/);
    assert.match(r.stderr, /description/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli push: a body with no derivable id says which field is missing", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-cli-noid-"));
  try {
    const specPath = join(home, "spec.json");
    const { name, ...noName } = GOLDEN_SPEC;
    writeFileSync(specPath, JSON.stringify(noName));

    const r = await runCliBare(["push", "domain-skill", specPath, "--dry-run"], home);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /`name` 이 필요합니다/);
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
