// The envelope's assets[]: the rule an entry follows, the store check, PUT
// /api/docs/:type/:id/assets, the doc PUT's assets and the md's
// ![글](asset:<sha256>).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { loadSchemas, unknownAssets, validateDocument } from "../../src/envelope.mjs";
import { pngBytes } from "../fixtures/images.mjs";
import { signIn, as } from "../sign-in.mjs";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const A = sha("a");
const B = sha("b");
const asset = (sha256, extra = {}) => ({ sha256, alt: "그림", width: 10, height: 10, ...extra });

const md = (type, name, extra = {}, markdown = `# ${name}\n\n글\n`) => ({
  schema: `${type}/v1`,
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  ...extra,
  body: { name, markdown },
});

test("assets: sha256 lower-case hex 64, width · height ≥ 1, alt one line; 50 at most; a sha once; absent reads as none", () => {
  const refs = loadSchemas();
  const errs = (assets) => validateDocument(md("unclassified", "a", assets === undefined ? {} : { assets }), refs);
  assert.deepEqual(errs(undefined), []);
  assert.deepEqual(errs([]), []);
  assert.deepEqual(errs([asset(A), { sha256: B, width: 1, height: 1 }]), [], "alt is optional");
  for (const bad of [A.toUpperCase(), A.slice(1), `${A}0`, "x".repeat(64)]) assert.equal(errs([asset(bad)]).length, 1, bad);
  assert.equal(errs([asset(A, { width: 0 })]).length, 1);
  assert.equal(errs([asset(A, { alt: "두\n줄" })]).length, 1);
  assert.equal(errs([{ sha256: A }]).length, 2, "width and height are required");
  assert.equal(errs([asset(A, { url: "x" })]).length, 1, "no other key");
  assert.match(errs([asset(A), asset(A, { alt: "다른 글" })])[0], /^\$\.assets\[1\]: 같은 그림이 두 번/);
  const many = (n) => Array.from({ length: n }, (_, i) => asset(sha(String(i))));
  assert.deepEqual(errs(many(50)), []);
  assert.match(errs(many(51))[0], /maxItems 50/);
});

test("assets sit on every type's envelope, a structured one and a draft too", () => {
  const refs = loadSchemas();
  const table = {
    schema: "db-schema/v1",
    id: "t",
    keywords: [],
    status: "inactive",
    assets: [asset(A)],
    body: { table: "T" },
  };
  assert.deepEqual(validateDocument(table, refs, { draft: true }), []);
  assert.equal(validateDocument({ ...table, assets: [asset("nope")] }, refs, { draft: true }).length, 1);
});

