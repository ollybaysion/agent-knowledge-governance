import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, AuthBootError } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { StoreError } from "../../server/store.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-app-test-"));
}

function seedUsers(home, users) {
  saveUsers(join(home, "users.json"), users);
}

test("buildApp refuses to boot without users.json (S1)", async () => {
  const home = freshHome();
  await assert.rejects(
    buildApp({
      storeDir: join(home, "store"),
      usersPath: join(home, "users.json"),
    }),
    AuthBootError,
  );
  rmSync(home, { recursive: true, force: true });
});

test("GET /health is public and returns a version + storeRev", async () => {
  const home = freshHome();
  seedUsers(home, [
    { id: "renoir", role: "approver", tokenHash: hashToken("t") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.version);
  assert.ok(body.storeRev); // init commit already exists
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("a protected route without a token returns 401; with a wrong token also 401", async () => {
  const home = freshHome();
  seedUsers(home, [
    { id: "renoir", role: "viewer", tokenHash: hashToken("right-token") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });

  // A write route is the protected one now: reads opt into anonymous access
  // (see anon-read.test.mjs), writes never do.
  const noAuth = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    payload: {},
  });
  assert.equal(noAuth.statusCode, 401);

  // A wrong token 401s on a read route too — presenting a bad credential is
  // not the same as presenting none, so it is never downgraded to anonymous.
  const wrongAuth = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(wrongAuth.statusCode, 401);

  const rightAuth = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: { authorization: "Bearer right-token" },
  });
  assert.equal(rightAuth.statusCode, 200);

  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("GET /api/schemas/:type is public and serves the body schema", async () => {
  const home = freshHome();
  seedUsers(home, [
    { id: "renoir", role: "viewer", tokenHash: hashToken("t") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  const res = await app.inject({
    method: "GET",
    url: "/api/schemas/db-schema",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().$id, "db-schema/v1");
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
