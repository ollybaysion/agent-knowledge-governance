// Installing synced domain-skills where an agent will actually find them.
//
// `sync --skills` puts SKILL.md in the mirror, but no agent reads the mirror:
// Claude Code discovers personal skills under ~/.claude/skills/<name>/, and
// opencode reads that same directory as one of its global skill paths. So one
// install target serves both — there is no per-agent branching here.
//
// Copy, not symlink: symlinked skill directories are not a documented part of
// either agent's discovery, and a link into a mirror that gets replaced
// wholesale on every sync turns a bad sync into a set of dangling skills.
//
// The hazard this module exists to avoid is deleting a skill somebody wrote by
// hand. Every install and every removal is gated on a manifest of what akg
// itself put there; a directory akg does not claim is never written to and
// never removed, only reported.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const MANIFEST_NAME = ".akg-installed.json";

// The skill-name rule both agents enforce on frontmatter `name` (and which the
// directory must match). Doubling as path-escape defense: no separators, no
// dots, so a corpus entry can never address anything outside skillsDir.
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The manifest lives in skillsDir, not the mirror: the mirror is replaced
 * wholesale by each sync, which would erase the record of what we own right
 * before we need it. A dotfile is invisible to skill discovery (both agents
 * look for <dir>/SKILL.md), so it is inert where it sits.
 */
export function manifestPath(skillsDir) {
  return join(skillsDir, MANIFEST_NAME);
}

function readManifest(skillsDir) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(skillsDir), "utf8"));
    const skills = parsed?.skills;
    if (skills && typeof skills === "object" && !Array.isArray(skills)) {
      return skills;
    }
  } catch {
    /* absent or unreadable — treat as "akg owns nothing here" */
  }
  return {};
}

function writeManifest(skillsDir, skills) {
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    manifestPath(skillsDir),
    JSON.stringify({ version: 1, skills }, null, 2) + "\n",
  );
}

// A skill in the bundle is a directory holding a SKILL.md. Anything else in
// domain-skill/ is not something we know how to install, so it is not a skill.
function readCorpus(sourceDir) {
  let entries;
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return []; // no domain-skill/ in this mirror
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(sourceDir, name, "SKILL.md")));
}

/**
 * Install every skill in `sourceDir` into `skillsDir`, and remove the ones akg
 * previously installed that the corpus no longer has.
 *
 * Never throws for a single bad skill — one unwritable directory should not
 * cost the caller the other twenty. Per-skill failures come back in `skipped`.
 *
 * @param {{sourceDir: string, skillsDir: string, rev?: string|null}} opts
 * @returns {{installed: string[], unchanged: string[], removed: string[],
 *            skipped: Array<{name: string, reason: string}>}}
 */
export function installSkills({ sourceDir, skillsDir, rev = null }) {
  const owned = readManifest(skillsDir);
  const installed = [];
  const unchanged = [];
  const removed = [];
  const skipped = [];

  const corpus = readCorpus(sourceDir);
  const inCorpus = new Set();

  for (const name of corpus) {
    if (!SKILL_NAME.test(name)) {
      skipped.push({ name, reason: "invalid skill name" });
      continue;
    }
    inCorpus.add(name);
    const target = join(skillsDir, name);

    // Someone else's skill of the same name. Refuse both ways — do not
    // overwrite it, and do not claim it in the manifest (which would license
    // us to delete it on a later sync).
    if (existsSync(target) && !owned[name]) {
      skipped.push({ name, reason: "not installed by akg — left untouched" });
      continue;
    }

    // Already ours at this exact rev, and still on disk. Copying again would
    // produce the same bytes and report work that did not happen — a sync on
    // a timer would then claim an install every time it ran. The existsSync
    // is what keeps this from papering over a hand-deleted skill: if the
    // directory is gone, we fall through and put it back.
    if (
      rev &&
      owned[name]?.rev === rev &&
      existsSync(join(target, "SKILL.md"))
    ) {
      unchanged.push(name);
      continue;
    }

    try {
      // Replace rather than merge: a file dropped from the rendered skill
      // must not survive in the installed copy.
      rmSync(target, { recursive: true, force: true });
      mkdirSync(skillsDir, { recursive: true });
      cpSync(join(sourceDir, name), target, { recursive: true });
      owned[name] = { installedAt: new Date().toISOString(), rev };
      installed.push(name);
    } catch (err) {
      skipped.push({ name, reason: err.message });
    }
  }

  for (const name of Object.keys(owned)) {
    if (inCorpus.has(name)) continue;
    // Gone from the corpus. It is ours, so it goes — but drop the claim even
    // if the removal fails, otherwise a permanently unremovable directory is
    // retried on every sync forever.
    try {
      const target = join(skillsDir, name);
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
        removed.push(name);
      }
    } catch (err) {
      skipped.push({ name, reason: `removal failed: ${err.message}` });
    }
    delete owned[name];
  }

  writeManifest(skillsDir, owned);
  return { installed, unchanged, removed, skipped };
}
