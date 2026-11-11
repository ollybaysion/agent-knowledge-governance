// The rev table comes from one walk of `git log`, read as git writes it: a
// history of any size gives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initStore,
  commitFiles,
  invalidateCache,
  warmRevCache,
  revOfPath,
  changedAtOfPath,
} from "../../server/store.mjs";
import { git, gitAsync, limits } from "../../server/git.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "akg-rev-table-test-"));
const LOG_ARGS = ["log", "--name-only", "--no-renames", "-z", "--format=%x1e%H%x1f%aI"];

// What a cold `git log -1 -- <path>` answers for each path, as "rev at".
const coldAnswers = (dir, paths) =>
  new Map(paths.map((p) => [p, git(dir, ["log", "-1", "--format=%H %aI", "--", p]).trim()]));

// Every path, answered by the cache alone: with .git away a cold read would throw.
function cacheAnswers(dir, paths) {
  renameSync(join(dir, ".git"), join(dir, ".git-away"));
  try {
    return new Map(paths.map((p) => [p, `${revOfPath(dir, p)} ${changedAtOfPath(dir, p)}`]));
  } finally {
    renameSync(join(dir, ".git-away"), join(dir, ".git"));
  }
}

function newStore() {
  const dir = freshDir();
  initStore(dir);
  const write = (message, writes, removes = []) => commitFiles(dir, { author: "renoir", message, writes, removes });
  return { dir, write };
}

test("a history whose git log is over the output limit of git() still gives the table", async () => {
  const { dir, write } = newStore();
  try {
    for (let i = 0; i < 6; i++) await write(`d${i}`, [{ relpath: `db-schema/d${i}.json`, content: `{"i":${i}}\n` }]);
    const paths = [".gitkeep", "db-schema", ...Array.from({ length: 6 }, (_, i) => `db-schema/d${i}.json`)];
    const expected = coldAnswers(dir, paths);
    const before = limits.output;
    limits.output = Math.floor(Buffer.byteLength(git(dir, LOG_ARGS)) / 4);
    try {
      assert.throws(() => git(dir, LOG_ARGS), /ENOBUFS/);
      await assert.rejects(gitAsync(dir, LOG_ARGS), /stdout maxBuffer exceeded/);
      invalidateCache(dir);
      const warmed = await warmRevCache(dir);
      assert.equal(warmed.commits, 7);
      assert.equal(warmed.paths, paths.length);
    } finally {
      limits.output = before;
    }
    assert.deepEqual(cacheAnswers(dir, paths), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
