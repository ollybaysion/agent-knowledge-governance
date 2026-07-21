// Regression tests for §13-2: /api/bundle used spawnSync with the default
// 1MB maxBuffer, so a corpus whose rendered/ crossed ~1MB gzipped turned the
// route into a permanent 500 — with the cause hidden (it lands in r.error,
// which was never read) and `akg sync` failing open, so every mirror would
// have frozen at an old rev without complaint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { commitFiles } from "../../server/store.mjs";

const ONE_MB = 1024 * 1024;

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-bundle-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "viewer1", role: "viewer", tokenHash: hashToken("vtok") },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, usersPath: join(home, "users.json") });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("bundle streams a corpus larger than the old 1MB buffer instead of 500ing", async () => {
  const { app, storeDir, cleanup } = await setup();

  // Random base64 barely compresses, so this really does clear 1MB gzipped —
  // a compressible filler would pass even against the unfixed code.
  const writes = [];
  for (let i = 0; i < 3; i++) {
    writes.push({
      relpath: `rendered/db-schema/docs/big-${i}.md`,
      content: randomBytes(700 * 1024).toString("base64"),
    });
  }
  commitFiles(storeDir, { author: "renoir", message: "big corpus", writes });

  const res = await app.inject({
    method: "GET",
    url: "/api/bundle",
    headers: { authorization: "Bearer vtok" },
  });

  assert.equal(res.statusCode, 200);
  const body = res.rawPayload;
  assert.ok(
    body.length > ONE_MB,
    `번들이 1MB를 넘어야 이 회귀를 증명한다 (실제 ${body.length}바이트)`,
  );

  // Not just big — actually a well-formed archive, so a truncated stream
  // could not pass this test.
  const listing = spawnSync("tar", ["-tzf", "-"], {
    input: body,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listing.status, 0, `tar -tzf 실패: ${listing.stderr}`);
  for (let i = 0; i < 3; i++) {
    assert.match(listing.stdout, new RegExp(`rendered/db-schema/docs/big-${i}\\.md`));
  }
  await cleanup();
});

test("bundle still answers 304 when the caller already has HEAD", async () => {
  const { app, storeDir, cleanup } = await setup();
  commitFiles(storeDir, {
    author: "renoir",
    message: "small corpus",
    writes: [{ relpath: "rendered/db-schema/docs/a.md", content: "# a\n" }],
  });

  const first = await app.inject({
    method: "GET",
    url: "/api/bundle",
    headers: { authorization: "Bearer vtok" },
  });
  assert.equal(first.statusCode, 200);
  const rev = first.headers.etag;
  assert.match(rev, /^[0-9a-f]{40}$/);

  const second = await app.inject({
    method: "GET",
    url: `/api/bundle?since=${rev}`,
    headers: { authorization: "Bearer vtok" },
  });
  assert.equal(second.statusCode, 304);
  await cleanup();
});
