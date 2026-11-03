// GET /api/docs carries an ETag and answers 304 to a client that holds the
// current one; any commit moves it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { noneMatchHits } from "../../server/etag.mjs";
import { queryKey } from "../../server/routes/docs.mjs";
import { signIn, as } from "../sign-in.mjs";

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n글\n` },
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-list-etag-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  for (const id of ["a", "b"]) assert.equal((await app.inject({ method: "POST", url: "/api/docs/voc", headers: as("a"), payload: voc(id) })).statusCode, 201);
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const list = (app, url, headers = {}) => app.inject({ method: "GET", url, headers: { ...as("a"), ...headers } });

test("the same ETag back is a 304 with no body; the list says no-cache", async () => {
  const { app, cleanup } = await setup();
  try {
    const first = await list(app, "/api/docs");
    assert.equal(first.statusCode, 200);
    const { etag } = first.headers;
    assert.match(etag, /^"[0-9a-f]{16}"$/);
    assert.equal(first.headers["cache-control"], "no-cache");
    const again = await list(app, "/api/docs", { "if-none-match": etag });
    assert.equal(again.statusCode, 304);
    assert.equal(again.body, "");
    assert.equal(again.headers.etag, etag);
    assert.equal((await list(app, "/api/docs", { "if-none-match": `W/${etag}` })).statusCode, 304);
    assert.equal((await list(app, "/api/docs", { "if-none-match": '"0000000000000000"' })).statusCode, 200);
  } finally {
    await cleanup();
  }
});

test("a document PUT moves the ETag: the old one gets the new list", async () => {
  const { app, cleanup } = await setup();
  try {
    const before = await list(app, "/api/docs");
    const read = (await list(app, "/api/docs/voc/a")).json();
    const put = await app.inject({
      method: "PUT",
      url: "/api/docs/voc/a",
      headers: { ...as("a"), "if-match": read.rev },
      payload: { ...read.json.body, markdown: "# a\n\n## 받은 말\n\n고친 글\n" },
    });
    assert.equal(put.statusCode, 200, put.body);
    const after = await list(app, "/api/docs", { "if-none-match": before.headers.etag });
    assert.equal(after.statusCode, 200);
    assert.notEqual(after.headers.etag, before.headers.etag);
    assert.equal(after.json().docs.find((d) => d.id === "a").rev, put.json().rev);
  } finally {
    await cleanup();
  }
});

test("each query has its own ETag, whatever the order of its keys", async () => {
  const { app, cleanup } = await setup();
  try {
    const all = (await list(app, "/api/docs")).headers.etag;
    const voc1 = (await list(app, "/api/docs?type=voc&fields=body")).headers.etag;
    const voc2 = (await list(app, "/api/docs?fields=body&type=voc")).headers.etag;
    assert.notEqual(all, voc1);
    assert.equal(voc1, voc2);
    assert.equal((await list(app, "/api/docs?type=voc", { "if-none-match": all })).statusCode, 200);
  } finally {
    await cleanup();
  }
});

test("noneMatchHits and queryKey", () => {
  assert.equal(noneMatchHits('"x", W/"y"', '"y"'), true);
  assert.equal(noneMatchHits("*", '"y"'), true);
  assert.equal(noneMatchHits('"x"', '"y"'), false);
  assert.equal(noneMatchHits(undefined, '"y"'), false);
  assert.equal(queryKey({ type: "voc", fields: "body" }), "fields=body&type=voc");
  assert.equal(queryKey({}), "");
});
