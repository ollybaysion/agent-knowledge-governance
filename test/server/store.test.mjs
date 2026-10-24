import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initStore,
  assertClean,
  commitFiles,
  readJson,
  readJsonAtRev,
  revOfPath,
  listIds,
  validateId,
  StoreError,
} from "../../server/store.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "akg-store-test-"));
}

test("initStore creates a clean git repo; assertClean passes right after", () => {
  const dir = freshDir();
  initStore(dir);
  assert.doesNotThrow(() => assertClean(dir));
  rmSync(dir, { recursive: true, force: true });
});

test("validateId rejects path traversal and non-lowercase ids", () => {
  assert.throws(() => validateId("../etc/passwd"), StoreError);
  assert.throws(() => validateId("Testuser.FDC"), StoreError);
  assert.doesNotThrow(() => validateId("testuser.fdc_sensor"));
});

test("commitFiles writes + commits, rev is retrievable, cache is warm without a fresh git log", () => {
  const dir = freshDir();
  initStore(dir);
  const rev = commitFiles(dir, {
    author: "renoir",
    message: "add doc",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  assert.match(rev, /^[0-9a-f]{40}$/);
  assert.equal(revOfPath(dir, "db-schema/t.x.json"), rev);
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("revOfPath of a directory follows each commit under it, after a cold read", () => {
  const dir = freshDir();
  initStore(dir);
  const rev1 = commitFiles(dir, {
    author: "renoir",
    message: "x",
    writes: [{ relpath: "domain-skill/x.json", content: '{"x":1}\n' }],
  });
  assert.equal(revOfPath(dir, "domain-skill"), rev1);
  const rev2 = commitFiles(dir, {
    author: "renoir",
    message: "y",
    writes: [{ relpath: "domain-skill/y.json", content: '{"y":1}\n' }],
  });
  assert.notEqual(rev2, rev1);
  assert.equal(revOfPath(dir, "domain-skill"), rev2);
  const rev3 = commitFiles(dir, {
    author: "renoir",
    message: "nested",
    writes: [{ relpath: "proposals/pending/p.json", content: "{}\n" }],
  });
  assert.equal(revOfPath(dir, "proposals"), rev3);
  assert.equal(revOfPath(dir, "proposals/pending"), rev3);
  assert.equal(revOfPath(dir, "domain-skill"), rev2);
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonAtRev reads a historical version after a second commit changes the file", () => {
  const dir = freshDir();
  initStore(dir);
  const rev1 = commitFiles(dir, {
    author: "renoir",
    message: "v1",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  commitFiles(dir, {
    author: "renoir",
    message: "v2",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":2}\n' }],
  });
  assert.deepEqual(readJsonAtRev(dir, "db-schema/t.x.json", rev1), { a: 1 });
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("listIds lists ids by filename, ignoring .meta.json sidecars", () => {
  const dir = freshDir();
  initStore(dir);
  commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [
      { relpath: "db-schema/t.a.json", content: "{}" },
      { relpath: "db-schema/t.b.json", content: "{}" },
      { relpath: "unclassified/x.meta.json", content: "{}" },
    ],
  });
  assert.deepEqual(listIds(dir, "db-schema").sort(), ["t.a", "t.b"]);
  assert.deepEqual(listIds(dir, "unclassified"), []);
  rmSync(dir, { recursive: true, force: true });
});

test("assertClean throws when the tree has uncommitted changes (simulated manual git intervention, S9)", () => {
  const dir = freshDir();
  initStore(dir);
  commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [{ relpath: "db-schema/t.x.json", content: "{}" }],
  });
  // Simulate an out-of-band edit that never got committed.
  writeFileSync(join(dir, "db-schema/t.x.json"), '{"tampered":true}');
  assert.throws(() => assertClean(dir), StoreError);
  rmSync(dir, { recursive: true, force: true });
});
