import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-score-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "scorer", role: "agent", tokenHash: hashToken("agtok") },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), usersPath: join(home, "users.json") });
  const r = await app.inject({
    method: "POST",
    url: "/api/docs/domain-skill",
    headers: { authorization: "Bearer edtok" },
    payload: { schema: "domain-skill/v1", id: "s", keywords: [{ kw: "s", inject: "full" }], status: "active", body: { name: "s", markdown: "# s\n\n## 도메인 지식\n\n### A\n\n글\n" } },
  });
  assert.equal(r.statusCode, 201, r.body);
  return { app, storeDir: join(home, "store"), cleanup: async () => { await app.close(); rmSync(home, { recursive: true, force: true }); } };
}

const machine = (text, at, ok = true) => ({
  at,
  kind: "general",
  text,
  model: "mock",
  mdRev: "md1",
  machine: { ok, reason: ok ? null : "검색 놓침", detail: null, pieces: ["s/A"] },
  run: {
    G: 0.5, A: 0.25, R: null, score: 35, band: "기본적인 질의응답 가능",
    general: { m: 1, n: 2 }, data: { m: 0, n: 0 }, relation: { m: 0, n: 0 }, reliability: { m: 0, n: 0 },
    pieces: { count: 12, level: 1 }, queries: { count: 3, level: 1 },
  },
});

test("score: the scorer appends machine lines, one commit per write, and GET reads them back with since", async () => {
  const { app, storeDir, cleanup } = await setup();
  const post = (token, lines) =>
    app.inject({ method: "POST", url: "/api/score/s", headers: { authorization: `Bearer ${token}` }, payload: { lines } });
  try {
    const first = await post("agtok", [machine("q1", "2026-10-14T19:30:05"), machine("q2", "2026-10-14T19:30:05", false)]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().added, 2);
    assert.equal((await post("agtok", [machine("q1", "2026-10-14T20:00:00")])).statusCode, 201);
    const log = execFileSync("git", ["-C", storeDir, "log", "-2", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(log, ["scorer|score s: 기계 판정 1줄", "scorer|score s: 기계 판정 2줄"]);

    const all = (await app.inject({ method: "GET", url: "/api/score/s" })).json();
    assert.equal(all.lines.length, 3);
    assert.deepEqual(all.lines[1], { ...machine("q2", "2026-10-14T19:30:05", false), agent: "s" });
    const since = (await app.inject({ method: "GET", url: "/api/score/s?since=2026-10-14T19:45:00" })).json();
    assert.deepEqual(since.lines.map((l) => l.at), ["2026-10-14T20:00:00"]);
  } finally {
    await cleanup();
  }
});

test("score: a person's score takes by and at from the request; the scorer cannot write one", async () => {
  const { app, cleanup } = await setup();
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/score/s",
      headers: { authorization: "Bearer edtok" },
      payload: { lines: [{ kind: "data", text: "q", human: { score: 70, by: "someone-else", at: "2000-01-01T00:00:00" } }] },
    });
    assert.equal(r.statusCode, 201, r.body);
    const [line] = (await app.inject({ method: "GET", url: "/api/score/s" })).json().lines;
    assert.equal(line.human.score, 70);
    assert.equal(line.human.by, "renoir");
    assert.match(line.human.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.notEqual(line.human.at, "2000-01-01T00:00:00");

    const byAgent = await app.inject({
      method: "POST",
      url: "/api/score/s",
      headers: { authorization: "Bearer agtok" },
      payload: { lines: [{ kind: "data", text: "q", human: { score: 70 } }] },
    });
    assert.equal(byAgent.statusCode, 400);
    assert.match(byAgent.json().rejected[0].errors[0], /사람 계정만/);
  } finally {
    await cleanup();
  }
});

test("score: malformed lines are refused whole, an unknown agent is 404, a viewer cannot write", async () => {
  const { app, cleanup } = await setup();
  const post = (lines, url = "/api/score/s", token = "agtok") =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: { lines } });
  try {
    const bad = await post([machine("q1", "2026-10-14T19:30:05"), { ...machine("q", "2026-10-14T19:30:05"), kind: "모르는 종류" }, { ...machine("q", "어제") }]);
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json().rejected.map((r) => r.index), [1, 2]);
    assert.equal((await app.inject({ method: "GET", url: "/api/score/s" })).json().lines.length, 0);
    assert.equal((await post([{ kind: "general", text: "q", human: { score: 101 } }], "/api/score/s", "edtok")).statusCode, 400);
    assert.equal((await post([{ kind: "general", text: "q", machine: { ok: true } }])).statusCode, 400, "a machine line needs run · model · mdRev");
    assert.equal((await post([])).statusCode, 400);
    assert.equal((await post([machine("q", "2026-10-14T19:30:05")], "/api/score/nope")).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/score/s", payload: { lines: [] } })).statusCode, 401);
  } finally {
    await cleanup();
  }
});

test("score: the score-record and verification-set schemas are served; neither is a document type", async () => {
  const { app, cleanup } = await setup();
  try {
    for (const name of ["score-record", "verification-set"]) {
      const r = await app.inject({ method: "GET", url: `/api/schemas/${name}` });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().$id, `${name}/v1`);
    }
    const asDoc = await app.inject({
      method: "POST",
      url: "/api/docs/verification-set",
      headers: { authorization: "Bearer edtok" },
      payload: { schema: "verification-set/v1", id: "x", keywords: [{ kw: "x", inject: "full" }], status: "inactive", body: {} },
    });
    assert.equal(asDoc.json().error, "unknown_type");
  } finally {
    await cleanup();
  }
});

test("verification set: GET …/verification-set is the section as the contract object; 404 without the section", async () => {
  const { app, cleanup } = await setup();
  const h = { authorization: "Bearer edtok" };
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/docs/domain-skill/s/verification-set" })).json().error, "no_verification_set");
    const { rev } = (await app.inject({ method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const md = "# s\n\n## 도메인 지식\n\n### A\n\n글\n\n## 답변 품질 검증 Set\n\n### 설정\n\n- 라인: L1\n- 설비: E1\n\n### 일반 지식\n\n#### q\n\n- 정답: A\n\n### 데이터 설명\n\n#### r\n\n```sql\nSELECT 1\n```\n\n### 신뢰성\n\n#### t\n";
    const put = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s", headers: { ...h, "if-match": rev }, payload: { name: "s", markdown: md } });
    assert.equal(put.statusCode, 200, put.body);
    const r = await app.inject({ method: "GET", url: "/api/docs/domain-skill/s/verification-set" });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), {
      agent: "s",
      rev: put.json().rev,
      settings: { line: "L1", eqp: "E1" },
      questions: [
        { kind: "general", text: "q", answer: { path: "A" } },
        { kind: "data", text: "r", sql: ["SELECT 1"] },
        { kind: "reliability", text: "t" },
      ],
      warnings: [],
    });
  } finally {
    await cleanup();
  }
});
