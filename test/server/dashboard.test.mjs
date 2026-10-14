import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("GET /app.js, /app.css and /search.mjs are served publicly with the right content types", async () => {
  const { app, cleanup } = await setup();
  const js = await app.inject({ method: "GET", url: "/app.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"], /javascript/);

  const css = await app.inject({ method: "GET", url: "/app.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"], /css/);

  const search = await app.inject({ method: "GET", url: "/search.mjs" });
  assert.equal(search.statusCode, 200);
  assert.match(search.headers["content-type"], /javascript/);
  await cleanup();
});

test("GET /skill-sections.mjs serves the validator's own splitter, byte for byte, publicly", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({ method: "GET", url: "/skill-sections.mjs" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /javascript/);
  assert.equal(
    res.body,
    readFileSync(new URL("../../src/skill-sections.mjs", import.meta.url), "utf8"),
  );
  await cleanup();
});

test("GET /wikilinks.mjs serves the server's own [[ ]] parser, byte for byte, publicly", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({ method: "GET", url: "/wikilinks.mjs" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /javascript/);
  assert.equal(res.body, readFileSync(new URL("../../src/wikilinks.mjs", import.meta.url), "utf8"));
  await cleanup();
});

test("GET /verify-set.mjs serves the validator's own verification-set reader, byte for byte, publicly", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({ method: "GET", url: "/verify-set.mjs" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /javascript/);
  assert.equal(res.body, readFileSync(new URL("../../src/verify-set.mjs", import.meta.url), "utf8"));
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
