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

const machine = (question, at, answered = true) => ({
  at,
  kind: "일반 지식",
  question,
  model: "mock",
  mdRev: "md1",
  machine: { answered, reason: answered ? null : "검색 놓침", detail: null, pieces: ["s/A"] },
  score: { g: 0.5, a: 0.25, percent: 35, band: "기본적인 질의응답 가능" },
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
    assert.deepEqual(all.lines[1], { at: "2026-10-14T19:30:05", agent: "s", ...machine("q2", "2026-10-14T19:30:05", false) });
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
      payload: { lines: [{ kind: "데이터 설명", question: "q", human: { score: 70, by: "someone-else", at: "2000-01-01T00:00:00" } }] },
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
      payload: { lines: [{ kind: "데이터 설명", question: "q", human: { score: 70 } }] },
    });
    assert.equal(byAgent.statusCode, 400);
    assert.match(byAgent.json().rejected[0].error, /사람 계정만/);
  } finally {
    await cleanup();
  }
});

test("score: malformed lines are refused whole, an unknown agent is 404, a viewer cannot write", async () => {
  const { app, cleanup } = await setup();
  const post = (lines, url = "/api/score/s", token = "agtok") =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: { lines } });
  try {
    const bad = await post([machine("q1", "2026-10-14T19:30:05"), { kind: "모르는 종류", question: "q" }, { ...machine("q", "어제") }]);
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json().rejected.map((r) => r.index), [1, 2]);
    assert.equal((await app.inject({ method: "GET", url: "/api/score/s" })).json().lines.length, 0);
    assert.equal((await post([{ kind: "일반 지식", question: "q", human: { score: 101 } }], "/api/score/s", "edtok")).statusCode, 400);
    assert.equal((await post([])).statusCode, 400);
    assert.equal((await post([machine("q", "2026-10-14T19:30:05")], "/api/score/nope")).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/score/s", payload: { lines: [] } })).statusCode, 401);
  } finally {
    await cleanup();
  }
});
