import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, frameAncestors } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-dashboard-test-"));
  const signedIn = await signIn(home, [
    { id: "renoir", group: "admin", token: "t" },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    auth: signedIn,
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
  const res = await app.inject({ headers: as("reader"), method: "GET", url: "/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.headers["content-security-policy"], /script-src 'self'/);
  assert.ok(res.body.includes('<script type="module" src="/js/main.mjs">'));
  await cleanup();
});

test("GET /js/main.mjs, /app.css and /lib/search.mjs are served publicly with the right content types", async () => {
  const { app, cleanup } = await setup();
  const js = await app.inject({ headers: as("reader"), method: "GET", url: "/js/main.mjs" });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"], /javascript/);

  const tab = await app.inject({ method: "GET", url: "/js/tabs/overview.mjs" });
  assert.equal(tab.statusCode, 200);
  assert.match(tab.headers["content-type"], /javascript/);

  const css = await app.inject({ headers: as("reader"), method: "GET", url: "/app.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"], /css/);

  const search = await app.inject({ headers: as("reader"), method: "GET", url: "/lib/search.mjs" });
  assert.equal(search.statusCode, 200);
  assert.match(search.headers["content-type"], /javascript/);
  await cleanup();
});

for (const name of ["skill-sections", "graph-model", "wikilinks", "verify-set", "sql-bind"]) {
  test(`GET /lib/shared/${name}.mjs serves src/${name}.mjs, byte for byte, publicly`, async () => {
    const { app, cleanup } = await setup();
    const res = await app.inject({ method: "GET", url: `/lib/shared/${name}.mjs` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /javascript/);
    assert.equal(res.body, readFileSync(new URL(`../../src/${name}.mjs`, import.meta.url), "utf8"));
    await cleanup();
  });
}

test("/lib/shared/ serves only the listed modules, and only to GET", async () => {
  const { app, cleanup } = await setup();
  for (const url of ["/lib/shared/validate.mjs", "/lib/shared/envelope.mjs", "/lib/shared/..%2Fserver%2Fapp.mjs"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
  }
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await app.inject({ method, url: "/lib/shared/skill-sections.mjs", headers: as("t"), payload: "x" });
    assert.equal(res.statusCode, 404, method);
  }
  await cleanup();
});

test("/js/ and /lib/ refuse a path outside their folder", async () => {
  const { app, cleanup } = await setup();
  for (const url of ["/js/../server/app.mjs", "/js/%2E%2E/server/app.mjs", "/lib/../../package.json", "/js/main.js", "/js/nope.mjs"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 404, url);
  }
  await cleanup();
});

test("GET /api/me is BE's {id, group} plus the logout address", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: as("t"),
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    id: "renoir",
    group: "admin",
    logout: "http://fdc.test/logout",
  });
  await cleanup();
});

test("GET /api/config hands the FE address to anyone, signed in or not", async () => {
  const { app, cleanup } = await setup();
  const res = await app.inject({ method: "GET", url: "/api/config" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { feUrl: "http://fdc.test" });
  await cleanup();
});

test("the CSP lets only this origin and the FE origin frame the page", async () => {
  const { app, cleanup } = await setup();
  for (const url of ["/", "/api/config", "/js/main.mjs"]) {
    const res = await app.inject({ method: "GET", url });
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'self' http:\/\/fdc\.test(;|$)/, url);
  }
  await cleanup();
});

test("frameAncestors takes the FE origin, and only 'self' when the address is not an http(s) URL", () => {
  assert.equal(frameAncestors("https://fe.example:8443/chat/"), "'self' https://fe.example:8443");
  assert.equal(frameAncestors("javascript:alert(1)"), "'self'");
  assert.equal(frameAncestors("not a url"), "'self'");
  assert.equal(frameAncestors(undefined), "'self'");
});
