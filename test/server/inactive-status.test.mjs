// Issue #7 — the inactive state. The injection budget is 2 docs per turn, so
// a bulk import that lands active does not just add noise: its skeleton docs
// compete for the same two slots as docs a human confirmed. These tests pin
// the property that makes bulk loading safe — an inactive doc is readable
// through the API and absent from every derivative that leaves the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { readJson } from "../../server/store.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-inactive-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
    { id: "ap", role: "approver", tokenHash: hashToken("aptok") },
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

function doc(overrides = {}) {
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
    ...overrides,
  };
}

const MD = "rendered/db-schema/docs/x.md";

async function create(app, payload) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload,
  });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json().rev;
}

async function transition(app, action, rev, token = "aptok") {
  return app.inject({
    method: "POST",
    url: `/api/docs/db-schema/x/${action}`,
    headers: { ...auth(token), "if-match": rev },
  });
}

const indexOf = (storeDir) =>
  readJson(storeDir, "rendered/db-schema/index.json") ?? [];

test("a doc created inactive produces no md and no index entry", async () => {
  const { app, storeDir, cleanup } = await setup();
  await create(app, doc({ status: "inactive" }));

  assert.equal(existsSync(join(storeDir, MD)), false);
  assert.deepEqual(indexOf(storeDir), []);

  // ...but it is a first-class document to anyone asking the server. This is
  // the whole point of choosing "inactive" over "don't import it yet".
  const read = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x",
    headers: auth("edtok"),
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json().json.status, "inactive");

  const list = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: auth("edtok"),
  });
  assert.ok(list.json().docs.some((d) => d.id === "x"));

  await cleanup();
});

test("an inactive doc still previews, byte-identical to what activating would publish", async () => {
  const { app, cleanup } = await setup();
  const rev = await create(app, doc());

  const published = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x?format=md",
    headers: auth("edtok"),
  });
  assert.equal(published.statusCode, 200);
  assert.ok(published.payload.length > 0);

  await transition(app, "deactivate", rev);

  // There is no file in rendered/ any more, so this can only come from
  // rendering the JSON — and it has to agree with the published bytes, or
  // reviewers would be judging something other than what they turn on.
  const preview = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x?format=md",
    headers: auth("edtok"),
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.payload, published.payload);

  const full = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x",
    headers: auth("edtok"),
  });
  assert.equal(full.json().md, published.payload);

  await cleanup();
});

test("deactivating an active doc deletes the md it already published", async () => {
  const { app, storeDir, cleanup } = await setup();
  const rev = await create(app, doc());

  // Precondition: it really was published, so the assertion below is about
  // removal and not about a file that never existed.
  assert.equal(existsSync(join(storeDir, MD)), true);
  assert.equal(indexOf(storeDir).length, 1);

  const off = await transition(app, "deactivate", rev);
  assert.equal(off.statusCode, 200, off.payload);

  assert.equal(existsSync(join(storeDir, MD)), false);
  assert.deepEqual(indexOf(storeDir), []);

  await cleanup();
});

test("an inactive doc is absent from the bundle every mirror installs", async () => {
  const { app, storeDir, cleanup } = await setup();
  const rev = await create(app, doc());
  await transition(app, "deactivate", rev);

  const res = await app.inject({
    method: "GET",
    url: "/api/bundle",
    headers: auth("edtok"),
  });
  assert.equal(res.statusCode, 200);

  // Read the tar's own listing rather than trusting the filesystem check
  // above: the bundle is what actually reaches users, and it is built by
  // tarring rendered/ wholesale.
  const listing = spawnSync("tar", ["-tzf", "-"], {
    input: res.rawPayload,
    encoding: "utf8",
  }).stdout;
  assert.ok(!listing.includes("x.md"), listing);

  await cleanup();
});

test("reactivating republishes the md and the index entry", async () => {
  const { app, storeDir, cleanup } = await setup();
  const rev = await create(app, doc());
  const off = await transition(app, "deactivate", rev);

  const on = await transition(app, "activate", off.json().rev);
  assert.equal(on.statusCode, 200, on.payload);

  assert.equal(existsSync(join(storeDir, MD)), true);
  assert.deepEqual(indexOf(storeDir), [
    { keywords: ["x"], path: "docs/x.md" },
  ]);

  await cleanup();
});

test("archiving also removes the md — the pre-existing leak this closes", async () => {
  const { app, storeDir, cleanup } = await setup();
  await create(app, doc());
  assert.equal(existsSync(join(storeDir, MD)), true);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/x",
    headers: auth("aptok"),
  });
  assert.equal(del.statusCode, 200, del.payload);

  // Archiving only ever dropped the index entry; the rendered md stayed in
  // rendered/, and /api/bundle tars that directory whole — so a "deleted"
  // doc kept shipping to every mirror.
  assert.equal(existsSync(join(storeDir, MD)), false);

  await cleanup();
});

test("turning a doc on is an approver decision, and needs a matching rev", async () => {
  const { app, cleanup } = await setup();
  const rev = await create(app, doc({ status: "inactive" }));

  const asEditor = await transition(app, "activate", rev, "edtok");
  assert.equal(asEditor.statusCode, 403);

  const noMatch = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/x/activate",
    headers: auth("aptok"),
  });
  assert.equal(noMatch.statusCode, 428);

  const stale = await transition(app, "activate", "0".repeat(40));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, "unknown_base_rev");

  const ok = await transition(app, "activate", rev);
  assert.equal(ok.statusCode, 200, ok.payload);

  await cleanup();
});

test("repeating a transition is a no-op, and archived docs stay archived", async () => {
  const { app, cleanup } = await setup();
  const rev = await create(app, doc());

  // Committing an identical tree would fail inside git, so the route has to
  // recognise the no-op rather than attempt it.
  const again = await transition(app, "activate", rev);
  assert.equal(again.statusCode, 200, again.payload);
  assert.equal(again.json().unchanged, true);
  assert.equal(again.json().rev, rev);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/x",
    headers: auth("aptok"),
  });
  const revived = await transition(app, "activate", del.json().rev);
  assert.equal(revived.statusCode, 400);
  assert.equal(revived.json().error, "doc_archived");

  await cleanup();
});
