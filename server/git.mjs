// Thin wrapper around the `git` binary — spawn with an argv array, never a
// shell (design §11 S12: commit messages/paths must never pass through shell
// interpolation).
import { spawnSync } from "node:child_process";

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
