// Single-writer lock (design §11 S9, §D7). The store is a git repository and
// every write goes through one in-process serial queue; the failed-auth rate
// limit is likewise in-process. All three assume exactly one server process
// owns a given store. Nothing enforced that — a second `node server/main.mjs`
// against the same AKG_HOME started happily and interleaved commits into the
// same repo, which is the kind of corruption that surfaces days later as a
// mangled history rather than as an error.
//
// Scope, stated plainly: this catches the mistake that actually happens — a
// manual run alongside the service, or a restart that overlaps its predecessor
// — on one host. It is NOT a distributed lock. PIDs are namespaced, so two
// containers sharing a store volume cannot see each other's processes and this
// will not stop them; keeping a store single-host is a deployment rule, not
// something a file can enforce.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export class StoreLockError extends Error {}

// How long to let a contested stale-takeover settle before deciding who won.
// Only ever paid on the recovery path (a previous server died without
// releasing), never on a normal boot.
const SETTLE_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readBootId() {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null; // not Linux — see identityMatches()
  }
}

/**
 * Field 22 of /proc/<pid>/stat: the process's start time in clock ticks. Two
 * different processes that happen to share a pid cannot share this.
 * Deliberately parsed from after the last ')' — the comm field is parenthesised
 * and may itself contain spaces and parentheses.
 */
function readStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null; // field 22 overall, 20th after comm+state
  } catch {
    return null;
  }
}

function selfIdentity() {
  return {
    pid: process.pid,
    bootId: readBootId(),
    startTime: readStartTime(process.pid),
    // Distinguishes *this* acquisition from any other, including a later one
    // by a process with the same pid. Ownership checks compare this, not pid.
    nonce: randomBytes(12).toString("hex"),
  };
}

function readHolder(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    // Absent, truncated by a crash mid-write, or from an older version that
    // wrote a bare pid. None of those identify a live holder, and a lock
    // nobody can attribute helps nobody — treat as stale.
    return null;
  }
}

/**
 * Is the process described by `holder` still running? Three checks, because
 * pid alone is not an identity:
 *   - a different boot id means the lock predates a reboot, so its pid is
 *     meaningless. Without this, a lock file that survives a power cut wedges
 *     boot forever the moment its pid gets reused by anything.
 *   - the pid must exist. EPERM means it exists under another user, which is
 *     still a reason to refuse; only ESRCH proves it is gone.
 *   - the start time must match, which catches pid reuse within one boot.
 * Where /proc is unavailable (non-Linux), bootId/startTime are null and this
 * degrades to the pid check alone — weaker, and the reason a wedged lock has
 * to stay manually removable.
 */
function isHolderAlive(holder) {
  const bootId = readBootId();
  if (holder.bootId && bootId && holder.bootId !== bootId) return false;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false;

  try {
    process.kill(holder.pid, 0); // signal 0 tests existence without delivering anything
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }

  if (holder.startTime) {
    const current = readStartTime(holder.pid);
    if (current && current !== holder.startTime) return false; // pid was reused
  }
  return true;
}

function heldByMessage(holder, storeDir, path) {
  return (
    `이미 다른 akg 서버(pid ${holder.pid})가 이 스토어를 쓰고 있습니다: ${storeDir}\n` +
    `  akg는 스토어당 프로세스 하나만 허용합니다(S9) — 쓰기 큐와 git 커밋이 직렬이어야 합니다.\n` +
    `  그 프로세스를 멈추거나, 다른 AKG_HOME으로 기동하세요.\n` +
    `  그 pid가 akg 서버가 아니라고 확신하면: rm ${path}`
  );
}

/**
 * Take the lock for `storeDir`, or throw StoreLockError naming the holder.
 * The lock lives beside the store rather than inside it: the store is a git
 * working tree, and a stray runtime file there would show up in every
 * `git status` and risk being committed.
 *
 * @returns {Promise<{path: string, release: () => void}>}
 */
export async function acquireStoreLock(storeDir) {
  const path = `${storeDir}.lock`;
  const self = selfIdentity();
  const payload = JSON.stringify(self) + "\n";

  // Taken before initStore, which is what would otherwise create the tree.
  mkdirSync(dirname(path), { recursive: true });

  const handle = () => ({ path, release: () => releaseIfOurs(path, self) });

  try {
    // "wx" fails if the file exists, and does so atomically — two servers
    // racing to boot cannot both believe they won.
    writeFileSync(path, payload, { flag: "wx" });
    return handle();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  const holder = readHolder(path);
  if (holder && isHolderAlive(holder)) {
    throw new StoreLockError(heldByMessage(holder, storeDir, path));
  }

  // Stale — the previous writer died without releasing (SIGKILL, power loss).
  //
  // Recovery must NOT be unlink-then-create: two processes can both unlink the
  // same stale file and both go on to create one, and the second unlink
  // silently deletes the first's fresh lock. Measured at ~8% of contested
  // recoveries, and the trigger (a stale lock plus a service restart racing a
  // manual start) is exactly when this happens.
  //
  // Instead: replace the file atomically, let the dust settle, then check whose
  // nonce is actually in it. Both contenders read the same stale holder and
  // both write; only one can be last, and the other reads a nonce that is not
  // its own and stands down. A third process arriving after either write reads
  // a *live* holder and is refused at the check above.
  //
  // What SETTLE_MS actually buys, stated honestly: it bounds the window, it
  // does not close it. A contender that reads the stale holder and then stalls
  // for longer than SETTLE_MS before writing would overwrite a lock whose owner
  // has already finished verifying. That is a scheduler pathology, not the
  // ordinary restart-races-a-manual-start case this is for; closing it fully
  // needs flock(2), which Node does not expose.
  const tmp = `${path}.${self.pid}.${self.nonce}.tmp`;
  writeFileSync(tmp, payload);
  renameSync(tmp, path);

  await sleep(SETTLE_MS);

  const winner = readHolder(path);
  if (winner?.nonce !== self.nonce) {
    throw new StoreLockError(
      `다른 프로세스가 먼저 stale 락을 회수했습니다: ${path}\n` +
        `  akg는 스토어당 프로세스 하나만 허용합니다(S9).`,
    );
  }
  return handle();
}

/**
 * Remove the lock only if it is still the one we took. A lock we no longer own
 * belongs to a server that recovered it after we were presumed dead — deleting
 * that would let a third process start alongside it, which is the exact
 * situation the lock exists to prevent.
 */
function releaseIfOurs(path, self) {
  const holder = readHolder(path);
  if (holder?.nonce !== self.nonce) return;
  try {
    unlinkSync(path);
  } catch {
    // Gone between the read and the unlink. Nothing to repair, and throwing
    // here would mask the real reason the process is exiting.
  }
}
