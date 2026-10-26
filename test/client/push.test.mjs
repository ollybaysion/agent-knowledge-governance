// akg CLI `push` — src/client/push.mjs against a real in-process server
// (buildApp(), app.inject through an injected fetchImpl, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";
import { push, checkPushFile } from "../../src/client/push.mjs";
import { AkgApiError } from "../../src/client/errors.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-push-"));
  const auth = await signIn(home, [
    { id: "editor1", group: "admin", token: "ed-tok" },
    { id: "agent1", group: "agent", token: "agent-tok" },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method ?? "GET", path: u.pathname, headers: opts.headers ?? {} });
    const res = await app.inject({
      method: opts.method ?? "GET",
      url: u.pathname + u.search,
      headers: opts.headers,
      payload: opts.body,
    });
    return { status: res.statusCode, json: async () => res.json() };
  };
  const base = { serverUrl: "http://akg.test", token: "agent-tok", fetchImpl };
  return {
    app,
    calls,
    base,
    admin: (method, url, payload, headers = {}) =>
      app.inject({ method, url, headers: { ...as("ed-tok"), ...headers }, payload }),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const vocDoc = (id, markdown, extra = {}) => ({
  schema: "voc/v1",
  id,
  keywords: [{ kw: id, inject: "pointer" }],
  status: "active",
  body: { name: id, markdown },
  ...extra,
});

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AkgApiError, String(err));
    return err;
  }
  assert.fail("push did not throw");
}

test("push .json: an existing document is edited with the server's rev, the note rides along, no CSRF header", async () => {
  const t = await setup();
  try {
    await t.admin("POST", "/api/docs/voc", vocDoc("n", "# n\n\n글\n"));
    const r = await push({ ...t.base, type: "voc", id: "n", file: { kind: "json", doc: vocDoc("n", "# n\n\n고친 글\n") }, note: "cc 수정" });
    assert.equal(r.action, "edited");
    assert.deepEqual(r.kept, []);
    const put = t.calls.find((c) => c.method === "PUT");
    assert.equal(put.headers["x-akg-note"], encodeURIComponent("cc 수정"));
    assert.equal(put.headers["x-csrf-token"], undefined);
    assert.ok(put.headers["if-match"]);
    const got = await t.admin("GET", "/api/docs/voc/n");
    assert.equal(got.json().json.body.markdown, "# n\n\n고친 글\n");
    assert.equal(got.json().rev, r.rev);
  } finally {
    await t.cleanup();
  }
});

test("push: a missing document stops without --create; with --create a .md makes an inactive md document", async () => {
  const t = await setup();
  try {
    const err = await rejection(push({ ...t.base, type: "voc", id: "fresh", file: { kind: "md", markdown: "# 새 글\n" } }));
    assert.equal(err.status, 404);
    assert.match(err.message, /--create/);
    assert.equal(t.calls.filter((c) => c.method !== "GET").length, 0);

    const r = await push({ ...t.base, type: "voc", id: "fresh", file: { kind: "md", markdown: "# 새 글\n" }, create: true });
    assert.equal(r.action, "created");
    const got = await t.admin("GET", "/api/docs/voc/fresh");
    assert.equal(got.json().json.status, "inactive");
    assert.deepEqual(got.json().json.body, { name: "fresh", markdown: "# 새 글\n" });
  } finally {
    await t.cleanup();
  }
});

test("push .md: only body.markdown changes; envelope and links stay as the server has them", async () => {
  const t = await setup();
  try {
    await t.admin("POST", "/api/docs/voc", vocDoc("target", "# t\n"));
    await t.admin("POST", "/api/docs/voc", vocDoc("n", "# n\n", { links: [{ type: "voc", id: "target", rel: "related" }] }));
    await push({ ...t.base, type: "voc", id: "n", file: { kind: "md", markdown: "# n\n\n새 본문\n" } });
    const doc = (await t.admin("GET", "/api/docs/voc/n")).json().json;
    assert.deepEqual(doc.body, { name: "n", markdown: "# n\n\n새 본문\n" });
    assert.deepEqual(doc.links, [{ type: "voc", id: "target", rel: "related" }]);
    assert.deepEqual(doc.keywords, [{ kw: "n", inject: "pointer" }]);
    assert.equal(doc.status, "active");
  } finally {
    await t.cleanup();
  }
});

