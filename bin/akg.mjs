#!/usr/bin/env node
// akg CLI (design §8.1). `sync` (Phase 2) pulls; `propose` / `catalog-push`
// (Phase 3) push. sync fails OPEN (a down server just means "try later" —
// it must never block a CC session). propose/catalog-push are explicit
// writes a caller asked for, so they fail CLOSED (non-zero exit on any
// failure) — the caller needs to know the write did not happen.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { syncMirror, AkgSyncError, REJECTED } from "../src/mirror/sync.mjs";
import { propose } from "../src/client/propose.mjs";
import { catalogPush } from "../src/client/catalog-push.mjs";
import { AkgApiError } from "../src/client/errors.mjs";

const USAGE = `usage:
  akg sync [--skills] [--server <url>] [--mirror <dir>]
  akg propose <type>/<id> <proposal.json> [--server <url>] [--mirror <dir>]
  akg catalog-push <owner.table|table> <describe.json> [--server <url>] [--mirror <dir>]
`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = { skills: false, server: null, mirror: null };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--skills") flags.skills = true;
    else if (a === "--server") flags.server = rest[++i];
    else if (a === "--mirror") flags.mirror = rest[++i];
    else if (a.startsWith("--")) {
      process.stderr.write(`akg: unknown argument: ${a}\n`);
      process.exit(1);
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

function readJsonFile(path, label) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    process.stderr.write(
      `akg: cannot read ${label} "${path}": ${err.message}\n`,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `akg: ${label} "${path}" is not valid JSON: ${err.message}\n`,
    );
    process.exit(1);
  }
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

async function runSync(flags, mirrorDir, token, serverUrl) {
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
    // A 401 with no token means this server has anonymous read turned off —
    // say so, because "no token" is otherwise an invisible cause here.
    if (err instanceof AkgSyncError && err.status === 401 && !token) {
      process.stderr.write(
        "akg sync: this server requires a token to read (AKG_ANON_READ=0) — set AKG_TOKEN or write ~/.claude/akg/token (0600)\n",
      );
    }
    // Fail-open (§9.2): a sync failure must never block a CC session — the
    // existing mirror (if any) is untouched, so exit 0. Two exceptions, both
    // permanent conditions that a retry cannot clear and that leave the
    // mirror silently frozen at an old rev if we report success:
    //   401  — the token needs fixing.
    //   REJECTED — the bundle's shape was refused (layout this CLI doesn't
    //              know = it is older than the server, or a hostile entry).
    const permanent =
      err instanceof AkgSyncError &&
      (err.status === 401 || err.code === REJECTED);
    if (permanent && err.code === REJECTED) {
      process.stderr.write(
        "akg: 이 CLI가 서버 번들을 설치할 수 없습니다 — CLI가 서버보다 오래됐을 수 있습니다. 미러는 갱신되지 않았습니다.\n",
      );
    }
    process.exit(permanent ? 1 : 0);
  }
}

async function runPropose(positional, token, serverUrl) {
  const [spec, proposalPath] = positional;
  const slashIdx = spec ? spec.indexOf("/") : -1;
  if (!spec || slashIdx <= 0 || !proposalPath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const type = spec.slice(0, slashIdx);
  const id = spec.slice(slashIdx + 1);
  const parsed = readJsonFile(proposalPath, "proposal file");
  const slots = parsed?.slots;
  if (
    !slots ||
    typeof slots !== "object" ||
    Array.isArray(slots) ||
    Object.keys(slots).length === 0
  ) {
    process.stderr.write(
      `akg propose: "${proposalPath}" must contain a non-empty "slots" object\n`,
    );
    process.exit(1);
  }

  try {
    const result = await propose({ serverUrl, token, type, id, slots });
    process.stdout.write(
      result.deduped
        ? `proposal already pending: ${result.id}\n`
        : `proposed ${type}/${id}: ${result.id}\n`,
    );
  } catch (err) {
    process.stderr.write(`akg propose failed: ${err.message}\n`);
    // Fail CLOSED: unlike sync, this is a write the caller asked for — it
    // must surface a non-zero exit when it did not go through.
    process.exit(1);
  }
}

async function runCatalogPush(positional, token, serverUrl) {
  const [id, describePath] = positional;
  if (!id || !describePath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const catalog = readJsonFile(describePath, "describe_table file");

  try {
    const result = await catalogPush({ serverUrl, token, id, catalog });
    process.stdout.write(
      `catalog pushed: db-schema/${id} (rev ${result.rev})\n`,
    );
  } catch (err) {
    process.stderr.write(`akg catalog-push failed: ${err.message}\n`);
    if (err instanceof AkgApiError && err.status === 404) {
      process.stderr.write(
        `akg catalog-push: db-schema/${id} does not exist yet — create it first (dashboard or a proposal)\n`,
      );
    }
    // Fail CLOSED, same reasoning as propose.
    process.exit(1);
  }
}

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  if (!["sync", "propose", "catalog-push"].includes(cmd)) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  const mirrorDir = resolveMirrorDir(flags);

  // A token is required to WRITE. `sync` only reads, and a server with
  // anonymous read on (AKG_ANON_READ, the default) serves the bundle without
  // one — so pulling a mirror needs no setup at all. If that server does
  // require a token, the 401 path below says so.
  const token = resolveToken();
  if (!token && cmd !== "sync") {
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

  if (cmd === "sync") await runSync(flags, mirrorDir, token, serverUrl);
  else if (cmd === "propose") await runPropose(positional, token, serverUrl);
  else await runCatalogPush(positional, token, serverUrl);
}

main();
