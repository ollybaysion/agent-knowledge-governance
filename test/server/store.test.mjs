import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  changedAtOfPath,
  invalidateCache,
  warmRevCache,
} from "../../server/store.mjs";
import { git } from "../../server/git.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "akg-store-test-"));
}

test("initStore creates a clean git repo; assertClean passes right after", async () => {
  const dir = freshDir();
  initStore(dir);
  assert.doesNotThrow(() => assertClean(dir));
  rmSync(dir, { recursive: true, force: true });
});

test("validateId rejects path traversal and non-lowercase ids", async () => {
  assert.throws(() => validateId("../etc/passwd"), StoreError);
  assert.throws(() => validateId("Testuser.FDC"), StoreError);
  assert.doesNotThrow(() => validateId("testuser.fdc_sensor"));
});

test("commitFiles writes + commits, rev is retrievable, cache is warm without a fresh git log", async () => {
  const dir = freshDir();
  initStore(dir);
  const rev = await commitFiles(dir, {
    author: "renoir",
    message: "add doc",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  assert.match(rev, /^[0-9a-f]{40}$/);
  assert.equal(revOfPath(dir, "db-schema/t.x.json"), rev);
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("revOfPath of a directory follows each commit under it, after a cold read", async () => {
  const dir = freshDir();
  initStore(dir);
  const rev1 = await commitFiles(dir, {
    author: "renoir",
    message: "x",
    writes: [{ relpath: "domain-skill/x.json", content: '{"x":1}\n' }],
  });
  assert.equal(revOfPath(dir, "domain-skill"), rev1);
  const rev2 = await commitFiles(dir, {
    author: "renoir",
    message: "y",
    writes: [{ relpath: "domain-skill/y.json", content: '{"y":1}\n' }],
  });
  assert.notEqual(rev2, rev1);
  assert.equal(revOfPath(dir, "domain-skill"), rev2);
  const rev3 = await commitFiles(dir, {
    author: "renoir",
    message: "nested",
    writes: [{ relpath: "proposals/pending/p.json", content: "{}\n" }],
  });
  assert.equal(revOfPath(dir, "proposals"), rev3);
  assert.equal(revOfPath(dir, "proposals/pending"), rev3);
  assert.equal(revOfPath(dir, "domain-skill"), rev2);
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonAtRev reads a historical version after a second commit changes the file", async () => {
  const dir = freshDir();
  initStore(dir);
  const rev1 = await commitFiles(dir, {
    author: "renoir",
    message: "v1",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  await commitFiles(dir, {
    author: "renoir",
    message: "v2",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":2}\n' }],
  });
  assert.deepEqual(readJsonAtRev(dir, "db-schema/t.x.json", rev1), { a: 1 });
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("listIds lists ids by filename, ignoring .meta.json sidecars", async () => {
  const dir = freshDir();
  initStore(dir);
  await commitFiles(dir, {
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

test("assertClean throws when the tree has uncommitted changes (simulated manual git intervention, S9)", async () => {
  const dir = freshDir();
  initStore(dir);
  await commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [{ relpath: "db-schema/t.x.json", content: "{}" }],
  });
  // Simulate an out-of-band edit that never got committed.
  writeFileSync(join(dir, "db-schema/t.x.json"), '{"tampered":true}');
  assert.throws(() => assertClean(dir), StoreError);
  rmSync(dir, { recursive: true, force: true });
});

test("warmRevCache fills each path's rev and time from one history walk, as git log -1 answers them", async () => {
  const dir = freshDir();
  initStore(dir);
  const write = (message, writes, removes = []) => commitFiles(dir, { author: "renoir", message, writes, removes });
  await write("a", [
    { relpath: "db-schema/a.json", content: '{"a":1}\n' },
    { relpath: "rendered/db-schema/docs/a.md", content: "a\n" },
  ]);
  await write("b", [{ relpath: "db-schema/b.json", content: '{"b":1}\n' }]);
  await write("a again", [{ relpath: "db-schema/a.json", content: '{"a":2}\n' }]);
  await write("mark", [{ relpath: "db-schema/a.meta.json", content: '{"absorbed":{}}\n' }]);
  await write("skill", [{ relpath: "domain-skill/s.json", content: "{}\n" }]);
  await write("drop b", [], ["db-schema/b.json"]);
  const paths = [
    "db-schema/a.json",
    "db-schema/a.meta.json",
    "db-schema/b.json",
    "rendered/db-schema/docs/a.md",
    "domain-skill/s.json",
    ".gitkeep",
    "db-schema",
    "rendered",
    "rendered/db-schema",
    "rendered/db-schema/docs",
    "domain-skill",
  ];
  const expected = paths.map((p) => git(dir, ["log", "-1", "--format=%H %aI", "--", p]).trim());

  invalidateCache(dir);
  const warmed = warmRevCache(dir);
  assert.equal(warmed.commits, 7);
  // With .git away a cold read would throw: every answer below is the cache's.
  renameSync(join(dir, ".git"), join(dir, ".git-away"));
  try {
    assert.deepEqual(
      paths.map((p) => `${revOfPath(dir, p)} ${changedAtOfPath(dir, p)}`),
      expected,
    );
  } finally {
    renameSync(join(dir, ".git-away"), join(dir, ".git"));
  }
  rmSync(dir, { recursive: true, force: true });
});

test("warmRevCache on a history git cannot read leaves the cold reads to answer", async () => {
  const dir = freshDir();
  initStore(dir);
  const rev = await commitFiles(dir, { author: "renoir", message: "a", writes: [{ relpath: "db-schema/a.json", content: "{}\n" }] });
  invalidateCache(dir);
  renameSync(join(dir, ".git"), join(dir, ".git-away"));
  try {
    assert.equal(warmRevCache(dir), null);
  } finally {
    renameSync(join(dir, ".git-away"), join(dir, ".git"));
  }
  assert.equal(revOfPath(dir, "db-schema/a.json"), rev);
  rmSync(dir, { recursive: true, force: true });
});
