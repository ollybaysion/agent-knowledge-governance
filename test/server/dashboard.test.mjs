import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-dashboard-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "approver", tokenHash: hashToken("t") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("GET / serves the dashboard shell, publicly, with a strict CSP header", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({ method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.ok(res.body.includes('<script src="/app.js">'));
  await cleanup();
});

test("GET /app.js and /app.css are served publicly with the right content types", async () => {
  const { app, cleanup } = await setup();
  const js = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"], /javascript/);

  const css = await app.inject({ method: "GET", url: "/app.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"], /css/);
  await cleanup();
});

test("GET /api/me echoes id/role without leaking tokenHash", async () => {
  const { app, cleanup } = await setup();
  // Without a token this now answers as the anonymous viewer — that response is
  // what boots the dashboard's read-only view (see anon-read.test.mjs).
  const anon = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.json().anonymous, true);

  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer t" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    id: "renoir",
    role: "approver",
    anonymous: false,
  });
  await cleanup();
});
