// Issue #12 — the two routes that make bulk loading possible: batch create
// (R3) and the type-agnostic facts upsert (R4). What both have to guarantee is
// that a machine can fill the corpus without ever reaching a prompt or
// overwriting somebody's interpretation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { readJson } from "../../server/store.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-bulk-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
    { id: "ap", role: "approver", tokenHash: hashToken("aptok") },
    { id: "bot", role: "agent", tokenHash: hashToken("bottok") },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, usersPath: join(home, "users.json") });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const auth = (t) => ({ authorization: `Bearer ${t}` });

// db-schema carries the invariant id === lower(table) — owner stays a plain
// body attribute that never qualifies the id — so the fixture derives the
// table from the id rather than inventing it.
function dbDoc(id, columns = ["A"]) {
  const table = id.toUpperCase();
  return {
    schema: "db-schema/v1",
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "active", // deliberately: the route must override this
    body: {
      owner: "T",
      table,
      catalog: {
        columns: columns.map((name) => ({
          name,
          type: "NUMBER",
          nullable: false,
        })),
        primaryKey: [columns[0]],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: Object.fromEntries(
        columns.map((c) => [c, { text: null, tier: "scaffold" }]),
      ),
    },
  };
}

const batch = (app, docs, token = "edtok", extra = {}) =>
  app.inject({
    method: "POST",
    url: "/api/docs/db-schema/batch",
    headers: auth(token),
    payload: { docs, ...extra },
  });

const facts = (app, id, body, token = "bottok") =>
  app.inject({
    method: "PUT",
    url: `/api/docs/db-schema/${id}/facts`,
    headers: auth(token),
    payload: body,
  });

test("a batch lands as one commit, and every document lands inactive", async () => {
  const { app, storeDir, cleanup } = await setup();

  const before = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: auth("edtok"),
  });
  const countBefore = before.json().entries.length;

  const res = await batch(app, [dbDoc("a"), dbDoc("b"), dbDoc("c")]);
  assert.equal(res.statusCode, 201, res.payload);
  assert.deepEqual(res.json().created, ["a", "b", "c"]);

  // Submitted as active; the route is what decides, not the caller — otherwise
  // an importer could put a few hundred skeletons straight into the budget.
  for (const id of ["a", "b", "c"]) {
    assert.equal(readJson(storeDir, `db-schema/${id}.json`).status, "inactive");
    assert.equal(
      existsSync(join(storeDir, `rendered/db-schema/docs/${id}.md`)),
      false,
    );
  }
  assert.deepEqual(
    readJson(storeDir, "rendered/db-schema/index.json") ?? [],
    [],
  );

  const after = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: auth("edtok"),
  });
  assert.equal(after.json().entries.length, countBefore + 1);

  await cleanup();
});

test("one bad document rejects the whole batch, leaving nothing written", async () => {
  const { app, storeDir, cleanup } = await setup();

  const bad = dbDoc("bad");
  delete bad.body.table; // fails the type schema (table is required)

  const res = await batch(app, [dbDoc("ok"), bad]);
  assert.equal(res.statusCode, 400);
  const { rejected } = res.json();
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, "bad");
  assert.equal(rejected[0].error, "validation_failed");

  // The valid one must not have landed: a half-applied import leaves the
  // caller guessing which half is there.
  assert.equal(readJson(storeDir, "db-schema/ok.json"), null);

  await cleanup();
});

test("a batch cannot smuggle a confirmed slot or a duplicate id", async () => {
  const { app, cleanup } = await setup();

  const sneaky = dbDoc("sneak");
  sneaky.body.purpose = {
    text: "확정인 척",
    tier: "confirmed",
    evidence: ["nope:1"],
  };
  const smuggle = await batch(app, [sneaky]);
  // applyEdit resolves it down; confirmed stays promote-only (D4).
  assert.equal(smuggle.statusCode, 201, smuggle.payload);
  const stored = smuggle.json();
  assert.equal(stored.created.length, 1);

  const dup = await batch(app, [dbDoc("dup"), dbDoc("dup")]);
  assert.equal(dup.statusCode, 400);
  assert.equal(dup.json().rejected[0].error, "duplicate_in_batch");

  await cleanup();
});

