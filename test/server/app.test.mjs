import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, AuthBootError } from "../../server/app.mjs";
import { authConfig, signIn, as, writeSession, sessionCookie, readSession } from "../sign-in.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-app-test-"));
}

async function setup(people = [{ id: "kim", group: "admin", token: "admin-pw" }]) {
  const home = freshHome();
  const app = await buildApp({ storeDir: join(home, "store"), auth: await signIn(home, people) });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const newDoc = () => ({
  schema: "db-schema/v1",
  id: "x",
  keywords: [{ kw: "x", inject: "full" }],
  status: "active",
  body: {
    owner: "T",
    table: "X",
    catalog: {
      columns: [{ name: "A", type: "NUMBER", nullable: false }],
      primaryKey: ["A"],
      fetchedAt: "2026-01-01T00:00:00Z",
    },
    purpose: { text: null, tier: "scaffold" },
    columnDescs: { A: { text: null, tier: "scaffold" } },
  },
});

test("boot refuses without the password file, with a group/other-readable one, and without the FE address (S1)", async () => {
  const home = freshHome();
  const usersFile = join(home, "users.yml");
  await assert.rejects(buildApp({ storeDir: join(home, "store"), auth: authConfig(usersFile) }), AuthBootError);

  writeFileSync(usersFile, "users:\n  - { id: kim, group: admin, password: pw }\n", { mode: 0o644 });
  await assert.rejects(buildApp({ storeDir: join(home, "store"), auth: authConfig(usersFile) }), /0600/);

  writeFileSync(usersFile, "users:\n  - { id: kim, group: admin, password: pw }\n", { mode: 0o600 });
  await assert.rejects(
    buildApp({ storeDir: join(home, "store"), auth: { ...authConfig(usersFile), fdcUrl: "" } }),
    /AKG_FDC_URL/,
  );
  rmSync(home, { recursive: true, force: true });
});

test("boot refuses when Redis is not there (S1)", async () => {
  const home = freshHome();
  const usersFile = join(home, "users.yml");
  writeFileSync(usersFile, "users:\n  - { id: kim, group: admin, password: pw }\n", { mode: 0o600 });
  await assert.rejects(
    buildApp({ storeDir: join(home, "store"), auth: { ...authConfig(usersFile), redisUrl: "redis://127.0.0.1:1" } }),
    /Redis/,
  );
  rmSync(home, { recursive: true, force: true });
});

test("no session: 401 with the FE login address, on reads and /health alike", async () => {
  const { app, cleanup } = await setup();
  try {
    for (const url of ["/api/docs", "/api/me", "/health", "/api/schemas/db-schema"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 401, url);
      assert.deepEqual(res.json(), { error: "unauthorized", login: "http://fdc.test/login" });
    }
    // A cookie that names no session, and a session from before login (no identity), are the same.
    const unknown = await app.inject({ method: "GET", url: "/api/docs", headers: { cookie: sessionCookie("no-such-session") } });
    assert.equal(unknown.statusCode, 401);
    const beforeLogin = await writeSession({});
    const anon = await app.inject({ method: "GET", url: "/api/docs", headers: { cookie: sessionCookie(beforeLogin) } });
    assert.equal(anon.statusCode, 401);
  } finally {
    await cleanup();
  }
});

test("GET /health answers a signed-in caller with a version + storeRev", async () => {
  const { app, cleanup } = await setup();
  try {
    const res = await app.inject({ method: "GET", url: "/health", headers: as("reader") });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().version);
    assert.ok(res.json().storeRev); // init commit already exists
  } finally {
    await cleanup();
  }
});

test("a session whose last request is older than its idle limit is over", async () => {
  const { app, cleanup } = await setup();
  try {
    const id = await writeSession({ id: "lee", group: "user" }, { lastAccessedTime: Date.now() - 31 * 60 * 1000 });
    const res = await app.inject({ method: "GET", url: "/api/docs", headers: { cookie: sessionCookie(id) } });
    assert.equal(res.statusCode, 401);
  } finally {
    await cleanup();
  }
});

test("a request keeps the shared session alive the way Spring does: lastAccessedTime = now, expiry = now + idle limit", async () => {
  const { app, cleanup } = await setup();
  try {
    const before = Date.now() - 10 * 60 * 1000;
    const id = await writeSession({ id: "lee", group: "user" }, { lastAccessedTime: before });
    const res = await app.inject({ method: "GET", url: "/api/docs", headers: { cookie: sessionCookie(id) } });
    assert.equal(res.statusCode, 200);
    const { fields, pttl } = await readSession(id);
    assert.ok(Number(fields.lastAccessedTime) > before);
    assert.ok(pttl > 29 * 60 * 1000 && pttl <= 30 * 60 * 1000, String(pttl));
    // Everything else BE wrote stays as it was.
    assert.equal(JSON.parse(fields["sessionAttr:fdc.identity"]).id, "lee");
    assert.equal(fields.maxInactiveInterval, "1800");
  } finally {
    await cleanup();
  }
});

