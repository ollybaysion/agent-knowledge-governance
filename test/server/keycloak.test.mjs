// The Keycloak way in for agents, against a stand-in realm: a local HTTP
// server with the discovery document and the JWKS, and tokens signed here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, AuthBootError } from "../../server/app.mjs";
import { authConfig, signIn, as } from "../sign-in.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "k1";

async function realm() {
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}/realms/fdc-voc-agent`;
    res.setHeader("content-type", "application/json");
    if (req.url === "/realms/fdc-voc-agent/.well-known/openid-configuration")
      return res.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/protocol/openid-connect/certs` }));
    if (req.url === "/realms/fdc-voc-agent/protocol/openid-connect/certs")
      return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${server.address().port}/realms/fdc-voc-agent`;
  return { issuer, close: () => new Promise((r) => server.close(r)) };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

function token(issuer, claims = {}, { key = privateKey, kid = KID, header = {} } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT", kid, ...header });
  const body = b64({
    iss: issuer,
    exp: now + 300,
    iat: now,
    typ: "Bearer",
    azp: "fdc-voc-agent-a2a",
    preferred_username: "service-account-fdc-voc-agent-a2a",
    resource_access: { "fdc-voc-agent": { roles: ["agent"] } },
    ...claims,
  });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

async function setup(issuer) {
  const home = mkdtempSync(join(tmpdir(), "akg-keycloak-test-"));
  // The people's sessions come from BE either way; only the agent way in differs.
  const signedIn = await signIn(home, [{ id: "kim", group: "admin", token: "admin-pw" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth: { ...signedIn, usersFile: "", keycloakIssuer: issuer } });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("boot refuses when the realm is not there", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-keycloak-test-"));
  await assert.rejects(
    buildApp({
      storeDir: join(home, "store"),
      auth: { ...authConfig(""), keycloakIssuer: "http://127.0.0.1:1/realms/fdc-voc-agent" },
    }),
    AuthBootError,
  );
  rmSync(home, { recursive: true, force: true });
});

test("a realm access token with client role agent is the agent; the login address is Keycloak's", async () => {
  const r = await realm();
  const { app, cleanup } = await setup(r.issuer);
  try {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token(r.issuer)}` } });
    assert.equal(me.statusCode, 200, me.body);
    assert.deepEqual(me.json(), {
      id: "service-account-fdc-voc-agent-a2a",
      group: "agent",
      logout: "http://fdc.test/logout",
    });
    const anon = await app.inject({ method: "GET", url: "/api/docs" });
    assert.equal(anon.json().login, "http://fdc.test/oauth2/authorization/keycloak");
    // A person's session works the same on a Keycloak server.
    assert.equal((await app.inject({ method: "GET", url: "/api/docs", headers: as("admin-pw") })).statusCode, 200);
  } finally {
    await cleanup();
    await r.close();
  }
});

test("401 for every token that is not a current agent access token of this realm", async () => {
  const r = await realm();
  const { app, cleanup } = await setup(r.issuer);
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    expired: token(r.issuer, { exp: now - 120 }),
    "not yet valid": token(r.issuer, { nbf: now + 600 }),
    "other issuer": token(r.issuer, { iss: "http://elsewhere/realms/fdc-voc-agent" }),
    "id token": token(r.issuer, { typ: "ID" }),
    "a person (no agent role)": token(r.issuer, { resource_access: {} }),
    "an admin person": token(r.issuer, { resource_access: { "fdc-voc-agent": { roles: ["admin"] } } }),
    "role of another client": token(r.issuer, { resource_access: { other: { roles: ["agent"] } } }),
    "other key": token(r.issuer, {}, { key: other.privateKey }),
    "unknown kid": token(r.issuer, {}, { kid: "k9" }),
    "alg none": token(r.issuer, {}, { header: { alg: "none" } }),
    garbage: "a.b.c",
  };
  try {
    for (const [name, value] of Object.entries(cases)) {
      const res = await app.inject({ method: "GET", url: "/api/docs", headers: { authorization: `Bearer ${value}` } });
      assert.equal(res.statusCode, 401, name);
    }
  } finally {
    await cleanup();
    await r.close();
  }
});

test("the agent gets the same answers on a Keycloak server as on a server with the password file", async () => {
  const r = await realm();
  const kc = await setup(r.issuer);
  const home = mkdtempSync(join(tmpdir(), "akg-keycloak-test-"));
  const pw = await buildApp({
    storeDir: join(home, "store"),
    auth: await signIn(home, [{ id: "bot", group: "agent", token: "bot-pw" }]),
  });
  const rows = [
    ["GET", "/api/docs"],
    ["GET", "/api/bundle"],
    ["POST", "/api/docs/db-schema"],
    ["GET", "/api/proposals"],
    ["POST", "/api/docs/db-schema/batch"],
    ["POST", "/api/proposals"],
    ["DELETE", "/api/docs/db-schema/x"],
  ];
  try {
    for (const [method, url] of rows) {
      const payload = method === "GET" ? undefined : {};
      const viaKeycloak = await kc.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token(r.issuer)}` } });
      const viaFile = await pw.inject({ method, url, payload, headers: as("bot-pw") });
      assert.equal(viaKeycloak.statusCode, viaFile.statusCode, `${method} ${url}`);
    }
  } finally {
    await kc.cleanup();
    await pw.close();
    rmSync(home, { recursive: true, force: true });
    await r.close();
  }
});
