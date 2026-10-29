// rendered/<type>/index.json is updated in place: a write takes out the
// entries of the docs it writes or drops and puts in their new ones. After
// every write path the file must equal a full compile of the same store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { archiveDoc, compileIndex, sortIndex } from "../../server/render-store.mjs";
import { commitFiles, listIds, readJson } from "../../server/store.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-index-incremental-test-"));
  const signedIn = await signIn(home, [{ id: "renoir", group: "admin", token: "aptok" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth: signedIn });
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as("aptok"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const revOf = async (type, id) => (await call("GET", `/api/docs/${type}/${id}`)).json().rev;
  const ok = async (res, code = 200) => {
    assert.equal(res.statusCode, code, res.body);
    return res.json();
  };
  return {
    storeDir,
    call,
    revOf,
    ok,
    // The stored index against a full compile of every stored doc of the type.
    assertIndexIsFullCompile(type = "db-schema") {
      const docs = listIds(storeDir, type).map((id) => readJson(storeDir, `${type}/${id}.json`));
      assert.deepEqual(readJson(storeDir, `rendered/${type}/index.json`), sortIndex(compileIndex(docs)));
    },
    indexText: () => readFileSync(join(storeDir, "rendered/db-schema/index.json"), "utf8"),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function table(name, extra = {}) {
  return {
    schema: "db-schema/v1",
    id: name,
    keywords: [
      { kw: name, inject: "full" },
      { kw: `${name}-wide`, inject: "pointer" },
    ],
    status: "active",
    ...extra,
    body: {
      owner: "T",
      table: name.toUpperCase(),
      catalog: { columns: [{ name: "A", type: "NUMBER", nullable: false }], primaryKey: ["A"], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

test("create · edit · links · deactivate · activate · archive: the index equals a full compile after each", async () => {
  const t = await setup();
  try {
    for (const id of ["m", "b", "z", "a_b", "a"]) await t.ok(await t.call("POST", "/api/docs/db-schema", table(id)), 201);
    t.assertIndexIsFullCompile();
    assert.deepEqual(
      readJson(t.storeDir, "rendered/db-schema/index.json").map((e) => [e.path, e.precision ?? 1]),
      [
        ["docs/a.md", 1], ["docs/a.md", 0.5], ["docs/a_b.md", 1], ["docs/a_b.md", 0.5], ["docs/b.md", 1],
        ["docs/b.md", 0.5], ["docs/m.md", 1], ["docs/m.md", 0.5], ["docs/z.md", 1], ["docs/z.md", 0.5],
      ],
    );

    const links = [{ type: "db-schema", id: "a", rel: "related" }];
    await t.ok(await t.call("PUT", "/api/docs/db-schema/b/links", { links }, { "if-match": await t.revOf("db-schema", "b") }));
    t.assertIndexIsFullCompile();
    assert.deepEqual(readJson(t.storeDir, "rendered/db-schema/index.json").find((e) => e.path === "docs/b.md").links, links);

    const off = await t.ok(await t.call("POST", "/api/docs/db-schema/m/deactivate", undefined, { "if-match": await t.revOf("db-schema", "m") }));
    t.assertIndexIsFullCompile();
    assert.equal(readJson(t.storeDir, "rendered/db-schema/index.json").some((e) => e.path === "docs/m.md"), false);
    await t.ok(await t.call("POST", "/api/docs/db-schema/m/activate", undefined, { "if-match": off.rev }));
    t.assertIndexIsFullCompile();

    await archiveDoc(t.storeDir, "db-schema", readJson(t.storeDir, "db-schema/z.json"), { author: "renoir", message: "archive z" });
    t.assertIndexIsFullCompile();
    assert.equal(readJson(t.storeDir, "rendered/db-schema/index.json").some((e) => e.path === "docs/z.md"), false);
  } finally {
    await t.cleanup();
  }
});

test("DELETE drops the doc's entries and updates the entries of the docs that linked to it", async () => {
  const t = await setup();
  try {
    await t.ok(await t.call("POST", "/api/docs/db-schema", table("x")), 201);
    await t.ok(await t.call("POST", "/api/docs/db-schema", table("y", { links: [{ type: "db-schema", id: "x", rel: "related" }] })), 201);
    await t.ok(await t.call("POST", "/api/docs/db-schema", table("w")), 201);
    await t.ok(await t.call("DELETE", "/api/docs/db-schema/x", undefined, { "if-match": await t.revOf("db-schema", "x") }));
    t.assertIndexIsFullCompile();
    const index = readJson(t.storeDir, "rendered/db-schema/index.json");
    assert.deepEqual([...new Set(index.map((e) => e.path))], ["docs/w.md", "docs/y.md"]);
    assert.equal(index.some((e) => e.links), false);
  } finally {
    await t.cleanup();
  }
});

test("retype a sub skill to domain: the index entries of the tables that link to it follow", async () => {
  const t = await setup();
  try {
    const sub = {
      schema: "domain-skill/v1",
      id: "s",
      keywords: [{ kw: "s", inject: "full" }],
      status: "active",
      role: "sub",
      body: { name: "s", markdown: "# s\n\n## 도메인 지식\n\n글\n" },
    };
    await t.ok(await t.call("POST", "/api/docs/domain-skill", sub), 201);
    await t.ok(await t.call("POST", "/api/docs/db-schema", table("x", { links: [{ type: "domain-skill", id: "s", rel: "related" }] })), 201);
    await t.ok(await t.call("POST", "/api/docs/domain-skill/s/retype", { type: "domain" }, { "if-match": await t.revOf("domain-skill", "s") }));
    t.assertIndexIsFullCompile();
    const entry = readJson(t.storeDir, "rendered/db-schema/index.json").find((e) => e.path === "docs/x.md");
    assert.deepEqual(entry.links, [{ type: "domain", id: "s", rel: "related" }]);
  } finally {
    await t.cleanup();
  }
});

test("an index in the old order is sorted by the next write; the same docs give the same bytes", async () => {
  const t = await setup();
  try {
    for (const id of ["c", "a", "b"]) await t.ok(await t.call("POST", "/api/docs/db-schema", table(id)), 201);
    const sorted = t.indexText();
    // The order the full compile used to leave: a doc created last came last.
    const shuffled = JSON.parse(sorted).reverse();
    commitFiles(t.storeDir, {
      author: "renoir",
      message: "old order",
      writes: [{ relpath: "rendered/db-schema/index.json", content: JSON.stringify(shuffled, null, 2) + "\n" }],
    });
    const tags = { tags: ["t"] };
    await t.ok(await t.call("PUT", "/api/docs/db-schema/a/tags", tags, { "if-match": await t.revOf("db-schema", "a") }));
    assert.equal(t.indexText(), sorted);
  } finally {
    await t.cleanup();
  }
});
