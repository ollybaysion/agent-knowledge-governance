// Anonymous read (AKG_ANON_READ): a request with no token may read, but must
// never write, and a *wrong* token must never be silently downgraded to
// anonymous. ANON_READ is read at module load, so toggling it needs a fresh
// import of server/app.mjs — hence the import() with a cache-busting query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveUsers, hashToken } from "../../server/auth.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-anon-test-"));
}

// Build an app with AKG_ANON_READ set to `flag` for the duration of the import.
async function appWith(flag, home) {
  const prev = process.env.AKG_ANON_READ;
  if (flag === undefined) delete process.env.AKG_ANON_READ;
  else process.env.AKG_ANON_READ = flag;
  const mod = await import(`../../server/app.mjs?anon=${flag}`);
  if (prev === undefined) delete process.env.AKG_ANON_READ;
  else process.env.AKG_ANON_READ = prev;
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "editor", tokenHash: hashToken("good-token") },
  ]);
  return mod.buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
}

test("no token reads: /api/me reports the anonymous viewer", async () => {
  const home = freshHome();
  const app = await appWith(undefined, home); // default = on
  const res = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: null, role: "viewer", anonymous: true });
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("no token reads: document list and audit are readable", async () => {
  const home = freshHome();
  const app = await appWith(undefined, home);
  for (const url of ["/api/docs", "/api/audit", "/api/index/db-schema"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 200, `${url} should be anonymously readable`);
  }
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("no token writes: every mutation still 401s", async () => {
  const home = freshHome();
  const app = await appWith(undefined, home);
  const writes = [
    ["POST", "/api/docs/db-schema"],
    ["PUT", "/api/docs/db-schema/x.y"],
    ["DELETE", "/api/docs/db-schema/x.y"],
    ["POST", "/api/docs/db-schema/x.y/promote"],
    ["POST", "/api/docs/db-schema/x.y/deprecate"],
    ["POST", "/api/proposals"],
    ["GET", "/api/proposals"], // editor-only read — not part of anonymous read
  ];
  for (const [method, url] of writes) {
    const res = await app.inject({ method, url, payload: {} });
    assert.equal(res.statusCode, 401, `${method} ${url} must stay 401`);
    assert.equal(res.json().error, "unauthorized");
  }
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("a wrong token is a failed auth, not an anonymous visit", async () => {
  const home = freshHome();
  const app = await appWith(undefined, home);
  const res = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: { authorization: "Bearer wrong-token" },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("a real token still identifies the user on an anonOk route", async () => {
  const home = freshHome();
  const app = await appWith(undefined, home);
  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    id: "renoir",
    role: "editor",
    anonymous: false,
  });
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("AKG_ANON_READ=0 closes reads again", async () => {
  const home = freshHome();
  const app = await appWith("0", home);
  for (const url of ["/api/me", "/api/docs", "/api/bundle"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 401, `${url} must require a token when off`);
  }
  // …and a valid token still works with the flag off.
  const ok = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(ok.statusCode, 200);
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
