// The envelope's assets[]: the rule an entry follows, the store check, PUT
// /api/docs/:type/:id/assets, the doc PUT's assets and the md's
// ![글](asset:<sha256>).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSchemas, unknownAssets, validateDocument } from "../../src/envelope.mjs";

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
