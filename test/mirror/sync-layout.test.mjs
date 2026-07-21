// Regression tests for §13-3: the mirror refused bundles whose top level it
// did not recognise, but `akg sync` reported exit 0 for that refusal. Since
// the refusal is permanent (the CLI is older than the server), every mirror
// would have stopped updating while every wrapper script saw success. The
// fix splits permanent refusals (exit 1) from transient failures (exit 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { commitFiles } from "../../server/store.mjs";
import { syncMirror, AkgSyncError, REJECTED } from "../../src/mirror/sync.mjs";

const BIN = fileURLToPath(new URL("../../bin/akg.mjs", import.meta.url));

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-layout-server-"));
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

function fetchImplFromApp(app, token) {
  return async (url) => {
    const u = new URL(url);
    const res = await app.inject({
      method: "GET",
      url: u.pathname + u.search,
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] },
      arrayBuffer: async () => {
        const buf = res.rawPayload;
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
      },
    };
  };
}

test("an unknown top-level folder is refused with the permanent-failure code", async () => {
  const { app, storeDir, cleanup } = await setupServer();
  commitFiles(storeDir, {
    author: "renoir",
    message: "server emits a type this CLI does not know",
    writes: [{ relpath: "rendered/from-the-future/docs/a.md", content: "# a\n" }],
  });
  const mirrorDir = join(mkdtempSync(join(tmpdir(), "akg-layout-mirror-")), "akg");

  await assert.rejects(
    () =>
      syncMirror({
        serverUrl: "http://x",
        token: "vtok",
        mirrorDir,
        fetchImpl: fetchImplFromApp(app, "vtok"),
      }),
    (err) => {
      assert.ok(err instanceof AkgSyncError);
      assert.equal(err.code, REJECTED);
      return true;
    },
  );
  await cleanup();
});

test("unclassified is accepted ahead of the server emitting it — no client release needed first", async () => {
  const { app, storeDir, cleanup } = await setupServer();
  commitFiles(storeDir, {
    author: "renoir",
    message: "server starts emitting unclassified",
    writes: [
      { relpath: "rendered/unclassified/docs/note.md", content: "# note\n" },
      { relpath: "rendered/unclassified/index.json", content: "[]\n" },
    ],
  });
  const mirrorDir = join(mkdtempSync(join(tmpdir(), "akg-layout-mirror-")), "akg");

  const result = await syncMirror({
    serverUrl: "http://x",
    token: "vtok",
    mirrorDir,
    fetchImpl: fetchImplFromApp(app, "vtok"),
  });
  assert.equal(result.changed, true);
  assert.ok(existsSync(join(mirrorDir, "unclassified", "docs", "note.md")));
  await cleanup();
});

// The unit test above proves the throw; this proves the CLI actually turns it
// into a non-zero exit, which is the part that was broken.
//
// t.after, not a trailing await cleanup(): this test listens on a real socket,
// so if an assertion throws before cleanup the runner waits forever on the
// open handle. A test that hangs exactly when it fails is useless.
test("cli sync: a refused bundle exits non-zero instead of reporting success", async (t) => {
  const { app, storeDir, cleanup } = await setupServer();
  t.after(cleanup);
  commitFiles(storeDir, {
    author: "renoir",
    message: "server emits a type this CLI does not know",
    writes: [{ relpath: "rendered/from-the-future/docs/a.md", content: "# a\n" }],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const serverUrl = `http://127.0.0.1:${app.server.address().port}`;
  const mirrorDir = join(mkdtempSync(join(tmpdir(), "akg-layout-mirror-")), "akg");

  const r = await new Promise((resolve) => {
    const child = spawn(
      "node",
      [BIN, "sync", "--server", serverUrl, "--mirror", mirrorDir],
      { env: { ...process.env, AKG_TOKEN: "vtok" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

  assert.notEqual(r.status, 0, `exit 0이면 회귀다. stderr=${r.stderr}`);
  assert.match(r.stderr, /from-the-future/);
});
