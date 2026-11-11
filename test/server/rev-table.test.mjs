// The rev table comes from one walk of `git log`, read as git writes it: a
// history of any size gives it. The table is saved in .git/akg-rev-table.json;
// a boot reads it and walks only the commits after its HEAD, and the answers
// are those of one walk of the whole history, entry for entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
import { buildApp } from "../../server/app.mjs";
import { signIn } from "../sign-in.mjs";

const freshDir = () => mkdtempSync(join(tmpdir(), "akg-rev-table-test-"));
const LOG_ARGS = ["log", "--name-only", "--no-renames", "-z", "--format=%x1e%H%x1f%aI"];
const tableFile = (dir) => join(dir, ".git", "akg-rev-table.json");
const headOf = (dir) => git(dir, ["rev-parse", "HEAD"]).trim();

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

// The saved file as {head, table: relpath -> "rev at"}.
function savedTable(dir) {
  const { v, head, commits, paths } = JSON.parse(readFileSync(tableFile(dir), "utf8"));
  assert.equal(v, 1);
  return { head, table: new Map(Object.entries(paths).map(([p, i]) => [p, commits[i].join(" ")])) };
}

// The table one walk of the whole history gives: a clone has the same commits and no saved file.
async function wholeWalk(dir) {
  const clone = freshDir();
  try {
    git(clone, ["clone", "-q", dir, "."]);
    const warmed = await warmRevCache(clone);
    assert.equal(warmed.from, "full");
    return savedTable(clone).table;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
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
      assert.equal(warmed.from, "full");
      assert.equal(warmed.commits, 7);
      assert.equal(warmed.paths, paths.length);
    } finally {
      limits.output = before;
    }
    assert.deepEqual(cacheAnswers(dir, paths), expected);
    assert.deepEqual(savedTable(dir).table, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a boot from the saved table plus the commits after it equals a walk of the whole history", async () => {
  const { dir, write } = newStore();
  try {
    await write("add", [
      { relpath: "db-schema/a.json", content: '{"a":1}\n' },
      { relpath: "db-schema/b.json", content: '{"b":1}\n' },
      { relpath: "rendered/db-schema/docs/a.md", content: "a\n" },
    ]);
    await write("a again", [{ relpath: "db-schema/a.json", content: '{"a":2}\n' }]);
    await write("skill", [{ relpath: "domain-skill/s.json", content: "{}\n" }]);
    invalidateCache(dir);
    const first = await warmRevCache(dir);
    assert.equal(first.from, "full");
    assert.equal(first.reason, "missing");
    assert.equal(first.commits, 4);
    const firstHead = headOf(dir);
    assert.equal(savedTable(dir).head, firstHead);

    // After the save: the same path again, a delete, a directory move, a path back after its delete.
    await write("a third", [{ relpath: "db-schema/a.json", content: '{"a":3}\n' }]);
    await write("drop b", [], ["db-schema/b.json"]);
    await write(
      "move docs",
      [
        { relpath: "rendered/db-schema/pages/a.md", content: "a\n" },
        { relpath: "skills/s.json", content: "{}\n" },
      ],
      ["rendered/db-schema/docs/a.md", "domain-skill/s.json"],
    );
    await write("b back, a fourth", [
      { relpath: "db-schema/b.json", content: '{"b":2}\n' },
      { relpath: "db-schema/a.json", content: '{"a":4}\n' },
    ]);
    invalidateCache(dir);
    const next = await warmRevCache(dir);
    assert.equal(next.from, "saved");
    assert.equal(next.base, firstHead);
    assert.equal(next.commits, 4);

    const whole = await wholeWalk(dir);
    const saved = savedTable(dir);
    assert.equal(saved.head, headOf(dir));
    assert.deepEqual(saved.table, whole);
    assert.equal(next.paths, whole.size);
    assert.deepEqual(cacheAnswers(dir, [...whole.keys()]), whole);
    assert.deepEqual(coldAnswers(dir, [...whole.keys()]), whole);

    // At the saved HEAD nothing is walked and the file stays as it was.
    const bytes = readFileSync(tableFile(dir));
    invalidateCache(dir);
    const same = await warmRevCache(dir);
    assert.equal(same.from, "saved");
    assert.equal(same.commits, 0);
    assert.deepEqual(readFileSync(tableFile(dir)), bytes);
    assert.deepEqual(cacheAnswers(dir, [...whole.keys()]), whole);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a saved HEAD out of the history, a broken file, another version: the whole history, and the file written again", async () => {
  const { dir, write } = newStore();
  try {
    await write("a", [{ relpath: "db-schema/a.json", content: '{"a":1}\n' }]);
    await write("b", [{ relpath: "db-schema/b.json", content: '{"b":1}\n' }]);
    invalidateCache(dir);
    await warmRevCache(dir);

    // The history rewritten: the saved HEAD is no ancestor of the new one.
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    await write("c", [{ relpath: "db-schema/c.json", content: '{"c":1}\n' }]);
    invalidateCache(dir);
    const rewritten = await warmRevCache(dir);
    assert.equal(rewritten.from, "full");
    assert.equal(rewritten.reason, "not-ancestor");
    assert.equal(savedTable(dir).head, headOf(dir));
    const whole = await wholeWalk(dir);
    assert.deepEqual(savedTable(dir).table, whole);
    assert.ok(!whole.has("db-schema/b.json"));

    const cases = [
      ["unreadable", '{"v":1,"head":'],
      ["unreadable", "null"],
      ["unreadable", JSON.stringify({ v: 1, head: headOf(dir), commits: [], paths: { "db-schema/a.json": 0 } })],
      ["unreadable", JSON.stringify({ v: 1, head: "-x", commits: [], paths: {} })],
      ["version", JSON.stringify({ v: 2, head: headOf(dir), commits: [], paths: {} })],
    ];
    for (const [reason, text] of cases) {
      writeFileSync(tableFile(dir), text);
      invalidateCache(dir);
      const warmed = await warmRevCache(dir);
      assert.equal(warmed.from, "full", text);
      assert.equal(warmed.reason, reason, text);
      assert.equal(savedTable(dir).head, headOf(dir));
      assert.deepEqual(savedTable(dir).table, whole);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs fn with a `git` first on PATH that notes each subcommand, then runs the real git.
async function gitCalls(fn) {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const bin = freshDir();
  const calls = join(bin, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${calls}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const result = await fn();
    return { result, calls: readFileSync(calls, "utf8").split("\n").filter(Boolean) };
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("a boot at the saved HEAD runs no git log", async () => {
  const { dir, write } = newStore();
  try {
    await write("a", [{ relpath: "db-schema/a.json", content: '{"a":1}\n' }]);
    invalidateCache(dir);
    await warmRevCache(dir);

    invalidateCache(dir);
    const same = await gitCalls(() => warmRevCache(dir));
    assert.equal(same.result.from, "saved");
    assert.equal(same.result.commits, 0);
    assert.deepEqual(same.calls, ["rev-parse"]);

    // The spy sees the walk when there is one.
    await write("b", [{ relpath: "db-schema/b.json", content: '{"b":1}\n' }]);
    invalidateCache(dir);
    const moved = await gitCalls(() => warmRevCache(dir));
    assert.equal(moved.result.commits, 1);
    assert.deepEqual(moved.calls, ["rev-parse", "merge-base", "log"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("closing the app saves the table at the HEAD the run moved to; a run that moved nothing writes nothing", async () => {
  const home = freshDir();
  const storeDir = join(home, "store");
  const people = [{ id: "kim", group: "admin", token: "admin-pw" }];
  try {
    const lines = [];
    const app = await buildApp({ storeDir, auth: await signIn(home, people), log: (line) => lines.push(line) });
    let open = true;
    try {
      const bootHead = savedTable(storeDir).head;
      // Boot itself commits rendered/types.json after the walk; then one more.
      await commitFiles(storeDir, { author: "kim", message: "x", writes: [{ relpath: "db-schema/x.json", content: "{}\n" }] });
      const head = headOf(storeDir);
      assert.notEqual(head, bootHead);
      open = false;
      await app.close();
      const saved = savedTable(storeDir);
      assert.equal(saved.head, head);
      assert.deepEqual(saved.table, await wholeWalk(storeDir));
      assert.match(lines.at(-1), new RegExp(`^rev 표: 저장본\\(${head.slice(0, 7)}\\) 씀 · 새 커밋 2 · \\d+ ms$`));
    } finally {
      if (open) await app.close();
    }

    const bytes = readFileSync(tableFile(storeDir));
    const again = [];
    const next = await buildApp({ storeDir, auth: await signIn(home, people), log: (line) => again.push(line) });
    await next.close();
    const head = headOf(storeDir);
    assert.ok(again.some((l) => new RegExp(`^rev 표: 저장본\\(${head.slice(0, 7)}\\) \\+ 새 커밋 0 · 경로 \\d+ · \\d+ ms$`).test(l)));
    assert.ok(!again.some((l) => /^rev 표: 저장본\(\w+\) 씀/.test(l)));
    assert.deepEqual(readFileSync(tableFile(storeDir)), bytes);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
