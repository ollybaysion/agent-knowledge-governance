// Rate limiting as it behaves on a *server* rather than on a laptop: behind a
// reverse proxy every request shares one source address, which is what makes
// the difference between "the limit throttles an attacker" and "the limit
// takes the whole company offline".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken, clearAuthFailures } from "../../server/auth.mjs";

const FAIL_LIMIT = 20; // server/auth.mjs

function freshHome() {
  const home = mkdtempSync(join(tmpdir(), "akg-ratelimit-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "alice", role: "approver", tokenHash: hashToken("good-token") },
  ]);
  return home;
}

async function appFor(home) {
  return buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
}

/** Burn through the failure budget from `headers`' apparent source address. */
async function exhaustLimit(app, headers = {}) {
  for (let i = 0; i <= FAIL_LIMIT; i++) {
    await app.inject({
      method: "GET",
      url: "/api/docs",
      headers: { ...headers, authorization: "Bearer wrong-token" },
    });
  }
}

test("one person's bad tokens must not lock anonymous readers out", async () => {
  const home = freshHome();
  const app = await appFor(home);
  clearAuthFailures("127.0.0.1");

  await exhaustLimit(app);

  // The limit is doing its job for anyone presenting a credential…
  const authed = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(authed.statusCode, 429);

  // …but an anonymous request presents none, so it cannot be brute-forcing a
  // token and has no business being throttled by someone else's typos. Behind
  // a shared-IP proxy this is the difference between one person being slowed
  // down and the read-only dashboard being down for everybody.
  const anon = await app.inject({ method: "GET", url: "/api/me" });
  assert.equal(anon.statusCode, 200);
  assert.equal(anon.json().anonymous, true);

  const docs = await app.inject({ method: "GET", url: "/api/docs" });
  assert.equal(docs.statusCode, 200);

  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("anonymous requests never feed the failure counter", async () => {
  const home = freshHome();
  const app = await appFor(home);
  clearAuthFailures("127.0.0.1");

  for (let i = 0; i <= FAIL_LIMIT; i++) {
    await app.inject({ method: "GET", url: "/api/docs" });
  }
  // If they counted, a valid token would now be locked out by traffic that
  // never attempted to authenticate at all.
  const authed = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(authed.statusCode, 200);

  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("without AKG_TRUST_PROXY, a forged X-Forwarded-For cannot dodge the limit", async () => {
  const home = freshHome();
  delete process.env.AKG_TRUST_PROXY;
  const app = await appFor(home);
  clearAuthFailures("127.0.0.1");

  // An attacker rotating the header on every attempt would get unlimited
  // guesses if the header were believed by default.
  for (let i = 0; i <= FAIL_LIMIT; i++) {
    await app.inject({
      method: "GET",
      url: "/api/docs",
      headers: {
        "x-forwarded-for": `10.0.0.${i}`,
        authorization: "Bearer wrong-token",
      },
    });
  }
  const next = await app.inject({
    method: "GET",
    url: "/api/docs",
    headers: {
      "x-forwarded-for": "10.0.0.99",
      authorization: "Bearer wrong-token",
    },
  });
  assert.equal(next.statusCode, 429);

  await app.close();
  rmSync(home, { recursive: true, force: true });
});

// Behind one reverse proxy the deployment sets AKG_TRUST_PROXY=1 — a hop
// count, not `true`. The header these tests send is what nginx's
// `$proxy_add_x_forwarded_for` produces: whatever the client sent, with the
// client's real address appended. So the RIGHTMOST entry is the trustworthy
// one, and a hop count of 1 is what makes Fastify read it.
async function appBehindOneProxy(home) {
  const prev = process.env.AKG_TRUST_PROXY;
  process.env.AKG_TRUST_PROXY = "1";
  // Read at buildApp time, so no module cache-busting is needed here.
  const app = await appFor(home);
  if (prev === undefined) delete process.env.AKG_TRUST_PROXY;
  else process.env.AKG_TRUST_PROXY = prev;
  return app;
}

test("AKG_TRUST_PROXY keys the limit on the real client, not the proxy", async () => {
  const home = freshHome();
  const app = await appBehindOneProxy(home);
  clearAuthFailures("10.0.0.1");
  clearAuthFailures("10.0.0.2");

  await exhaustLimit(app, { "x-forwarded-for": "10.0.0.1" });

  const culprit = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: {
      "x-forwarded-for": "10.0.0.1",
      authorization: "Bearer good-token",
    },
  });
  assert.equal(culprit.statusCode, 429, "the one who typo'd is throttled");

  const bystander = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: {
      "x-forwarded-for": "10.0.0.2",
      authorization: "Bearer good-token",
    },
  });
  assert.equal(
    bystander.statusCode,
    200,
    "a colleague behind the same proxy is unaffected",
  );

  await app.close();
  rmSync(home, { recursive: true, force: true });
});

test("a client cannot forge its way out of the limit, or onto someone else", async () => {
  const home = freshHome();
  const app = await appBehindOneProxy(home);
  clearAuthFailures("10.0.0.1");
  clearAuthFailures("10.0.0.2");

  // The attacker sits at 10.0.0.1 and sends its own X-Forwarded-For; the proxy
  // appends the real address, so the header arrives as "<forged>, 10.0.0.1".
  for (let i = 0; i <= FAIL_LIMIT; i++) {
    await app.inject({
      method: "GET",
      url: "/api/docs",
      headers: {
        "x-forwarded-for": `10.0.0.2, 10.0.0.1`,
        authorization: "Bearer wrong-token",
      },
    });
  }

  // Trusting the whole chain (AKG_TRUST_PROXY=true) would read the leftmost
  // entry, and both of these assertions would flip: the attacker would keep
  // guessing forever while the colleague they named got locked out.
  const attacker = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: {
      "x-forwarded-for": "10.0.0.99, 10.0.0.1",
      authorization: "Bearer good-token",
    },
  });
  assert.equal(
    attacker.statusCode,
    429,
    "rotating the forged part changes nothing",
  );

  const framed = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: {
      "x-forwarded-for": "10.0.0.2",
      authorization: "Bearer good-token",
    },
  });
  assert.equal(framed.statusCode, 200, "the named victim is not locked out");

  await app.close();
  rmSync(home, { recursive: true, force: true });
});