test("the created documents are never confirmed, whatever was submitted", async () => {
  const { app, storeDir, cleanup } = await setup();
  const sneaky = dbDoc("sneak");
  sneaky.body.purpose = {
    text: "확정인 척",
    tier: "confirmed",
    evidence: ["nope:1"],
  };
  await batch(app, [sneaky]);

  const purpose = readJson(storeDir, "db-schema/sneak.json").body.purpose;
  assert.notEqual(purpose.tier, "confirmed");

  await cleanup();
});

test("facts upsert creates when absent — inactive, like every bulk path", async () => {
  const { app, storeDir, cleanup } = await setup();

  const res = await facts(app, "new", dbDoc("new"));
  assert.equal(res.statusCode, 201, res.payload);
  assert.equal(res.json().created, true);
  assert.equal(readJson(storeDir, "db-schema/new.json").status, "inactive");

  await cleanup();
});

test("facts upsert replaces facts and leaves a confirmed slot untouched", async () => {
  const { app, storeDir, cleanup } = await setup();
  await facts(app, "x", dbDoc("x", ["A", "B"]));

  // Get a confirmed value in place the legitimate way: edit, then promote.
  const doc = readJson(storeDir, "db-schema/x.json");
  const body = structuredClone(doc.body);
  body.purpose = { text: "설비 계측값", tier: "inferred", evidence: ["fdc:1"] };
  const rev0 = (
    await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/x",
      headers: auth("edtok"),
    })
  ).json().rev;
  const put = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: body,
  });
  assert.equal(put.statusCode, 200, put.payload);
  const promoted = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/x/promote",
    headers: { ...auth("aptok"), "if-match": put.json().rev },
    payload: { slots: ["purpose"] },
  });
  assert.equal(promoted.statusCode, 200, promoted.payload);

  // Now push new facts: column C appears, B disappears.
  const push = await facts(app, "x", dbDoc("x", ["A", "C"]));
  assert.equal(push.statusCode, 200, push.payload);

  const after = readJson(storeDir, "db-schema/x.json").body;
  assert.equal(after.purpose.tier, "confirmed");
  assert.equal(after.purpose.text, "설비 계측값");
  assert.deepEqual(
    after.catalog.columns.map((c) => c.name),
    ["A", "C"],
  );
  assert.ok("C" in after.columnDescs);
  assert.equal(after.columnDescs.C.tier, "scaffold");
  // B was never annotated, so there is nothing to preserve.
  assert.equal("B" in after.columnDescs, false);
  assert.deepEqual(push.json().orphans, [
    { address: "columnDescs.B", outcome: "dropped" },
  ]);

  await cleanup();
});

test("an annotated slot whose column vanishes is kept as deprecated", async () => {
  const { app, storeDir, cleanup } = await setup();
  await facts(app, "y", dbDoc("y", ["A", "B"]));

  const rev = (
    await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/y",
      headers: auth("edtok"),
    })
  ).json().rev;
  const body = readJson(storeDir, "db-schema/y.json").body;
  body.columnDescs.B = {
    text: "곧 사라질 컬럼",
    tier: "inferred",
    evidence: ["code:1"],
  };
  await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/y",
    headers: { ...auth("edtok"), "if-match": rev },
    payload: body,
  });

  const push = await facts(app, "y", dbDoc("y", ["A"]));
  assert.equal(push.statusCode, 200, push.payload);

  const after = readJson(storeDir, "db-schema/y.json").body;
  assert.equal(after.columnDescs.B.tier, "deprecated");
  assert.equal(after.columnDescs.B.text, "곧 사라질 컬럼");
  assert.deepEqual(push.json().orphans, [
    { address: "columnDescs.B", outcome: "deprecated" },
  ]);

  await cleanup();
});

