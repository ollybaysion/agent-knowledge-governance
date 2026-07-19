// Thin wrapper around the `git` binary — spawn with an argv array, never a
// shell (design §11 S12: commit messages/paths must never pass through shell
// interpolation).
import { spawnSync } from "node:child_process";

export class GitError extends Error {}

export function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
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
