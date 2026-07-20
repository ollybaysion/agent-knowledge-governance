#!/usr/bin/env node
// akg CLI (design §8.1). Phase 2 implements only `sync` — propose/catalog-push
// are Phase 3 (see agent-knowledge-governance-phase2-instructions.md scope).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { syncMirror, AkgSyncError } from "../src/mirror/sync.mjs";

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = { skills: false, server: null, mirror: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--skills") flags.skills = true;
    else if (a === "--server") flags.server = rest[++i];
    else if (a === "--mirror") flags.mirror = rest[++i];
    else {
      process.stderr.write(`akg: unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return { cmd, flags };
}

// §8.1: token file 0600 or AKG_TOKEN env. We don't enforce the mode here
// (that's an operator responsibility, S14) — a missing file is the only
// condition this CLI treats as a config error.
function resolveToken() {
  if (process.env.AKG_TOKEN) return process.env.AKG_TOKEN;
  try {
    return readFileSync(
      join(homedir(), ".claude", "akg", "token"),
      "utf8",
    ).trim();
  } catch {
    return null;
  }
}

function resolveMirrorDir(flags) {
  return (
    flags.mirror || process.env.AKG_MIRROR || join(homedir(), ".claude", "akg")
  );
}

function resolveServerUrl(flags, mirrorDir) {
  if (flags.server) return flags.server;
  if (process.env.AKG_SERVER) return process.env.AKG_SERVER;
  try {
    const meta = JSON.parse(readFileSync(join(mirrorDir, "meta.json"), "utf8"));
    if (typeof meta.serverUrl === "string" && meta.serverUrl)
      return meta.serverUrl;
  } catch {
    /* no existing mirror meta — fall through to error */
  }
  return null;
}

// index.json entries split full/pointer keyword bundles into up to 2 rows
// per doc that share the same `path` (json-spec §5.1) — count unique paths
// per type, not rows, so "N docs" means documents, not index entries.
function countDocs(mirrorDir) {
  const seen = new Set();
  for (const type of ["db-schema", "msg-format", "domain"]) {
    try {
      const index = JSON.parse(
        readFileSync(join(mirrorDir, type, "index.json"), "utf8"),
      );
      for (const entry of index) {
        if (entry?.path) seen.add(`${type}/${entry.path}`);
      }
    } catch {
      /* type not present in this mirror */
    }
  }
  return seen.size;
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd !== "sync") {
    process.stderr.write(
      "usage: akg sync [--skills] [--server <url>] [--mirror <dir>]\n",
    );
    process.exit(1);
  }

  const mirrorDir = resolveMirrorDir(flags);

  const token = resolveToken();
  if (!token) {
    process.stderr.write(
      "akg: no token — set AKG_TOKEN or write ~/.claude/akg/token (0600)\n",
    );
    process.exit(1);
  }

  const serverUrl = resolveServerUrl(flags, mirrorDir);
  if (!serverUrl) {
    process.stderr.write(
      "akg: no server URL — pass --server, set AKG_SERVER, or sync once with --server first\n",
    );
    process.exit(1);
  }

  try {
    const result = await syncMirror({
      serverUrl,
      token,
      mirrorDir,
      skills: flags.skills,
    });
    if (!result.changed) {
      process.stdout.write(`up to date (rev ${result.rev ?? "none"})\n`);
    } else {
      process.stdout.write(
        `synced rev ${result.rev} (${countDocs(mirrorDir)} docs)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`akg sync failed: ${err.message}\n`);
    // Fail-open (§9.2): a sync failure must never block a CC session — the
    // existing mirror (if any) is untouched, so exit 0 unless this was an
    // auth failure, which the user needs to actually see and fix.
    process.exit(err instanceof AkgSyncError && err.status === 401 ? 1 : 0);
  }
}

main();
