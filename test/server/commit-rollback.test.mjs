// A failed commitFiles leaves the store as it found it. Before this, the author
// check ran after the files were written and staged: a user whose id has a "."
// or "@" got a 400 on every write, and the file stayed in the index — served by
// readJson, swept into the next user's commit, and refused by assertClean on
// restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "../../server/git.mjs";
import {
  assertClean,
  commitFiles,
  initStore,
  readJson,
  StoreError,
} from "../../server/store.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "akg-commit-rollback-test-"));
  initStore(dir);
  return dir;
}

const filesOf = (dir, rev) =>
  git(dir, ["show", "--name-only", "--format=", rev]).trim().split("\n");

test("a bad author is a 400 before anything is written, and the next commit carries only its own file", async () => {
  const dir = freshStore();
  await assert.rejects(
    () =>
      commitFiles(dir, {
        author: "kim.minsu",
        message: "add",
        writes: [{ relpath: "db-schema/a.json", content: '{"a":1}\n' }],
      }),
    (err) => err instanceof StoreError && err.status === 400,
  );
  assert.equal(existsSync(join(dir, "db-schema/a.json")), false);
  assert.equal(readJson(dir, "db-schema/a.json"), null);
  assert.doesNotThrow(() => assertClean(dir));

  const rev = await commitFiles(dir, {
    author: "renoir",
    message: "add b",
    writes: [{ relpath: "db-schema/b.json", content: '{"b":1}\n' }],
  });
  assert.deepEqual(filesOf(dir, rev), ["db-schema/b.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("a git commit that fails puts back changed, created and removed files", async () => {
  const dir = freshStore();
  await commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [
      { relpath: "db-schema/kept.json", content: '{"v":1}\n' },
      { relpath: "db-schema/gone.json", content: '{"g":1}\n' },
    ],
  });
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);

  await assert.rejects(() =>
    commitFiles(dir, {
      author: "renoir",
      message: "refused by hook",
      writes: [
        { relpath: "db-schema/kept.json", content: '{"v":2}\n' },
        { relpath: "db-schema/new.json", content: '{"n":1}\n' },
      ],
      removes: ["db-schema/gone.json"],
    }),
  );
  assert.equal(readFileSync(join(dir, "db-schema/kept.json"), "utf8"), '{"v":1}\n');
  assert.equal(existsSync(join(dir, "db-schema/new.json")), false);
  assert.equal(readFileSync(join(dir, "db-schema/gone.json"), "utf8"), '{"g":1}\n');
  assert.doesNotThrow(() => assertClean(dir));

  rmSync(hook);
  const rev = await commitFiles(dir, {
    author: "renoir",
    message: "after",
    writes: [{ relpath: "db-schema/other.json", content: '{"o":1}\n' }],
  });
  assert.deepEqual(filesOf(dir, rev), ["db-schema/other.json"]);
  rmSync(dir, { recursive: true, force: true });
});