test("facts push ignores slot content in the incoming body", async () => {
  const { app, storeDir, cleanup } = await setup();

  const claiming = dbDoc("z");
  claiming.body.purpose = {
    text: "기계가 주장하는 해석",
    tier: "confirmed",
    evidence: ["bot:1"],
  };
  const res = await facts(app, "z", claiming);
  assert.equal(res.statusCode, 201, res.payload);

  // A machine replacing facts has no standing to assert an interpretation —
  // that is what propose is for.
  const after = readJson(storeDir, "db-schema/z.json").body;
  assert.equal(after.purpose.tier, "scaffold");
  assert.equal(after.purpose.text, null);

  await cleanup();
});

test("facts push works for msg-format too — the point of generalising it", async () => {
  const { app, storeDir, cleanup } = await setup();

  const msg = {
    schema: "msg-format/v1",
    id: "cmd-start",
    keywords: [{ kw: "cmd_start", inject: "full" }],
    status: "inactive",
    body: {
      command: "CMD_START",
      direction: "host->equipment",
      purpose: { text: null, tier: "scaffold" },
      fields: [
        {
          seq: 1,
          name: "LOT_ID",
          type: "A[16]",
          required: true,
          desc: { text: null, tier: "scaffold" },
        },
      ],
      examples: [{ label: "기동", payload: "S2F41 W" }],
    },
  };
  const res = await app.inject({
    method: "PUT",
    url: "/api/docs/msg-format/cmd-start/facts",
    headers: auth("bottok"),
    payload: msg,
  });
  assert.equal(res.statusCode, 201, res.payload);
  assert.equal(
    readJson(storeDir, "msg-format/cmd-start.json").body.command,
    "CMD_START",
  );

  await cleanup();
});

test("an agent may push facts but still cannot activate", async () => {
  const { app, cleanup } = await setup();
  const created = await batch(app, [dbDoc("p")], "bottok");
  assert.equal(created.statusCode, 201, created.payload);

  // Read with an editor token: an agent is its own bucket, outside the
  // viewer ladder (D6), so it cannot even GET what it just wrote.
  const rev = (
    await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/p",
      headers: auth("edtok"),
    })
  ).json().rev;
  const activate = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/p/activate",
    headers: { ...auth("bottok"), "if-match": rev },
  });
  // The whole safety argument for letting agents write facts: they cannot
  // decide what gets injected (#12 §7-2).
  assert.equal(activate.statusCode, 403);

  await cleanup();
});

test("an oversized batch says to split it, not just that it was too big", async () => {
  const { app, cleanup } = await setup();

  // Grown until it actually exceeds the limit, rather than trusting a count:
  // a magic number here would quietly stop testing anything the day the
  // fixture or the limit changes.
  const cols = ["A", "B", "C", "D", "E", "F", "G", "H"];
  const docs = [];
  while (Buffer.byteLength(JSON.stringify({ docs })) <= 512 * 1024) {
    docs.push(dbDoc(`t_${String(docs.length).padStart(4, "0")}`, cols));
  }
  const res = await batch(app, docs);

  assert.equal(res.statusCode, 413);
  const body = res.json();
  assert.equal(body.error, "payload_too_large");
  assert.equal(typeof body.limitBytes, "number");
  // The caller is a machine deciding what to do next; "too large" alone does
  // not tell it that the answer is smaller chunks.
  assert.match(body.message, /나눠/);

  await cleanup();
});

test("a runId is recorded where the audit view can see it", async () => {
  const { app, cleanup } = await setup();
  await batch(app, [dbDoc("r")], "bottok", { runId: "import-2026-07-22" });

  const audit = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: auth("edtok"),
  });
  assert.ok(
    audit.json().entries.some((e) => e.message.includes("import-2026-07-22")),
    JSON.stringify(audit.json().entries.slice(0, 3)),
  );

  const bad = await batch(app, [dbDoc("s")], "bottok", {
    runId: "no spaces allowed",
  });
  assert.equal(bad.statusCode, 400);

  await cleanup();
});