test("unknownAssets names each entry the store lacks", () => {
  const doc = md("voc", "a", { assets: [asset(A), asset(B)] });
  assert.deepEqual(unknownAssets(doc, () => true), []);
  assert.deepEqual(unknownAssets(doc, (s) => s === A), [`$.assets[1]: 그림이 저장소에 없습니다 — ${B}`]);
  assert.deepEqual(unknownAssets(md("voc", "a"), () => false), []);
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-doc-assets-test-"));
  const auth = await signIn(home, [
    { id: "renoir", group: "admin", token: "a" },
    { id: "bot", group: "agent", token: "g" },
    { id: "kim", group: "user", token: "u" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const req = (token, method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const upload = async (bytes, token = "g") => {
    const r = await app.inject({ method: "POST", url: "/api/assets", headers: { ...as(token), "content-type": "image/png" }, payload: bytes });
    return r;
  };
  const create = async (doc, token = "a") => {
    const r = await req(token, "POST", `/api/docs/${doc.schema.split("/")[0]}`, doc);
    assert.equal(r.statusCode, 201, r.body);
    return r.json().rev;
  };
  const stored = (type, id) => JSON.parse(readFileSync(join(storeDir, `${type}/${id}.json`), "utf8"));
  return {
    req,
    upload,
    create,
    stored,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("POST /api/assets: the agent uploads too; a user does not", async () => {
  const { upload, cleanup } = await setup();
  try {
    const png = pngBytes(32, 16);
    const r = await upload(png, "g");
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(r.json(), { sha256: sha(png), mediaType: "image/png", width: 32, height: 16, existed: false });
    assert.equal((await upload(pngBytes(8, 8), "u")).statusCode, 403);
  } finally {
    await cleanup();
  }
});

test("a write that names a picture the store lacks is 400 unknown_asset, naming the entry", async () => {
  const { req, upload, create, cleanup } = await setup();
  try {
    const png = pngBytes(32, 16);
    await upload(png);
    const r = await req("a", "POST", "/api/docs/unclassified", md("unclassified", "a", { assets: [asset(sha(png)), asset(B)] }));
    assert.equal(r.statusCode, 400);
    assert.deepEqual(r.json(), { error: "unknown_asset", details: [`$.assets[1]: 그림이 저장소에 없습니다 — ${B}`] });
    const bad = await req("a", "POST", "/api/docs/unclassified", md("unclassified", "a", { assets: [asset("x")] }));
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "validation_failed");

    const batch = await req("g", "POST", "/api/docs/voc/batch", { docs: [md("voc", "v", { assets: [asset(B)] })] });
    assert.equal(batch.statusCode, 400);
    assert.equal(batch.json().rejected[0].error, "unknown_asset");

    await create(md("unclassified", "a", { assets: [asset(sha(png))] }));
  } finally {
    await cleanup();
  }
});

test("PUT assets: admin and agent, If-Match, after keywords and tags; [] drops the key; the same list is no commit; a stale rev is 409", async () => {
  const { req, upload, create, stored, cleanup } = await setup();
  try {
    const png = pngBytes(32, 16);
    await upload(png);
    const rev = await create(md("voc", "a", { tags: ["spc"] }));
    const put = (token, assets, rev, url = "/api/docs/voc/a/assets") => req(token, "PUT", url, { assets }, rev ? { "if-match": rev } : {});
    const list = [asset(sha(png), { alt: "관리도", width: 32, height: 16 })];

    assert.equal((await put("u", list, rev)).statusCode, 403);
    assert.equal((await put("g", list)).statusCode, 428);
    assert.equal((await req("g", "PUT", "/api/docs/voc/a/assets", { assets: "x" }, { "if-match": rev })).statusCode, 400);
    assert.equal((await put("g", list, rev, "/api/docs/nope/a/assets")).statusCode, 400);
    assert.equal((await put("g", list, rev, "/api/docs/voc/zz/assets")).statusCode, 404);
    const missing = await put("g", [asset(B)], rev);
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, "unknown_asset");

    const r = await put("g", list, rev);
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(Object.keys(stored("voc", "a")), ["schema", "id", "keywords", "tags", "assets", "status", "body"]);
    const got = (await req("u", "GET", "/api/docs/voc/a")).json();
    assert.deepEqual(got.assets, list);
    assert.deepEqual(got.json.assets, list);
    const row = (await req("u", "GET", "/api/docs?type=voc")).json().docs.find((d) => d.id === "a");
    assert.equal(row.assetCount, 1);

    const stale = await put("a", [], rev);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "unknown_base_rev");
    assert.equal(stale.json().currentRev, r.json().rev);

    const same = await put("a", list, r.json().rev);
    assert.equal(same.json().unchanged, true);
    assert.equal(same.json().rev, r.json().rev);

    const cleared = await put("a", [], r.json().rev);
    assert.equal(cleared.statusCode, 200);
    assert.equal("assets" in stored("voc", "a"), false);
    assert.deepEqual((await req("u", "GET", "/api/docs/voc/a")).json().assets, []);
  } finally {
    await cleanup();
  }
});

test("the doc PUT takes assets beside the body fields: the envelope's list, the store check, the body as it was", async () => {
  const { req, upload, create, stored, cleanup } = await setup();
  try {
    const png = pngBytes(32, 16);
    await upload(png);
    const rev = await create(md("unclassified", "a"));
    const body = { name: "a", markdown: "# a\n\n새 글\n" };
    const missing = await req("g", "PUT", "/api/docs/unclassified/a", { ...body, assets: [asset(B)] }, { "if-match": rev });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, "unknown_asset");
    const r = await req("g", "PUT", "/api/docs/unclassified/a", { ...body, assets: [asset(sha(png))] }, { "if-match": rev });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(stored("unclassified", "a").assets, [asset(sha(png))]);
    assert.deepEqual(stored("unclassified", "a").body, body);
    // A PUT with no assets keeps them.
    const kept = await req("g", "PUT", "/api/docs/unclassified/a", { name: "a", markdown: "# a\n\n또\n" }, { "if-match": r.json().rev });
    assert.equal(kept.statusCode, 200, kept.body);
    assert.deepEqual(stored("unclassified", "a").assets, [asset(sha(png))]);
  } finally {
    await cleanup();
  }
});

test("the md's pictures: asset:<sha256> only (ASSET_SCHEME), each attached (ASSET_NOT_ATTACHED), with the md line", () => {
  const refs = loadSchemas();
  const errs = (markdown, assets) => validateDocument(md("unclassified", "a", assets ? { assets } : {}, markdown), refs);
  const text = `# a\n\n![관리도](asset:${A})\n\n글 ![아이콘](asset:${B}) 글\n`;
  assert.deepEqual(errs(text, [asset(A), asset(B)]), []);
  assert.deepEqual(errs(text, [asset(A)]), [`$.body.markdown: 5 번째 줄 ASSET_NOT_ATTACHED 그림 ${B} 이 문서 assets 에 없습니다`]);
  assert.equal(errs(text).length, 2);
  const [scheme] = errs("# a\n\n글\n![x](https://x.y/z.png)\n");
  assert.match(scheme, /^\$\.body\.markdown: 4 번째 줄 ASSET_SCHEME /);
  assert.match(errs("# a\n\n![x](./z.png)\n")[0], /3 번째 줄 ASSET_SCHEME .*\(\.\/z\.png\)/);
  assert.deepEqual(errs("# a\n\n```\n![x](./z.png)\n```\n"), [], "a fence holds no pictures");
  // A draft and a skill read the same rule.
  assert.equal(validateDocument({ ...md("unclassified", "a", {}, text), status: "inactive" }, refs, { draft: true }).length, 2);
  const skill = { schema: "domain-skill/v1", id: "s", keywords: [], status: "inactive", body: { name: "s", markdown: `# s\n\n![x](asset:${A})\n` } };
  assert.match(validateDocument(skill, refs, { draft: true })[0], /ASSET_NOT_ATTACHED/);
});

test("a save names the md line in validation_failed; the rendered md keeps ![글](asset:…) as written", async () => {
  const { req, upload, create, cleanup } = await setup();
  try {
    const png = pngBytes(32, 16);
    await upload(png);
    const markdown = `# a\n\n![관리도](asset:${sha(png)})\n\n글 ![아이콘](asset:${sha(png)}) 글\n`;
    const refused = await req("a", "POST", "/api/docs/unclassified", md("unclassified", "a", {}, markdown));
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error, "validation_failed");
    assert.deepEqual(
      refused.json().details.map((d) => d.match(/(\d+) 번째 줄 (\w+)/).slice(1)),
      [["3", "ASSET_NOT_ATTACHED"], ["5", "ASSET_NOT_ATTACHED"]],
    );

    await create(md("unclassified", "a", { assets: [asset(sha(png))] }, markdown));
    const got = await req("u", "GET", "/api/docs/unclassified/a?format=md");
    assert.equal(got.statusCode, 200);
    assert.equal(got.body, markdown);
  } finally {
    await cleanup();
  }
});
