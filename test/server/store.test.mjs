import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  initStore,
  assertClean,
  commitFiles,
  readJson,
  readJsonAtRev,
  revOfPath,
  listIds,
  validateId,
  StoreError,
} from "../../server/store.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "akg-store-test-"));
}

test("initStore creates a clean git repo; assertClean passes right after", () => {
  const dir = freshDir();
  initStore(dir);
  assert.doesNotThrow(() => assertClean(dir));
  rmSync(dir, { recursive: true, force: true });
});

// A service account on a real server has no ~/.gitconfig. This developer
// machine does, and it would satisfy git's committer requirement for free —
// masking the very failure the test is here to catch. Point git's global and
// system config at nowhere so the repo's own config is the only source, which
// is the server's actual situation.
function withoutAmbientGitIdentity(fn) {
  const saved = {
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a store restored by clone can still be written to", () => {
  withoutAmbientGitIdentity(() => {
    // The restore path from docs/deploying.md. A clone carries the history but
    // none of the original's .git/config, and every commit needs a *committer*
    // identity on top of the --author it is given — so unless initStore fills
    // it back in, the first write after a restore dies on git's "Please tell
    // me who you are", surfaced to the user as an opaque 500.
    const origin = freshDir();
    initStore(origin);
    commitFiles(origin, {
      author: "renoir",
      message: "seed",
      writes: [{ relpath: "db-schema/t.sensor.json", content: "{}\n" }],
    });

    const restored = join(freshDir(), "store");
    spawnSync("git", ["clone", "-q", origin, restored], { encoding: "utf8" });
    assert.equal(
      spawnSync("git", ["-C", restored, "config", "--get", "user.email"], {
        encoding: "utf8",
      }).stdout.trim(),
      "",
      "a fresh clone must start with no identity, or this test proves nothing",
    );

    initStore(restored);
    assert.doesNotThrow(() =>
      commitFiles(restored, {
        author: "renoir",
        message: "write after restore",
        writes: [{ relpath: "db-schema/t.other.json", content: "{}\n" }],
      }),
    );
    assert.deepEqual(readJson(restored, "db-schema/t.sensor.json"), {});
  });
});

test("the committer identity is set on the repo, not inherited from ~/.gitconfig", () => {
  // `git config --get` also reads global and system config, so on any host
  // where the service account has a ~/.gitconfig this check would find an
  // identity, write nothing repo-local, and let that unrelated personal
  // identity become the committer of every commit in the audit log.
  const dir = freshDir();
  initStore(dir);

  const fakeGlobal = join(freshDir(), "gitconfig");
  writeFileSync(
    fakeGlobal,
    "[user]\n\tname = Someone Else\n\temail = else@example.com\n",
  );
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = fakeGlobal;
  spawnSync("git", ["-C", dir, "config", "--unset", "user.email"]);
  spawnSync("git", ["-C", dir, "config", "--unset", "user.name"]);
  try {
    initStore(dir);
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  }

  const local = spawnSync(
    "git",
    ["-C", dir, "config", "--local", "--get", "user.email"],
    { encoding: "utf8" },
  ).stdout.trim();
  assert.equal(local, "akg-server@akg.local");
  rmSync(dir, { recursive: true, force: true });
});

test("initStore does not overwrite an identity an operator chose", () => {
  const dir = freshDir();
  initStore(dir);
  spawnSync("git", ["-C", dir, "config", "user.email", "ops@example.com"]);
  initStore(dir);
  const got = spawnSync("git", ["-C", dir, "config", "--get", "user.email"], {
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(got, "ops@example.com");
  rmSync(dir, { recursive: true, force: true });
});

test("validateId rejects path traversal and non-lowercase ids", () => {
  assert.throws(() => validateId("../etc/passwd"), StoreError);
  assert.throws(() => validateId("Testuser.FDC"), StoreError);
  assert.doesNotThrow(() => validateId("testuser.fdc_sensor"));
});

test("commitFiles writes + commits, rev is retrievable, cache is warm without a fresh git log", () => {
  const dir = freshDir();
  initStore(dir);
  const rev = commitFiles(dir, {
    author: "renoir",
    message: "add doc",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  assert.match(rev, /^[0-9a-f]{40}$/);
  assert.equal(revOfPath(dir, "db-schema/t.x.json"), rev);
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("readJsonAtRev reads a historical version after a second commit changes the file", () => {
  const dir = freshDir();
  initStore(dir);
  const rev1 = commitFiles(dir, {
    author: "renoir",
    message: "v1",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":1}\n' }],
  });
  commitFiles(dir, {
    author: "renoir",
    message: "v2",
    writes: [{ relpath: "db-schema/t.x.json", content: '{"a":2}\n' }],
  });
  assert.deepEqual(readJsonAtRev(dir, "db-schema/t.x.json", rev1), { a: 1 });
  assert.deepEqual(readJson(dir, "db-schema/t.x.json"), { a: 2 });
  rmSync(dir, { recursive: true, force: true });
});

test("listIds lists ids by filename, ignoring .meta.json sidecars", () => {
  const dir = freshDir();
  initStore(dir);
  commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [
      { relpath: "db-schema/t.a.json", content: "{}" },
      { relpath: "db-schema/t.b.json", content: "{}" },
      { relpath: "unclassified/x.meta.json", content: "{}" },
    ],
  });
  assert.deepEqual(listIds(dir, "db-schema").sort(), ["t.a", "t.b"]);
  assert.deepEqual(listIds(dir, "unclassified"), []);
  rmSync(dir, { recursive: true, force: true });
});

test("assertClean throws when the tree has uncommitted changes (simulated manual git intervention, S9)", () => {
  const dir = freshDir();
  initStore(dir);
  commitFiles(dir, {
    author: "renoir",
    message: "seed",
    writes: [{ relpath: "db-schema/t.x.json", content: "{}" }],
  });
  // Simulate an out-of-band edit that never got committed.
  writeFileSync(join(dir, "db-schema/t.x.json"), '{"tampered":true}');
  assert.throws(() => assertClean(dir), StoreError);
  rmSync(dir, { recursive: true, force: true });
});
