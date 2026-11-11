// Thin wrapper around the `git` binary — spawn with an argv array, never a
// shell (design §11 S12: commit messages/paths must never pass through shell
// interpolation).
import { spawn, spawnSync } from "node:child_process";

export class GitError extends Error {}

// Default maxBuffer is 1MB, which `git log` over a long history can exceed.
// Unlike the bundle route this one is already fail-closed (r.error below
// throws), so an overflow is loud rather than silent — but it would still
// take out audit queries, so give it real headroom. gitEach() reads past it.
// A test lowers `limits.output` to stand in for an output over 64 MB.
export const limits = { output: 64 * 1024 * 1024 };

export function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: limits.output,
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
export async function gitAsync(cwd, args) {
  const out = [];
  let size = 0;
  await gitEach(cwd, args, (chunk) => {
    size += chunk.length;
    if (size > limits.output) throw new GitError(`git ${args[0]}: stdout maxBuffer exceeded`);
    out.push(chunk);
  });
  return Buffer.concat(out).toString("utf8");
}

/**
 * gitAsync() for an output of any size: stdout comes to `onChunk` piece by
 * piece as git writes it, and is never held whole. stderr keeps the limit.
 * A throw in `onChunk` stops git and rejects with that error.
 * @param {(chunk: Buffer) => void} onChunk
 * @returns {Promise<void>}
 */
export function gitEach(cwd, args, onChunk) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd });
    const err = [];
    let errSize = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      if (failed) return;
      try {
        onChunk(chunk);
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      errSize += chunk.length;
      if (errSize > limits.output) return fail(new GitError(`git ${args[0]}: stderr maxBuffer exceeded`));
      err.push(chunk);
    });
    child.on("error", (error) => fail(new GitError(`git ${args[0]}: ${error.message}`)));
    child.on("close", (code) => {
      if (failed) return;
      if (code !== 0) {
        failed = true;
        reject(new GitError(`git ${args.join(" ")} failed: ${Buffer.concat(err).toString("utf8").trim()}`));
        return;
      }
      resolve();
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
