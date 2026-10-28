// POST /api/docs/:type/activate — the 문서 list's 활성화: several documents
// of one type on at once, the ones that pass in one commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { ACTIVATE_MAX, activateItems } from "../../server/routes/docs.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-bulk-activate-"));
  const auth = await signIn(home, [
    { id: "ad", group: "admin", token: "adtok" },
    { id: "bot", group: "agent", token: "agtok" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const doc = (id, status = "inactive") => ({
  schema: "db-schema/v1",
  id,
  keywords: [{ kw: id, inject: "full" }],
  status,
  body: {
    owner: "T",
    table: id.toUpperCase(),
    catalog: {
      columns: [{ name: "A", type: "NUMBER", nullable: false }],
      primaryKey: ["A"],
      fetchedAt: "2026-01-01T00:00:00Z",
    },
    purpose: { text: null, tier: "scaffold" },
    columnDescs: { A: { text: null, tier: "scaffold" } },
  },
});

async function create(app, payload) {
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: as("adtok"),
    payload,
  });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json().rev;
}

const activate = (app, payload, token = "adtok", type = "db-schema") =>
  app.inject({
    method: "POST",
    url: `/api/docs/${type}/activate`,
    headers: as(token),
    payload,
  });

const commits = (storeDir) =>
  Number(
    spawnSync("git", ["-C", storeDir, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).stdout.trim(),
  );
const md = (storeDir, id) =>
  existsSync(join(storeDir, `rendered/db-schema/docs/${id}.md`));

test("activateItems takes 1 to ACTIVATE_MAX distinct {id, rev}", () => {
  assert.deepEqual(
    activateItems({ items: [{ id: "a", rev: "r", extra: 1 }] }),
    [{ id: "a", rev: "r" }],
  );
  for (const body of [
    null,
    {},
    { items: [] },
    { items: "a" },
    { items: [{ id: "a" }] },
    { items: [{ id: "a", rev: "" }] },
    { items: [{ id: "../a", rev: "r" }] },
    {
      items: [
        { id: "a", rev: "r" },
        { id: "a", rev: "s" },
      ],
    },
    {
      items: Array.from({ length: ACTIVATE_MAX + 1 }, (_, i) => ({
        id: `d${i}`,
        rev: "r",
      })),
    },
  ])
    assert.equal(activateItems(body), null, JSON.stringify(body)?.slice(0, 80));
});

test("only an admin turns documents on; a malformed body is 400 invalid_body", async () => {
  const { app, cleanup } = await setup();
  try {
    const rev = await create(app, doc("a"));
    const items = [{ id: "a", rev }];
    assert.equal((await activate(app, { items }, "reader")).statusCode, 403);
    assert.equal((await activate(app, { items }, "agtok")).statusCode, 403);
    const empty = await activate(app, { items: [] });
    assert.equal(empty.statusCode, 400);
    assert.equal(empty.json().error, "invalid_body");
    const twice = await activate(app, { items: [...items, ...items] });
    assert.equal(twice.json().error, "invalid_body");
    const noType = await activate(app, { items }, "adtok", "no-such-type");
    assert.equal(noType.json().error, "unknown_type");
  } finally {
    await cleanup();
  }
});

test("the ones that pass go on in one commit; a stale rev, an active one and a missing one come back in results", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const a = await create(app, doc("a"));
    const b = await create(app, doc("b"));
    await create(app, doc("c"));
    const d = await create(app, doc("d", "active"));
    const before = commits(storeDir);

    const res = await activate(app, {
      items: [
        { id: "a", rev: a },
        { id: "c", rev: "0".repeat(40) },
        { id: "d", rev: d },
        { id: "b", rev: b },
        { id: "zz", rev: a },
      ],
    });
    assert.equal(res.statusCode, 200, res.payload);
    const body = res.json();
    assert.equal(body.activated, 2);
    const c = body.results.find((r) => r.id === "c");
    assert.equal(c.status, "error");
    assert.equal(c.error, "unknown_base_rev");
    assert.match(c.currentRev, /^[0-9a-f]{40}$/);
    assert.deepEqual(
      body.results.map(({ id, status, error }) => ({
        id,
        status,
        ...(error ? { error } : {}),
      })),
      [
        { id: "a", status: "active" },
        { id: "c", status: "error", error: "unknown_base_rev" },
        { id: "d", status: "skipped", error: "already_active" },
        { id: "b", status: "active" },
        { id: "zz", status: "error", error: "not_found" },
      ],
    );

    assert.equal(commits(storeDir), before + 1);
    assert.equal(md(storeDir, "a"), true);
    assert.equal(md(storeDir, "b"), true);
    assert.equal(md(storeDir, "c"), false);
    const list = (
      await app.inject({
        method: "GET",
        url: "/api/docs?type=db-schema",
        headers: as("reader"),
      })
    ).json().docs;
    assert.deepEqual(Object.fromEntries(list.map((x) => [x.id, x.status])), {
      a: "active",
      b: "active",
      c: "inactive",
      d: "active",
    });
    const index = JSON.parse(
      spawnSync(
        "git",
        ["-C", storeDir, "show", "HEAD:rendered/db-schema/index.json"],
        { encoding: "utf8" },
      ).stdout,
    );
    assert.deepEqual(index.map((e) => e.path).sort(), [
      "docs/a.md",
      "docs/b.md",
      "docs/d.md",
    ]);
  } finally {
    await cleanup();
  }
});

test("an archived document is refused as the single route refuses it; nothing to turn on makes no commit", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const x = await create(app, doc("x", "archived"));
    const d = await create(app, doc("d", "active"));
    const before = commits(storeDir);
    const res = await activate(app, {
      items: [
        { id: "x", rev: x },
        { id: "d", rev: d },
      ],
    });
    assert.equal(res.statusCode, 200, res.payload);
    assert.deepEqual(res.json(), {
      results: [
        { id: "x", status: "error", error: "doc_archived" },
        { id: "d", status: "skipped", error: "already_active" },
      ],
      activated: 0,
    });
    assert.equal(commits(storeDir), before);
  } finally {
    await cleanup();
  }
});
