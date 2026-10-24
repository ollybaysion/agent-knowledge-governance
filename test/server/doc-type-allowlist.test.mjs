// GET and DELETE /api/docs/:type/:id name a document only for a document type.
// Before, `DELETE /api/docs/score/<agent>` archived the score record: its
// array became {...array, status: "archived"} and every later POST /api/score
// was a 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

const auth = (token) => ({ authorization: `Bearer ${token}` });

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-doc-type-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  const skill = await app.inject({
    method: "POST",
    url: "/api/docs/domain-skill",
    headers: auth("aptok"),
    payload: {
      schema: "domain-skill/v1",
      id: "s",
      keywords: [{ kw: "s", inject: "full" }],
      status: "active",
      body: { name: "s", markdown: "# s\n\n## 도메인 지식\n\n### A\n\n글\n" },
    },
  });
  assert.equal(skill.statusCode, 201, skill.body);
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("score/<agent> is not a document: DELETE is 400, GET is 404, the record keeps working", async () => {
  const { app, cleanup } = await setup();
  const line = { kind: "data", text: "q", human: { score: 70 } };
  const posted = await app.inject({
    method: "POST",
    url: "/api/score/s",
    headers: auth("aptok"),
    payload: { lines: [line] },
  });
  assert.equal(posted.statusCode, 201, posted.body);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/docs/score/s",
    headers: auth("aptok"),
  });
  assert.equal(del.statusCode, 400);
  assert.deepEqual(del.json(), { error: "unknown_type" });

  const get = await app.inject({
    method: "GET",
    url: "/api/docs/score/s",
    headers: auth("aptok"),
  });
  assert.equal(get.statusCode, 404);
  assert.deepEqual(get.json(), { error: "not_found" });

  const record = await app.inject({ method: "GET", url: "/api/score/s", headers: auth("aptok") });
  assert.equal(record.statusCode, 200);
  assert.equal(record.json().lines.length, 1);

  const again = await app.inject({
    method: "POST",
    url: "/api/score/s",
    headers: auth("aptok"),
    payload: { lines: [line] },
  });
  assert.equal(again.statusCode, 201, again.body);
  await cleanup();
});

test("a document type still answers GET and DELETE", async () => {
  const { app, cleanup } = await setup();
  const get = await app.inject({ method: "GET", url: "/api/docs/domain-skill/s", headers: auth("aptok") });
  assert.equal(get.statusCode, 200);
  const del = await app.inject({ method: "DELETE", url: "/api/docs/domain-skill/s", headers: auth("aptok") });
  assert.equal(del.statusCode, 200, del.body);
  await cleanup();
});
