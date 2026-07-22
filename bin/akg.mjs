#!/usr/bin/env node
// akg CLI (design §8.1). `sync` (Phase 2) pulls; `propose` / `catalog-push`
// (Phase 3) push. sync fails OPEN (a down server just means "try later" —
// it must never block a CC session). propose/catalog-push are explicit
// writes a caller asked for, so they fail CLOSED (non-zero exit on any
// failure) — the caller needs to know the write did not happen.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { syncMirror, AkgSyncError, REJECTED } from "../src/mirror/sync.mjs";
import { installSkills } from "../src/mirror/install-skills.mjs";
import { propose } from "../src/client/propose.mjs";
import { catalogPush } from "../src/client/catalog-push.mjs";
import { buildDocument, push, validateForPush } from "../src/client/push.mjs";
import { renderDocMd } from "../src/render/index.mjs";
import { AkgApiError } from "../src/client/errors.mjs";

const USAGE = `usage:
  akg sync [--skills] [--skills-dir <dir>] [--server <url>] [--mirror <dir>]
  akg push <type> <doc.json> [--dry-run] [--keyword <kw[:inject]>] [--status <s>]
  akg propose <type>/<id> <proposal.json> [--server <url>] [--mirror <dir>]
  akg catalog-push <table> <describe.json> [--server <url>] [--mirror <dir>]

  push takes a bare body (a foundry spec.json is a domain-skill body) or a
  full envelope; it creates the document, or updates it if it already exists.
  --dry-run validates and prints the rendered md without writing anything.
`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {
    skills: false,
    skillsDir: null,
    server: null,
    mirror: null,
    dryRun: false,
    keywords: null,
    status: null,
  };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--skills") flags.skills = true;
    else if (a === "--skills-dir") flags.skillsDir = rest[++i];
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--server") flags.server = rest[++i];
    else if (a === "--mirror") flags.mirror = rest[++i];
    else if (a === "--status") flags.status = rest[++i];
    else if (a === "--keyword") {
      // <kw>[:full|pointer] — repeatable. Default inject is `full`, matching
      // the envelope default a bare body would otherwise get.
      const raw = rest[++i] ?? "";
      const sep = raw.lastIndexOf(":");
      const kw = sep > 0 ? raw.slice(0, sep) : raw;
      const inject = sep > 0 ? raw.slice(sep + 1) : "full";
      (flags.keywords ??= []).push({ kw, inject });
    } else if (a.startsWith("--")) {
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

function resolveSkillsDir(flags) {
  return (
    flags.skillsDir ||
    process.env.AKG_SKILLS_DIR ||
    join(homedir(), ".claude", "skills")
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

// domain-skill ships as a directory per skill and deliberately has no
// index.json (json-spec §4.4), so countDocs cannot see it — a `sync --skills`
// that installed skills would otherwise report "0 docs" while writing files.
function countSkills(mirrorDir) {
  try {
    return readdirSync(join(mirrorDir, "domain-skill"), {
      withFileTypes: true,
    }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

// The mirror is not a place any agent looks, so a skill that stops here was
// never installed. Runs on the 304 path too: the mirror is already correct
// there, and re-running is how a hand-deleted skill comes back.
//
// Only ever with --skills. Without it the mirror has no domain-skill/, which
// this would read as "the corpus has no skills" and uninstall everything akg
// had put there — a plain `akg sync` must not do that.
function runInstall(flags, mirrorDir, rev) {
  const skillsDir = resolveSkillsDir(flags);
  let result;
  try {
    result = installSkills({
      sourceDir: join(mirrorDir, "domain-skill"),
      skillsDir,
      rev,
    });
  } catch (err) {
    // Fail-open like the sync itself: the mirror is good, so report and go.
    process.stderr.write(
      `akg: skill 설치 실패 (${skillsDir}): ${err.message}\n`,
    );
    return;
  }

  // Silent when nothing moved — this runs on a timer for most people, and a
  // line per run that always says the same thing stops being read.
  const { installed, removed, skipped } = result;
  if (installed.length || removed.length) {
    process.stdout.write(
      `installed ${installed.length} skills` +
        `${removed.length ? `, removed ${removed.length}` : ""} → ${skillsDir}\n`,
    );
  }
  // Never silent: a skipped skill is one the user asked for and did not get.
  for (const { name, reason } of skipped) {
    process.stderr.write(`akg: skill "${name}" 설치 건너뜀 — ${reason}\n`);
  }
}

async function runSync(flags, mirrorDir, token, serverUrl) {
  if (flags.skillsDir && !flags.skills) {
    process.stderr.write(
      "akg: --skills-dir 는 --skills 없이는 아무 일도 하지 않습니다\n",
    );
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
      const skills = countSkills(mirrorDir);
      process.stdout.write(
        `synced rev ${result.rev} (${countDocs(mirrorDir)} docs` +
          `${skills ? `, ${skills} skills` : ""})\n`,
      );
    }
    if (flags.skills) runInstall(flags, mirrorDir, result.rev);
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

async function runPush(positional, flags, token, serverUrl) {
  const [type, docPath] = positional;
  if (!type || !docPath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const parsed = readJsonFile(docPath, "document file");

  let doc;
  try {
    ({ doc } = buildDocument(type, parsed, {
      keywords: flags.keywords,
      status: flags.status,
    }));
  } catch (err) {
    process.stderr.write(`akg push: ${err.message}\n`);
    process.exit(1);
  }

  // Validate BEFORE the network. A malformed spec should fail the same way
  // whether or not a server is reachable, and the caller gets the field path
  // instead of an HTTP status.
  const errors = validateForPush(doc);
  if (errors.length) {
    process.stderr.write(
      `akg push: ${type}/${doc.id} 검증 실패\n${errors.map((e) => `  - ${e}`).join("\n")}\n`,
    );
    process.exit(1);
  }

  if (flags.dryRun) {
    const md = renderDocMd(type, doc);
    process.stdout.write(md ?? "(이 타입은 md 를 렌더하지 않습니다)\n");
    process.stderr.write(
      `\n[akg] DRY-RUN — ${type}/${doc.id} 검증 통과, 쓰기 없음. 올리려면 --dry-run 을 빼세요\n`,
    );
    return;
  }

  try {
    const result = await push({ serverUrl, token, type, doc });
    process.stdout.write(
      result.created
        ? `created ${type}/${doc.id} (rev ${result.rev})\n`
        : `updated ${type}/${doc.id} (rev ${result.rev}${result.rebased ? ", rebased" : ""})\n`,
    );
    if (result.envelopeIgnored) {
      process.stderr.write(
        `akg push: ${type}/${doc.id} 는 이미 있어 body 만 갱신했습니다 — keywords/status 는 기존 값을 유지합니다(대시보드에서 변경)\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`akg push failed: ${err.message}\n`);
    if (err instanceof AkgApiError && err.status === 409) {
      process.stderr.write(
        `akg push: 다른 편집과 충돌했습니다 — 최신본을 받아 다시 시도하세요\n`,
      );
    }
    // Fail CLOSED, same reasoning as propose/catalog-push.
    process.exit(1);
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
  const [rawId, describePath] = positional;
  if (!rawId || !describePath) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  // id = lower(table). A qualified owner.table is still accepted — the owner
  // part is dropped here so existing collector invocations keep working.
  const id = rawId.split(".").pop().toLowerCase();
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
  if (!["sync", "push", "propose", "catalog-push"].includes(cmd)) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  // A dry run touches nothing outside this process: no token, no server, no
  // mirror. Requiring either would make "check my spec" need credentials it
  // never uses, and the factory's approval step runs before any of that is
  // set up.
  const offline = cmd === "push" && flags.dryRun;
  if (offline) return runPush(positional, flags, null, null);

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
  else if (cmd === "push") await runPush(positional, flags, token, serverUrl);
  else if (cmd === "propose") await runPropose(positional, token, serverUrl);
  else await runCatalogPush(positional, token, serverUrl);
}

main();
