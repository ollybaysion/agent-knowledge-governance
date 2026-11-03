// JSON and text answers over 1 KB go gzipped to a client that takes gzip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { acceptsGzip, buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n${"글 ".repeat(200)}\n` },
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-gzip-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  for (const id of ["a", "b", "c"]) assert.equal((await app.inject({ method: "POST", url: "/api/docs/voc", headers: as("a"), payload: voc(id) })).statusCode, 201);
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("GET /api/docs with accept-encoding: gzip comes gzipped and unpacks to the same JSON", async () => {
  const { app, cleanup } = await setup();
  try {
    const plain = await app.inject({ method: "GET", url: "/api/docs?fields=body", headers: as("a") });
    assert.ok(plain.rawPayload.length > 1024);
    const packed = await app.inject({ method: "GET", url: "/api/docs?fields=body", headers: { ...as("a"), "accept-encoding": "gzip, deflate, br" } });
    assert.equal(packed.statusCode, 200);
    assert.equal(packed.headers["content-encoding"], "gzip");
    assert.equal(packed.headers.vary, "accept-encoding");
    assert.match(packed.headers["content-type"], /application\/json/);
    assert.equal(Number(packed.headers["content-length"]), packed.rawPayload.length);
    assert.ok(packed.rawPayload.length < plain.rawPayload.length);
    assert.deepEqual(JSON.parse(gunzipSync(packed.rawPayload).toString("utf8")), plain.json());
    assert.ok(packed.headers["content-security-policy"]);
  } finally {
    await cleanup();
  }
});

test("without accept-encoding, or with gzip;q=0, the answer is plain", async () => {
  const { app, cleanup } = await setup();
  try {
    for (const headers of [as("a"), { ...as("a"), "accept-encoding": "gzip;q=0, identity" }]) {
      const res = await app.inject({ method: "GET", url: "/api/docs?fields=body", headers });
      assert.equal(res.headers["content-encoding"], undefined);
      assert.equal(res.headers.vary, "accept-encoding");
      assert.ok(Array.isArray(res.json().docs));
    }
  } finally {
    await cleanup();
  }
});

test("a small answer stays plain; a big script goes gzipped", async () => {
  const { app, cleanup } = await setup();
  try {
    const small = await app.inject({ method: "GET", url: "/api/config", headers: { "accept-encoding": "gzip" } });
    assert.equal(small.headers["content-encoding"], undefined);
    assert.deepEqual(small.json(), { feUrl: "http://fdc.test" });
    const js = await app.inject({ method: "GET", url: "/vendor/mermaid/mermaid.min.js", headers: { "accept-encoding": "gzip" } });
    assert.equal(js.headers["content-encoding"], "gzip");
    assert.ok(gunzipSync(js.rawPayload).toString("utf8").includes('globalThis["mermaid"]'));
  } finally {
    await cleanup();
  }
});

test("acceptsGzip: named gzip without q=0", () => {
  assert.equal(acceptsGzip("gzip"), true);
  assert.equal(acceptsGzip("br, GZIP;q=0.5"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("deflate, br"), false);
  assert.equal(acceptsGzip(undefined), false);
});
