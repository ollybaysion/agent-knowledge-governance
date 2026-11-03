// GET /api/docs?fields=body: each row also carries `json`, the stored
// document — what a consumer would otherwise GET once per document.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { fieldsQuery } from "../../server/routes/docs.mjs";
import { readJson } from "../../server/store.mjs";
import { signIn, as } from "../sign-in.mjs";

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n글\n` },
});

const manual = {
  schema: "manual/v1",
  id: "m1",
  keywords: [{ kw: "m1", inject: "pointer" }],
  status: "inactive",
  body: { title: "M1", steps: [] },
};

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-fields-test-"));
  const auth = await signIn(home, [
    { id: "renoir", group: "admin", token: "a" },
    { id: "be", group: "agent", token: "agent-pw" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  for (const id of ["a", "b"]) assert.equal((await app.inject({ method: "POST", url: "/api/docs/voc", headers: as("a"), payload: voc(id) })).statusCode, 201);
  const m = await app.inject({ method: "POST", url: "/api/docs/manual", headers: as("a"), payload: manual });
  assert.equal(m.statusCode, 201, m.body);
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const list = async (app, query) => app.inject({ method: "GET", url: `/api/docs${query}`, headers: as("agent-pw") });

test("fields=body: each row carries json, the stored document, and the type filter still applies", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const res = await list(app, "?type=voc&fields=body");
    assert.equal(res.statusCode, 200);
    const rows = res.json().docs;
    assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
    for (const row of rows) {
      assert.deepEqual(row.json, readJson(storeDir, `voc/${row.id}.json`));
      const one = (await app.inject({ method: "GET", url: `/api/docs/voc/${row.id}`, headers: as("agent-pw") })).json();
      assert.deepEqual(row.json, one.json);
      assert.equal(row.md, undefined);
      assert.equal(row.slots, undefined);
    }
    const all = (await list(app, "?fields=body")).json().docs;
    assert.deepEqual(all.map((r) => `${r.type}/${r.id}`).sort(), ["manual/m1", "voc/a", "voc/b"]);
    assert.ok(all.every((r) => r.json?.id === r.id));
  } finally {
    await cleanup();
  }
});

test("without fields the rows are as before: no json", async () => {
  const { app, cleanup } = await setup();
  try {
    const plain = (await list(app, "?type=voc")).json().docs;
    const withBody = (await list(app, "?type=voc&fields=body")).json().docs;
    assert.ok(plain.every((r) => !("json" in r)));
    assert.deepEqual(withBody.map(({ json: _json, ...rest }) => rest), plain);
  } finally {
    await cleanup();
  }
});

test("an unknown field is a 400 naming what fields takes", async () => {
  const { app, cleanup } = await setup();
  try {
    for (const q of ["?fields=md", "?fields=body,slots", "?type=voc&fields=BODY"]) {
      const res = await list(app, q);
      assert.equal(res.statusCode, 400, q);
      assert.deepEqual(res.json(), { error: "invalid_query", param: "fields", allowed: ["body"] });
    }
  } finally {
    await cleanup();
  }
});

test("a document file that no longer parses leaves only its row without json", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    writeFileSync(join(storeDir, "voc", "b.json"), "{ not json");
    const res = await list(app, "?type=voc&fields=body");
    assert.equal(res.statusCode, 200);
    const rows = res.json().docs;
    assert.equal(rows.find((r) => r.id === "a").json.id, "a");
    assert.equal("json" in rows.find((r) => r.id === "b"), false);
  } finally {
    await cleanup();
  }
});

test("fieldsQuery: empty asks for nothing, body,body is body, anything else is an error", () => {
  assert.deepEqual(fieldsQuery(undefined), { fields: new Set() });
  assert.deepEqual(fieldsQuery(""), { fields: new Set() });
  assert.deepEqual(fieldsQuery(" body , body"), { fields: new Set(["body"]) });
  assert.deepEqual(fieldsQuery("body,x"), { error: true });
});
