// Single-writer store lock (S9). What matters here is the failure modes: a
// second server must be refused, a lock left by a killed server must not wedge
// the service forever, and two servers must never both believe they won.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { acquireStoreLock, StoreLockError } from "../../server/lock.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "akg-lock-test-"));
  return join(dir, "store");
}

function holderIn(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function currentBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null; // not Linux — the tests that need it skip themselves
  }
}

test("the lock lives beside the store, not inside it", async () => {
  const storeDir = freshStore();
  const lock = await acquireStoreLock(storeDir);
  // Inside a git working tree it would show up in every `git status`.
  assert.ok(!lock.path.startsWith(storeDir + "/"));
  assert.equal(lock.path, `${storeDir}.lock`);
  assert.equal(holderIn(lock.path).pid, process.pid);
  lock.release();
});

test("a second server on the same store is refused, naming the holder", async () => {
  const storeDir = freshStore();
  const first = await acquireStoreLock(storeDir);
  await assert.rejects(
    () => acquireStoreLock(storeDir),
    (err) =>
      err instanceof StoreLockError &&
      err.message.includes(String(process.pid)) &&
      err.message.includes(`rm ${first.path}`), // the operator needs a way out
  );
  first.release();
  // …and once it lets go, the next server starts normally.
  (await acquireStoreLock(storeDir)).release();
});

test("a lock left by a dead process is taken over, not fatal", async () => {
  const storeDir = freshStore();
  // PID 2^22 is above every Linux default pid_max, so it cannot be running.
  writeFileSync(`${storeDir}.lock`, JSON.stringify({ pid: 4194304 }));
  const lock = await acquireStoreLock(storeDir);
  assert.equal(holderIn(lock.path).pid, process.pid);
  lock.release();
});

test("a lock that survived a reboot is stale even if its pid is now in use", async (t) => {
  const bootId = currentBootId();
  if (!bootId) return t.skip("needs /proc/sys/kernel/random/boot_id");
  const storeDir = freshStore();
  // The pid is alive — it is ours. Only the boot id says this lock is old.
  // Without that check, a lock surviving a power cut wedges boot permanently
  // as soon as anything reuses its pid.
  writeFileSync(
    `${storeDir}.lock`,
    JSON.stringify({ pid: process.pid, bootId: "0000-old-boot", nonce: "x" }),
  );
  const lock = await acquireStoreLock(storeDir);
  assert.equal(holderIn(lock.path).pid, process.pid);
  lock.release();
});

test("a reused pid is detected by start time, not trusted as the holder", async (t) => {
  const bootId = currentBootId();
  if (!bootId) return t.skip("needs /proc");
  const storeDir = freshStore();
  // Same boot, live pid, but it started at a different time — so it is a
  // different process that merely inherited the number.
  writeFileSync(
    `${storeDir}.lock`,
    JSON.stringify({ pid: process.pid, bootId, startTime: "1", nonce: "x" }),
  );
  const lock = await acquireStoreLock(storeDir);
  assert.equal(holderIn(lock.path).nonce !== "x", true);
  lock.release();
});

test("a live holder with a matching start time is respected", async (t) => {
  const bootId = currentBootId();
  if (!bootId) return t.skip("needs /proc");
  const storeDir = freshStore();
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  writeFileSync(
    `${storeDir}.lock`,
    JSON.stringify({ pid: process.pid, bootId, startTime, nonce: "x" }),
  );
  await assert.rejects(() => acquireStoreLock(storeDir), StoreLockError);
});

test("an unreadable lock counts as stale — a crash mid-write can't wedge boot", async () => {
  const storeDir = freshStore();
  writeFileSync(`${storeDir}.lock`, "");
  const lock = await acquireStoreLock(storeDir);
  assert.equal(holderIn(lock.path).pid, process.pid);
  lock.release();
});

test("release is idempotent and leaves no file behind", async () => {
  const storeDir = freshStore();
  const lock = await acquireStoreLock(storeDir);
  lock.release();
  assert.equal(existsSync(lock.path), false);
  lock.release(); // exit handler after a signal handler — must not throw
  assert.equal(existsSync(lock.path), false);
});

test("release never removes a lock somebody else now holds", async () => {
  const storeDir = freshStore();
  const lock = await acquireStoreLock(storeDir);
  // A server that recovered the store after we were presumed dead. Deleting
  // its lock on our way out would let a third process start alongside it.
  writeFileSync(
    lock.path,
    JSON.stringify({ pid: 4242, bootId: "other", nonce: "not-ours" }),
  );
  lock.release();
  assert.equal(existsSync(lock.path), true);
  assert.equal(holderIn(lock.path).nonce, "not-ours");
});

test("a contender that loses the stale-lock race stands down", async () => {
  const storeDir = freshStore();
  const path = `${storeDir}.lock`;
  writeFileSync(path, JSON.stringify({ pid: 4194304 })); // stale

  // The interleaving that unlink-then-create got wrong: two processes both
  // find the same stale lock, both recover it, and the second one's unlink
  // deletes the first one's fresh lock — so both believe they won (~8% of
  // contested recoveries, measured). Driven deterministically here rather than
  // by racing real processes, which would only reproduce it sometimes: hold
  // the acquire mid-settle and do exactly what a competing recovery does.
  const mine = acquireStoreLock(storeDir);
  await new Promise((resolve) => setTimeout(resolve, 20)); // let it write, still inside SETTLE_MS
  const rival = JSON.stringify({ pid: process.pid, nonce: "rival" });
  writeFileSync(`${path}.rival.tmp`, rival);
  renameSync(`${path}.rival.tmp`, path);

  await assert.rejects(() => mine, StoreLockError);
  assert.equal(holderIn(path).nonce, "rival", "the rival keeps the store");

  rmSync(dirname(storeDir), { recursive: true, force: true });
});

test("the winner of a stale-lock race keeps it", async () => {
  const storeDir = freshStore();
  writeFileSync(`${storeDir}.lock`, JSON.stringify({ pid: 4194304 }));
  const lock = await acquireStoreLock(storeDir);
  assert.equal(holderIn(lock.path).pid, process.pid);
  // And a later arrival now sees a live holder rather than a stale one.
  await assert.rejects(() => acquireStoreLock(storeDir), StoreLockError);
  lock.release();
});
