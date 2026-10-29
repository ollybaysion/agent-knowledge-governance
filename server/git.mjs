// Thin wrapper around the `git` binary — spawn with an argv array, never a
// shell (design §11 S12: commit messages/paths must never pass through shell
// interpolation).
import { spawn, spawnSync } from "node:child_process";

export class GitError extends Error {}

// Default maxBuffer is 1MB, which `git log` over a long history can exceed.
// Unlike the bundle route this one is already fail-closed (r.error below
// throws), so an overflow is loud rather than silent — but it would still
// take out audit queries, so give it real headroom.
const MAX_BUFFER = 64 * 1024 * 1024;

export function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (r.error) throw new GitError(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new GitError(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

/**
 * git() without blocking the event loop: other requests are served while git
 * runs. Same errors, same output limit.
 * @returns {Promise<string>} stdout
 */
export function gitAsync(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const out = [];
    const err = [];
    const size = { out: 0, err: 0 };
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(error);
    };
    const collect = (chunks, key) => (chunk) => {
      size[key] += chunk.length;
      if (size[key] > MAX_BUFFER) return fail(new GitError(`git ${args[0]}: ${key === "out" ? "stdout" : "stderr"} maxBuffer exceeded`));
      chunks.push(chunk);
    };
    child.stdout.on("data", collect(out, "out"));
    child.stderr.on("data", collect(err, "err"));
    child.on("error", (error) => fail(new GitError(`git ${args[0]}: ${error.message}`)));
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) {
        failed = true;
        reject(new GitError(`git ${args.join(" ")} failed: ${Buffer.concat(err).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

/** True if `dir` is a clean, existing git working tree (no dirty tree, no index.lock). */
export function isCleanRepo(dir) {
  let status;
  try {
    status = git(dir, ["status", "--porcelain"]);
  } catch {
    return false;
  }
  return status.trim() === "";
}
