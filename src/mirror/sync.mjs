// akg CLI `sync` (design §8.1, §8.2): pull the server's rendered/ bundle into
// the local mirror ~/.claude/akg/<type>/{index.json, docs/*.md} (§5.6). This
// is the ONLY thing Phase 2 does — it never talks to claude-hooks, it only
// produces files claude-hooks' keyword-docs provider already knows how to
// read via a context.json `params.index` override (D1).
//
// Fail-open is the load-bearing property (§9.2 acceptance row 2): every
// failure path below throws BEFORE the existing mirrorDir is ever touched.
// All extraction happens in a sibling temp directory; only the final rename
// swap touches mirrorDir, and even that has a backup+rollback.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export class AkgSyncError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "AkgSyncError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Marks failures that will not fix themselves: the bundle's shape is one this
 * CLI refuses to install (unknown layout → the client is older than the
 * server) or one it considers hostile (traversal, symlinks). sync otherwise
 * fails open so a flaky server never blocks a CC session, but swallowing
 * THESE means the mirror stops updating and says nothing — the exact failure
 * that motivated the split. Transient trouble (HTTP errors, a corrupt or
 * truncated download) keeps failing open, because a retry genuinely fixes it.
 */
export const REJECTED = "bundle_rejected";

// Node's spawnSync default is 1MB of captured output.
const MAX_BUFFER = 64 * 1024 * 1024;

// §5.6 mirror layout's known type folders. "domain" (domain-doc render) has
// no schema yet (json-spec §5.5 lists it as a future type) but is allowed
// here so a server that starts emitting it doesn't need a CLI release first.
const ALLOWED_TYPE_DIRS = new Set([
  "db-schema",
  "msg-format",
  "domain",
  "domain-skill",
  // Same reasoning as "domain": listed before the server emits it, so that
  // turning it on server-side does not require every client to upgrade first.
  "unclassified",
]);

function readLocalRev(mirrorDir) {
  try {
    const meta = JSON.parse(readFileSync(join(mirrorDir, "meta.json"), "utf8"));
    return typeof meta.rev === "string" ? meta.rev : null;
  } catch {
    return null;
  }
}

function bundleUrl(serverUrl, since) {
  const base = serverUrl.replace(/\/+$/, "");
  return since
    ? `${base}/api/bundle?since=${encodeURIComponent(since)}`
    : `${base}/api/bundle`;
}

// S11 zip-slip defense, step 1: reject the tar LISTING before extracting
// anything. Every entry must live under rendered/ and contain no `..`
// segment or absolute path — checked against the raw member names tar
// reports, independent of what --strip-components later does to them.
function assertSafeEntries(names) {
  for (const name of names) {
    if (!name) continue;
    if (name.startsWith("/")) {
      throw new AkgSyncError(`unsafe tar entry (absolute path): ${name}`, {
        code: REJECTED,
      });
    }
    if (name !== "rendered" && !name.startsWith("rendered/")) {
      throw new AkgSyncError(`unexpected tar entry outside rendered/: ${name}`, {
        code: REJECTED,
      });
    }
    if (name.split("/").includes("..")) {
      throw new AkgSyncError(`unsafe tar entry (path traversal): ${name}`, {
        code: REJECTED,
      });
    }
  }
}

// S11 zip-slip defense, step 2 (defense in depth, post-extraction): only
// known type folders may appear at the mirror's top level.
function assertKnownTopLevel(dir) {
  for (const entry of readdirSync(dir)) {
    if (!ALLOWED_TYPE_DIRS.has(entry)) {
      throw new AkgSyncError(`unexpected top-level entry in bundle: ${entry}`, {
        code: REJECTED,
      });
    }
  }
}

// S11 zip-slip defense, step 3: a legitimate bundle never contains symlinks
// (it's server-rendered md/json). Reject any — a symlink entry could later
// be used to write through it to a path outside the mirror.
function assertNoSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AkgSyncError(`refusing symlink in bundle: ${p}`, {
        code: REJECTED,
      });
    }
    if (entry.isDirectory()) assertNoSymlinks(p);
  }
}

function rmrf(p) {
  rmSync(p, { recursive: true, force: true });
}

/**
 * @param {{serverUrl: string, token: string, mirrorDir: string, skills?: boolean, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{changed: boolean, rev: string|null}>}
 */
export async function syncMirror({
  serverUrl,
  token,
  mirrorDir,
  skills = false,
  fetchImpl = fetch,
}) {
  const localRev = readLocalRev(mirrorDir);

  const res = await fetchImpl(bundleUrl(serverUrl, localRev), {
    headers: { authorization: `Bearer ${token}` },
  });

  if (res.status === 304) return { changed: false, rev: localRev };
  if (res.status < 200 || res.status >= 300) {
    throw new AkgSyncError(`bundle fetch failed: HTTP ${res.status}`, {
      status: res.status,
    });
  }

  const newRev = res.headers.get("etag");
  if (!newRev) throw new AkgSyncError("bundle response missing etag header");

  const buf = Buffer.from(await res.arrayBuffer());

  // maxBuffer: the listing is one line per file, so it grows with the corpus
  // — the same 1MB default that broke the server's bundle route applies here.
  const listing = spawnSync("tar", ["-tzf", "-"], {
    input: buf,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  if (listing.status !== 0) {
    throw new AkgSyncError(
      `corrupt bundle (tar -tzf failed): ${listing.stderr}`,
    );
  }
  assertSafeEntries(listing.stdout.split("\n").filter(Boolean));

  mkdirSync(dirname(mirrorDir), { recursive: true });
  const tmpDir = `${mirrorDir}.tmp-${randomBytes(4).toString("hex")}`;
  mkdirSync(tmpDir, { recursive: true });

  try {
    const extract = spawnSync(
      "tar",
      ["-xzf", "-", "-C", tmpDir, "--strip-components=1"],
      { input: buf, maxBuffer: MAX_BUFFER },
    );
    if (extract.status !== 0) {
      throw new AkgSyncError(
        `bundle extraction failed: ${extract.stderr?.toString()}`,
      );
    }

    assertKnownTopLevel(tmpDir);
    assertNoSymlinks(tmpDir);

    if (!skills) rmrf(join(tmpDir, "domain-skill"));

    writeFileSync(
      join(tmpDir, "meta.json"),
      JSON.stringify(
        { serverUrl, rev: newRev, syncedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
  } catch (err) {
    rmrf(tmpDir);
    throw err;
  }

  // Atomic swap: back up the existing mirror, rename tmp into place, drop
  // the backup on success. On rename failure, roll the backup back so
  // mirrorDir is never left missing.
  let backupDir = null;
  if (existsSync(mirrorDir)) {
    backupDir = `${mirrorDir}.bak-${randomBytes(4).toString("hex")}`;
    renameSync(mirrorDir, backupDir);
  }
  try {
    renameSync(tmpDir, mirrorDir);
  } catch (err) {
    if (backupDir) renameSync(backupDir, mirrorDir);
    rmrf(tmpDir);
    throw err;
  }
  if (backupDir) rmrf(backupDir);

  return { changed: true, rev: newRev };
}
