// Phase 1 acceptance (design §9.2 row "1. 서버+대시보드"), one test per
// criterion, worded to match the row verbatim:
//   1. 두 계정 동시 편집: 겹치는 슬롯 → 409, 안 겹치면 자동 재베이스 (S6)
//   2. agent 토큰 promote → 403
//   3. promote If-Match 불일치 → 409 (S4)
//   4. users.json 없이 기동 → 거부 (S1)
//   5. 감사 뷰 == git log
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp, AuthBootError } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { git } from "../../server/git.mjs";

async function setup(users) {
  const home = mkdtempSync(join(tmpdir(), "akg-acceptance-"));
  saveUsers(join(home, "users.json"), users);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    storeDir: join(home, "store"),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function newDoc() {
  return {
    schema: "db-schema/v1",
    id: "t.x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: "X",
      catalog: {
        columns: [
          { name: "A", type: "NUMBER", nullable: false },
          { name: "B", type: "VARCHAR2(1)", nullable: true },
        ],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {
        A: { text: null, tier: "scaffold" },
        B: { text: null, tier: "scaffold" },
      },
    },
  };
}

test("1. 두 계정 동시 편집 — 겹치는 슬롯은 409, 겹치지 않으면 자동 재베이스 (S6)", async () => {
  const { app, cleanup } = await setup([
    { id: "alice", role: "editor", tokenHash: hashToken("alice-tok") },
    { id: "bob", role: "editor", tokenHash: hashToken("bob-tok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("alice-tok"),
    payload: newDoc(),
  });
  const rev0 = created.json().rev;

  // Alice and Bob both start editing from rev0, touching DIFFERENT columns.
  const aliceBody = newDoc().body;
  aliceBody.columnDescs.A = {
    text: "Alice의 설명",
    tier: "confirmed",
    evidence: ["a:1"],
  };
  const aliceWrite = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("alice-tok"), "if-match": rev0 },
    payload: aliceBody,
  });
  assert.equal(aliceWrite.statusCode, 200, "alice's write lands first");

  const bobBodyNoOverlap = newDoc().body;
  bobBodyNoOverlap.columnDescs.B = {
    text: "Bob의 설명",
    tier: "confirmed",
    evidence: ["b:1"],
  };
  const bobRebase = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("bob-tok"), "if-match": rev0 }, // still bob's stale rev0
    payload: bobBodyNoOverlap,
  });
  assert.equal(
    bobRebase.statusCode,
    200,
    "non-overlapping edit auto-rebases instead of failing",
  );
  assert.equal(bobRebase.json().rebased, true);
  assert.equal(
    bobRebase.json().json.body.columnDescs.A.text,
    "Alice의 설명",
    "alice's change survives the rebase",
  );
  assert.equal(bobRebase.json().json.body.columnDescs.B.text, "Bob의 설명");

  // Now Bob tries to edit column A too, against his now-also-stale rev0 — overlapping this time.
  const bobBodyOverlap = newDoc().body;
  bobBodyOverlap.columnDescs.A = {
    text: "Bob이 덮어쓰려는 값",
    tier: "confirmed",
    evidence: ["b:2"],
  };
  const bobConflict = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("bob-tok"), "if-match": rev0 },
    payload: bobBodyOverlap,
  });
  assert.equal(
    bobConflict.statusCode,
    409,
    "overlapping edit is rejected, not silently merged",
  );
  assert.deepEqual(bobConflict.json().overlap, ["columnDescs.A"]);

  await cleanup();
});

test("2. agent 토큰으로 promote 시도 → 403", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "agent:catalog-push", role: "agent", tokenHash: hashToken("agtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDoc(),
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: { ...auth("agtok"), "if-match": created.json().rev },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  await cleanup();
});

test("3. promote 시 If-Match 불일치 → 409 (S4)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "boss", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDoc(),
  });
  const stalePromote = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema/t.x/promote",
    headers: {
      ...auth("aptok"),
      "if-match": "0000000000000000000000000000000000000000",
    },
    payload: {},
  });
  assert.equal(stalePromote.statusCode, 409);
  await cleanup();
});

test("4. users.json 없이 기동 → 거부 (S1)", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-acceptance-noauth-"));
  await assert.rejects(
    buildApp({
      storeDir: join(home, "store"),
      usersPath: join(home, "users.json"),
    }),
    AuthBootError,
  );
  rmSync(home, { recursive: true, force: true });
});

test("5. 감사 뷰 == git log — API 응답이 store 레포의 실제 git log와 정확히 일치", async () => {
  const { app, storeDir, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDoc(),
  });
  await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/t.x",
    headers: { ...auth("edtok"), "if-match": created.json().rev },
    payload: (() => {
      const b = newDoc().body;
      b.purpose = { text: "목적", tier: "confirmed", evidence: ["p:1"] };
      return b;
    })(),
  });

  const audit = await app.inject({
    method: "GET",
    url: "/api/audit",
    headers: auth("edtok"),
  });
  const apiEntries = audit.json().entries;

  const rawLog = git(storeDir, ["log", "--format=%H\x1f%an\x1f%aI\x1f%s"]);
  const gitEntries = rawLog
    .trim()
    .split("\n")
    .map((line) => {
      const [rev, author, at, message] = line.split("\x1f");
      return { rev, author, at, message };
    });

  assert.deepEqual(apiEntries, gitEntries);
  await cleanup();
});