test("push .json: changed links go through PUT …/links; other envelope keys are reported as kept", async () => {
  const t = await setup();
  try {
    await t.admin("POST", "/api/docs/voc", vocDoc("target", "# t\n"));
    await t.admin("POST", "/api/docs/voc", vocDoc("n", "# n\n"));
    const file = vocDoc("n", "# n\n\n글\n", { links: [{ type: "voc", id: "target", rel: "related" }], status: "inactive" });
    const r = await push({ ...t.base, type: "voc", id: "n", file: { kind: "json", doc: file } });
    assert.deepEqual(r.kept, ["status"]);
    assert.ok(t.calls.some((c) => c.method === "PUT" && c.path === "/api/docs/voc/n/links"));
    const got = await t.admin("GET", "/api/docs/voc/n");
    assert.deepEqual(got.json().json.links, [{ type: "voc", id: "target", rel: "related" }]);
    assert.equal(got.json().json.status, "active");
    assert.equal(got.json().rev, r.rev);
  } finally {
    await t.cleanup();
  }
});

test("push: a stale --rev is 409 'sync 뒤 다시' and nothing is written", async () => {
  const t = await setup();
  try {
    const created = await t.admin("POST", "/api/docs/voc", vocDoc("n", "# n\n"));
    const rev0 = created.json().rev;
    await push({ ...t.base, type: "voc", id: "n", file: { kind: "md", markdown: "# n\n\n첫 수정\n" } });
    const err = await rejection(push({ ...t.base, type: "voc", id: "n", rev: rev0, file: { kind: "md", markdown: "# n\n\n옛 rev 위 수정\n" } }));
    assert.equal(err.status, 409);
    assert.match(err.message, /sync 뒤 다시/);
    const got = await t.admin("GET", "/api/docs/voc/n");
    assert.equal(got.json().json.body.markdown, "# n\n\n첫 수정\n");
  } finally {
    await t.cleanup();
  }
});

test("push: the server's validation error comes back as it said it", async () => {
  const t = await setup();
  try {
    const bad = vocDoc("bad", "# b\n");
    bad.body.extra = 1;
    const err = await rejection(push({ ...t.base, type: "voc", id: "bad", file: { kind: "json", doc: bad }, create: true }));
    assert.equal(err.status, 400);
    assert.equal(err.body.error, "validation_failed");
    assert.ok(err.body.details.length > 0);

    const unknown = await rejection(
      push({ ...t.base, type: "no-such", id: "x", file: { kind: "md", markdown: "# x\n" }, create: true }),
    );
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "unknown_type");
  } finally {
    await t.cleanup();
  }
});

test("checkPushFile: schema and id must match the target, an md file must have text", () => {
  const ok = { kind: "json", doc: vocDoc("n", "# n\n") };
  assert.deepEqual(checkPushFile({ type: "voc", id: "n", file: ok }), []);
  assert.equal(checkPushFile({ type: "voc", id: "m", file: ok }).length, 1);
  assert.equal(checkPushFile({ type: "manual", id: "n", file: ok }).length, 1);
  assert.equal(checkPushFile({ type: "voc", id: "n", file: { kind: "json", doc: [] } }).length, 1);
  assert.equal(checkPushFile({ type: "voc", id: "n", file: { kind: "md", markdown: " \n" } }).length, 1);
  assert.deepEqual(checkPushFile({ type: "voc", id: "n", file: { kind: "md", markdown: "# n\n" } }), []);
});
