// PUT /api/docs/:type/:id/absorbed marks a document absorbed into a
// first-class document at its current rev; GET /api/docs?absorbed=stale lists
// the documents whose mark is missing or behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n글\n` },
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-absorbed-test-"));
  const auth = await signIn(home, [
    { id: "renoir", group: "admin", token: "a" },
    { id: "absorber", group: "agent", token: "g" },
    { id: "reader", group: "user", token: "u" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const req = (token, method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const create = async (name) => {
    const r = await req("a", "POST", "/api/docs/voc", voc(name));
    assert.equal(r.statusCode, 201);
    return r.json().rev;
  };
  return {
    storeDir,
    req,
    create,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("PUT absorbed: the agent marks the current rev; the doc keeps its rev and its file stays as it was", async () => {
  const { storeDir, req, create, cleanup } = await setup();
  try {
    const rev = await create("a");
    const before = readFileSync(join(storeDir, "voc/a.json"), "utf8");
    const r = await req("g", "PUT", "/api/docs/voc/a/absorbed", { rev });
    assert.equal(r.statusCode, 200, r.body);
    const { absorbed } = r.json();
    assert.equal(r.json().rev, rev);
    assert.equal(absorbed.rev, rev);
    assert.equal(absorbed.by, "absorber");
    assert.match(absorbed.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    const got = await req("a", "GET", "/api/docs/voc/a");
    assert.equal(got.json().rev, rev);
    assert.deepEqual(got.json().json.absorbed, absorbed);
    assert.equal(readFileSync(join(storeDir, "voc/a.json"), "utf8"), before);
    assert.deepEqual(JSON.parse(readFileSync(join(storeDir, "voc/a.meta.json"), "utf8")), { absorbed });

    // An edit after the mark keeps the mark in the sidecar, out of the doc file.
    const edited = await req("a", "PUT", "/api/docs/voc/a", { name: "a", markdown: "# a\n\n## 받은 말\n\n새 글\n" }, { "if-match": rev });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(JSON.parse(readFileSync(join(storeDir, "voc/a.json"), "utf8")).absorbed, undefined);
    assert.deepEqual((await req("a", "GET", "/api/docs/voc/a")).json().json.absorbed, absorbed);
  } finally {
    await cleanup();
  }
});

test("PUT absorbed: a rev other than the current one is 409; no rev is 400; a reader is 403; a missing doc is 404", async () => {
  const { storeDir, req, create, cleanup } = await setup();
  try {
    const old = await create("a");
    const edited = await req("a", "PUT", "/api/docs/voc/a", { name: "a", markdown: "# a\n\n## 받은 말\n\n새 글\n" }, { "if-match": old });
    const current = edited.json().rev;
    assert.notEqual(current, old);

    const stale = await req("g", "PUT", "/api/docs/voc/a/absorbed", { rev: old });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: "unknown_base_rev", currentRev: current });
    assert.equal(existsSync(join(storeDir, "voc/a.meta.json")), false);

    assert.equal((await req("g", "PUT", "/api/docs/voc/a/absorbed", {})).json().error, "rev_required");
    assert.equal((await req("u", "PUT", "/api/docs/voc/a/absorbed", { rev: current })).statusCode, 403);
    assert.equal((await req("g", "PUT", "/api/docs/voc/none/absorbed", { rev: current })).statusCode, 404);
    assert.equal((await req("g", "PUT", "/api/docs/nosuch/a/absorbed", { rev: current })).statusCode, 400);
  } finally {
    await cleanup();
  }
});

test("GET /api/docs?absorbed=stale: unmarked docs and docs changed since their mark; an unknown value is 400", async () => {
  const { req, create, cleanup } = await setup();
  try {
    const revA = await create("a");
    await create("b");
    const revC = await create("c");
    assert.equal((await req("g", "PUT", "/api/docs/voc/a/absorbed", { rev: revA })).statusCode, 200);
    assert.equal((await req("g", "PUT", "/api/docs/voc/c/absorbed", { rev: revC })).statusCode, 200);
    await req("a", "PUT", "/api/docs/voc/c", { name: "c", markdown: "# c\n\n## 받은 말\n\n새 글\n" }, { "if-match": revC });

    const ids = async (url) => (await req("a", "GET", url)).json().docs.map((d) => d.id).sort();
    assert.deepEqual(await ids("/api/docs?type=voc&absorbed=stale"), ["b", "c"]);
    assert.deepEqual(await ids("/api/docs?absorbed=stale&q=a"), []);
    assert.deepEqual(await ids("/api/docs?type=voc"), ["a", "b", "c"]);

    const rows = (await req("a", "GET", "/api/docs?type=voc")).json().docs;
    assert.equal(rows.find((d) => d.id === "a").absorbed.rev, revA);
    assert.equal(rows.find((d) => d.id === "b").absorbed, undefined);

    const bad = await req("a", "GET", "/api/docs?absorbed=fresh");
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "invalid_query");
  } finally {
    await cleanup();
  }
});

test("DELETE takes the absorbed sidecar with the document", async () => {
  const { storeDir, req, create, cleanup } = await setup();
  try {
    const rev = await create("a");
    await req("g", "PUT", "/api/docs/voc/a/absorbed", { rev });
    assert.equal(existsSync(join(storeDir, "voc/a.meta.json")), true);
    const del = await req("a", "DELETE", "/api/docs/voc/a", undefined, { "if-match": rev });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal(existsSync(join(storeDir, "voc/a.meta.json")), false);
  } finally {
    await cleanup();
  }
});
