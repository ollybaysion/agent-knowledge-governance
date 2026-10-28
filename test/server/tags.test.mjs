// The envelope's tags: the rule a tag follows, PUT /api/docs/:type/:id/tags,
// GET /api/docs?tag= and GET /api/tags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { tagQuery } from "../../server/routes/docs.mjs";
import { loadSchemas, validateDocument } from "../../src/envelope.mjs";
import { signIn, as } from "../sign-in.mjs";

const md = (type, name, extra = {}) => ({
  schema: `${type}/v1`,
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  ...extra,
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n글\n` },
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-tags-test-"));
  const auth = await signIn(home, [
    { id: "renoir", group: "admin", token: "a" },
    { id: "bot", group: "agent", token: "g" },
    { id: "kim", group: "user", token: "u" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const req = (token, method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const create = async (doc, token = "a") => {
    const r = await req(token, "POST", `/api/docs/${doc.schema.split("/")[0]}`, doc);
    assert.equal(r.statusCode, 201, r.body);
    return r.json().rev;
  };
  const stored = (type, id) => JSON.parse(readFileSync(join(storeDir, `${type}/${id}.json`), "utf8"));
  return {
    req,
    create,
    stored,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a tag is lower-case latin, digits and -, 1 to 32 long; 20 at most, each once; absent reads as none", () => {
  const refs = loadSchemas();
  const errs = (tags) => validateDocument(md("voc", "a", tags === undefined ? {} : { tags }), refs);
  assert.deepEqual(errs(undefined), []);
  assert.deepEqual(errs([]), []);
  assert.deepEqual(errs(["sensor", "spc-2026", "a"]), []);
  assert.deepEqual(errs(["x".repeat(32)]), []);
  for (const bad of ["Sensor", "센서", "two words", "", "x".repeat(33), "a_b", "a.b"]) assert.equal(errs([bad]).length, 1, bad);
  assert.match(errs(["a", "a"])[0], /uniqueItems/);
  assert.deepEqual(errs(Array.from({ length: 20 }, (_, i) => `t${i}`)), []);
  assert.match(errs(Array.from({ length: 21 }, (_, i) => `t${i}`))[0], /maxItems 20/);
  assert.equal(errs("sensor").length, 1, "a string is not a list");
});

test("PUT tags: the agent and the admin write them after keywords; [] drops the key; the same tags are no commit", async () => {
  const { req, create, stored, cleanup } = await setup();
  try {
    const rev = await create(md("voc", "a"));
    const r = await req("g", "PUT", "/api/docs/voc/a/tags", { tags: ["sensor", "spc"] }, { "if-match": rev });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().json.tags, ["sensor", "spc"]);
    assert.deepEqual(Object.keys(stored("voc", "a")), ["schema", "id", "keywords", "tags", "status", "body"]);
    assert.deepEqual((await req("u", "GET", "/api/docs/voc/a")).json().json.tags, ["sensor", "spc"]);

    const same = await req("a", "PUT", "/api/docs/voc/a/tags", { tags: ["sensor", "spc"] }, { "if-match": r.json().rev });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().unchanged, true);
    assert.equal(same.json().rev, r.json().rev);

    const cleared = await req("a", "PUT", "/api/docs/voc/a/tags", { tags: [] }, { "if-match": r.json().rev });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(stored("voc", "a").tags, undefined);
  } finally {
    await cleanup();
  }
});

test("PUT tags: a reader is 403, no If-Match 428, a stale rev 409, a bad tag 400, no list 400, a missing doc 404", async () => {
  const { req, create, cleanup } = await setup();
  try {
    const old = await create(md("voc", "a"));
    assert.equal((await req("u", "PUT", "/api/docs/voc/a/tags", { tags: ["x"] }, { "if-match": old })).statusCode, 403);
    assert.equal((await req("a", "PUT", "/api/docs/voc/a/tags", { tags: ["x"] })).statusCode, 428);
    const bad = await req("a", "PUT", "/api/docs/voc/a/tags", { tags: ["Sensor"] }, { "if-match": old });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "validation_failed");
    assert.equal((await req("a", "PUT", "/api/docs/voc/a/tags", { tags: "x" }, { "if-match": old })).json().error, "tags_required");
    const now = (await req("a", "PUT", "/api/docs/voc/a/tags", { tags: ["x"] }, { "if-match": old })).json().rev;
    const stale = await req("a", "PUT", "/api/docs/voc/a/tags", { tags: ["y"] }, { "if-match": old });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().currentRev, now);
    assert.equal((await req("a", "PUT", "/api/docs/voc/nope/tags", { tags: ["x"] }, { "if-match": old })).statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("GET /api/docs?tag=: the rows carry tags; a,b keeps the documents with both, across types; a bad tag is 400", async () => {
  const { req, create, cleanup } = await setup();
  try {
    await create(md("voc", "a", { tags: ["sensor", "spc"] }));
    await create(md("voc", "b", { tags: ["sensor"] }));
    await create(md("unclassified", "c", { tags: ["spc", "sensor"] }));
    await create(md("voc", "d"));
    const ids = async (q) => (await req("u", "GET", `/api/docs${q}`)).json().docs.map((d) => `${d.type}/${d.id}`).sort();
    assert.deepEqual(await ids("?tag=sensor"), ["unclassified/c", "voc/a", "voc/b"]);
    assert.deepEqual(await ids("?tag=sensor,spc"), ["unclassified/c", "voc/a"]);
    assert.deepEqual(await ids("?tag=sensor,spc&type=voc"), ["voc/a"]);
    assert.deepEqual(await ids("?tag=none"), []);
    const all = (await req("u", "GET", "/api/docs")).json().docs;
    assert.deepEqual(all.find((d) => d.id === "a").tags, ["sensor", "spc"]);
    assert.deepEqual(all.find((d) => d.id === "d").tags, []);
    const bad = await req("u", "GET", "/api/docs?tag=Sensor");
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json(), { error: "invalid_query", param: "tag", invalid: ["Sensor"] });
  } finally {
    await cleanup();
  }
});

test("GET /api/tags: each tag with the number of documents that carry it; a reader may read it", async () => {
  const { req, create, cleanup } = await setup();
  try {
    assert.deepEqual((await req("u", "GET", "/api/tags")).json(), { tags: {} });
    await create(md("voc", "a", { tags: ["sensor", "spc"] }));
    await create(md("voc", "b", { tags: ["sensor"] }));
    await create(md("unclassified", "c", { tags: ["sensor"] }), "u");
    const r = await req("u", "GET", "/api/tags");
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { tags: { sensor: 3, spc: 1 } });
    assert.equal((await req("g", "GET", "/api/tags")).statusCode, 200);
  } finally {
    await cleanup();
  }
});

test("unclassified keeps its tags in its envelope, as every type does", async () => {
  const { req, create, stored, cleanup } = await setup();
  try {
    const rev = await create(md("unclassified", "note"), "u");
    const r = await req("g", "PUT", "/api/docs/unclassified/note/tags", { tags: ["deploy"] }, { "if-match": rev });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(stored("unclassified", "note").tags, ["deploy"]);
    assert.deepEqual((await req("u", "GET", "/api/docs?tag=deploy")).json().docs.map((d) => d.id), ["note"]);
  } finally {
    await cleanup();
  }
});

test("tagQuery: an empty query wants nothing; a,b wants both; a bad tag is named", () => {
  assert.deepEqual(tagQuery(undefined), { tags: [] });
  assert.deepEqual(tagQuery(""), { tags: [] });
  assert.deepEqual(tagQuery("a, b,,"), { tags: ["a", "b"] });
  assert.deepEqual(tagQuery("a,B c"), { error: ["B c"] });
});