test("CSRF: a session write needs the session's token in X-CSRF-TOKEN; a Bearer write needs none", async () => {
  const { app, cleanup } = await setup([
    { id: "kim", group: "admin", token: "admin-pw" },
    { id: "bot", group: "agent", token: "bot-pw" },
  ]);
  try {
    const { cookie } = as("admin-pw");
    const none = await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: { cookie }, payload: newDoc() });
    assert.equal(none.statusCode, 403);
    assert.equal(none.json().error, "invalid_csrf");
    const wrong = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: { cookie, "x-csrf-token": "not-it" },
      payload: newDoc(),
    });
    assert.equal(wrong.json().error, "invalid_csrf");
    const ok = await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: as("admin-pw"), payload: newDoc() });
    assert.equal(ok.statusCode, 201, ok.body);

    const batch = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/batch",
      headers: as("bot-pw"),
      payload: { docs: [{ ...newDoc(), id: "y", body: { ...newDoc().body, table: "Y" } }] },
    });
    assert.notEqual(batch.statusCode, 403, batch.body);
  } finally {
    await cleanup();
  }
});

test("GET /api/me: {id, group, logout} and the session's CSRF token; a session with none gets one in BE's shape", async () => {
  const { app, cleanup } = await setup();
  try {
    const signed = as("admin-pw");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: signed.cookie } });
    assert.deepEqual(me.json(), { id: "kim", group: "admin", logout: "http://fdc.test/logout" });
    assert.equal(me.headers["x-csrf-token"], signed["x-csrf-token"]);

    const id = await writeSession({ id: "lee", group: "user" }, { csrf: null });
    const first = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie(id) } });
    const token = first.headers["x-csrf-token"];
    assert.match(token, /^[0-9a-f-]{36}$/);
    const { fields } = await readSession(id);
    assert.deepEqual(JSON.parse(fields["sessionAttr:fdc.csrf"]), {
      "@class": "org.springframework.security.web.csrf.DefaultCsrfToken",
      headerName: "X-CSRF-TOKEN",
      parameterName: "_csrf",
      token,
    });
    const again = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: sessionCookie(id) } });
    assert.equal(again.headers["x-csrf-token"], token);
  } finally {
    await cleanup();
  }
});

test("Bearer is the agent's way in: an agent line's password passes, a person's password and a wrong value are 401", async () => {
  const { app, cleanup } = await setup([
    { id: "kim", group: "admin", token: "admin-pw" },
    { id: "bot", group: "agent", token: "bot-pw" },
  ]);
  try {
    const read = await app.inject({ method: "GET", url: "/api/docs", headers: { authorization: "Bearer bot-pw" } });
    assert.equal(read.statusCode, 200);
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer bot-pw" } });
    assert.deepEqual(me.json(), { id: "bot", group: "agent", logout: "http://fdc.test/logout" });
    assert.equal(me.headers["x-csrf-token"], undefined);

    for (const value of ["admin-pw", "wrong", ""]) {
      const res = await app.inject({ method: "GET", url: "/api/docs", headers: { authorization: `Bearer ${value}` } });
      assert.equal(res.statusCode, 401, value);
      assert.deepEqual(res.json(), { error: "unauthorized" });
    }
  } finally {
    await cleanup();
  }
});

// AKG 권한표 (auth 설계 2026-10-24): 읽기 = user · admin · agent, 편집 · 승격 · 삭제 = admin,
// agent 쓰기(batch · facts · catalog · 제안 · 점수) = admin · agent.
test("permission table: each group gets exactly its rows", async () => {
  const { app, cleanup } = await setup([
    { id: "kim", group: "admin", token: "admin-pw" },
    { id: "lee", group: "user", token: "user-pw" },
    { id: "bot", group: "agent", token: "bot-pw" },
  ]);
  try {
    const rows = [
      ["GET", "/api/docs", { admin: true, user: true, agent: true }],
      ["GET", "/api/audit", { admin: true, user: true, agent: true }],
      ["GET", "/api/bundle", { admin: true, user: true, agent: true }],
      ["POST", "/api/docs/db-schema", { admin: true, user: false, agent: false }],
      ["GET", "/api/proposals", { admin: true, user: false, agent: false }],
      ["DELETE", "/api/docs/db-schema/x", { admin: true, user: false, agent: false }],
      ["POST", "/api/docs/db-schema/batch", { admin: true, user: false, agent: true }],
      ["POST", "/api/proposals", { admin: true, user: false, agent: true }],
    ];
    const tokens = { admin: "admin-pw", user: "user-pw", agent: "bot-pw" };
    for (const [method, url, allowed] of rows) {
      for (const [group, token] of Object.entries(tokens)) {
        const res = await app.inject({ method, url, headers: as(token), payload: method === "GET" ? undefined : {} });
        if (allowed[group]) assert.notEqual(res.statusCode, 403, `${group} ${method} ${url}: ${res.body}`);
        else assert.equal(res.statusCode, 403, `${group} ${method} ${url}: ${res.body}`);
      }
    }
  } finally {
    await cleanup();
  }
});
