import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-score-test-"));
  const signedIn = await signIn(home, [
    { id: "renoir", group: "admin", token: "edtok" },
    { id: "scorer", group: "agent", token: "agtok" },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), auth: signedIn });
  const r = await app.inject({
    method: "POST",
    url: "/api/docs/domain-skill",
    headers: as("edtok"),
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
    G: 0.5, A: 0.25, R: null, score: 35, band: "기본적인 질의응답 가능", raw: 35.36, humanRatio: 0.5, gate: 0.5,
    general: { m: 1, n: 2 }, data: { m: 0, n: 0 }, relation: { m: 0, n: 0 }, reliability: { m: 0, n: 0 },
    pieces: { count: 12, level: 1 }, queries: { count: 3, level: 1 },
  },
});

test("score: the scorer appends machine lines, one commit per write, and GET reads them back with since", async () => {
  const { app, storeDir, cleanup } = await setup();
  const post = (token, lines) =>
    app.inject({ method: "POST", url: "/api/score/s", headers: as(token), payload: { lines } });
  try {
    const first = await post("agtok", [machine("q1", "2026-10-14T19:30:05"), machine("q2", "2026-10-14T19:30:05", false)]);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(first.json().added, 2);
    assert.equal((await post("agtok", [machine("q1", "2026-10-14T20:00:00")])).statusCode, 201);
    const log = execFileSync("git", ["-C", storeDir, "log", "-2", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(log, ["scorer|score s: 기계 판정 1줄", "scorer|score s: 기계 판정 2줄"]);

    const all = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/score/s" })).json();
    assert.equal(all.lines.length, 3);
    assert.deepEqual(all.lines[1], { ...machine("q2", "2026-10-14T19:30:05", false), agent: "s" });
    const since = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/score/s?since=2026-10-14T19:45:00" })).json();
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
      headers: as("edtok"),
      payload: { lines: [{ kind: "data", text: "q", human: { score: 70, by: "someone-else", at: "2000-01-01T00:00:00" } }] },
    });
    assert.equal(r.statusCode, 201, r.body);
    const [line] = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/score/s" })).json().lines;
    assert.equal(line.human.score, 70);
    assert.equal(line.human.by, "renoir");
    assert.match(line.human.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    assert.notEqual(line.human.at, "2000-01-01T00:00:00");

    const byAgent = await app.inject({
      method: "POST",
      url: "/api/score/s",
      headers: as("agtok"),
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
    app.inject({ method: "POST", url, headers: as(token), payload: { lines } });
  try {
    const bad = await post([machine("q1", "2026-10-14T19:30:05"), { ...machine("q", "2026-10-14T19:30:05"), kind: "모르는 종류" }, { ...machine("q", "어제") }]);
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json().rejected.map((r) => r.index), [1, 2]);
    assert.equal((await app.inject({ headers: as("reader"), method: "GET", url: "/api/score/s" })).json().lines.length, 0);
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
      const r = await app.inject({ headers: as("reader"), method: "GET", url: `/api/schemas/${name}` });
      assert.equal(r.statusCode, 200);
      assert.equal(r.json().$id, `${name}/v1`);
    }
    const asDoc = await app.inject({
      method: "POST",
      url: "/api/docs/verification-set",
      headers: as("edtok"),
      payload: { schema: "verification-set/v1", id: "x", keywords: [{ kw: "x", inject: "full" }], status: "inactive", body: {} },
    });
    assert.equal(asDoc.json().error, "unknown_type");
  } finally {
    await cleanup();
  }
});

test("verification set: GET …/verification-set is the section as the contract object; 404 without the section", async () => {
  const { app, cleanup } = await setup();
  const h = as("edtok");
  try {
    assert.equal((await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-set" })).json().error, "no_verification_set");
    const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const md = "# s\n\n## 도메인 지식\n\n### A\n\n글\n\n## 답변 품질 검증 Set\n\n### 설정\n\n- 라인: L1\n- 설비: E1\n\n### 일반 지식\n\n#### q\n\n- 정답: A\n\n### 데이터 설명\n\n#### r\n\n```sql\nSELECT 1\n```\n\n### 신뢰성\n\n#### t\n";
    const put = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s", headers: { ...h, "if-match": rev }, payload: { name: "s", markdown: md } });
    assert.equal(put.statusCode, 200, put.body);
    const r = await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-set" });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), {
      agent: "s",
      rev: put.json().rev,
      settings: { line: "L1", eqp: "E1" },
      questions: [
        { kind: "general", text: "q", answer: { path: "s/A" } },
        { kind: "data", text: "r", sql: ["SELECT 1"] },
        { kind: "reliability", text: "t" },
      ],
      warnings: [],
    });
  } finally {
    await cleanup();
  }
});

test("verification set: PUT …/verification-set writes the section from the contract object in one commit; GET reads it back", async () => {
  const { app, storeDir, cleanup } = await setup();
  const h = as("edtok");
  try {
    const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const set = {
      settings: { line: "L1", eqp: "E1", duration: { start: "2026-10-01T00:00", end: "2026-10-01T06:00" } },
      questions: [
        { kind: "general", text: "q", answer: { path: "s/A" }, rubric: "글" },
        { kind: "data", text: "r", sql: ["SELECT a FROM t WHERE id = 'S-1'"] },
        { kind: "relation", text: "u", sql: ["SELECT 1 FROM dual", "SELECT 2 FROM dual"], rubric: "둘을 잇는다" },
        { kind: "advanced", text: "v", deferred: true },
        { kind: "reliability", text: "w" },
      ],
    };
    const put = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s/verification-set", headers: { ...h, "if-match": rev }, payload: set });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json(), { agent: "s", rev: put.json().rev, ...set, warnings: [] });
    assert.notEqual(put.json().rev, rev);
    const log = execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).trim();
    assert.equal(log, "renoir|verification-set domain-skill/s");

    const got = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-set" })).json();
    assert.deepEqual(got, put.json());
    const md = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json().json.body.markdown;
    assert.match(md, /## 도메인 지식\n\n### A\n\n글\n\n## 답변 품질 검증 Set\n\n### 설정\n\n- 라인: L1/);

    // The object GET gave, edited, goes back as it is: its own rev is the base.
    const edited = { ...got, questions: got.questions.filter((q) => q.kind !== "advanced") };
    const again = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s/verification-set", headers: h, payload: edited });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().questions.length, 4);
  } finally {
    await cleanup();
  }
});

test("verification set: PUT refuses a stale or missing rev, a bad shape, a rule break, a sub skill and a non-editor", async () => {
  const { app, cleanup } = await setup();
  const h = as("edtok");
  const put = (headers, payload) => app.inject({ method: "PUT", url: "/api/docs/domain-skill/s/verification-set", headers, payload });
  try {
    const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const ok = { questions: [{ kind: "reliability", text: "w" }] };
    assert.equal((await put(h, ok)).statusCode, 428);
    assert.equal((await put({ ...h, "if-match": "0".repeat(40) }, ok)).json().error, "unknown_base_rev");
    const shape = await put({ ...h, "if-match": rev }, { questions: [{ kind: "nope", text: "w" }] });
    assert.equal(shape.statusCode, 400);
    assert.equal(shape.json().error, "invalid_body");
    assert.equal((await put({ ...h, "if-match": rev }, { ...ok, agent: "other" })).json().error, "agent_mismatch");
    const rule = await put({ ...h, "if-match": rev }, { questions: [{ kind: "data", text: "r", sql: ["SELECT 1", "SELECT 2"] }] });
    assert.equal(rule.statusCode, 422, rule.body);
    assert.equal(rule.json().error, "invalid_verification_set");
    assert.equal((await put({ ...as("agtok"), "if-match": rev }, ok)).statusCode, 403);
    assert.equal((await put({ "if-match": rev }, ok)).statusCode, 401);

    const role = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s/role", headers: { ...h, "if-match": rev }, payload: { role: "sub" } });
    assert.equal(role.statusCode, 200, role.body);
    assert.equal((await put({ ...h, "if-match": role.json().rev }, ok)).json().error, "not_main");
  } finally {
    await cleanup();
  }
});

test("verification queries: this skill's queries then each active linked skill's, with where each bind's value comes from", async () => {
  const { app, cleanup } = await setup();
  const h = as("edtok");
  const skill = (id, markdown, extra = {}) =>
    app.inject({
      method: "POST",
      url: "/api/docs/domain-skill",
      headers: h,
      payload: { schema: "domain-skill/v1", id, keywords: [{ kw: id, inject: "full" }], status: "active", body: { name: id, markdown }, ...extra },
    });
  try {
    const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const own = [
      "# s", "", "## 도메인 지식", "", "### A", "", "글", "", "## 데이터", "",
      "```mermaid", "flowchart TD", "  snsr_id([어느 센서인가요? 예: S-0004])", "  eqp_id([설비])", "  duration([기간])",
      "  snsr_id --> row", "  eqp_id --> row", "  duration --> row", "```", "",
      "### row — 센서 행", "", "```sql", "SELECT a FROM t", " WHERE id = :snsr_id AND eqp = :EQP_ID", "   AND d BETWEEN :start_time AND :end_time", "```", "",
    ].join("\n");
    assert.equal((await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s", headers: { ...h, "if-match": rev }, payload: { name: "s", markdown: own } })).statusCode, 200);
    const linkTo = { links: [{ type: "domain-skill", id: "s", rel: "related" }] };
    // snsr_id comes from s, the flow that leads: its input node names the bind.
    const sub = "# sub\n\n## 도메인 지식\n\n### X\n\n글\n\n## 데이터\n\n```mermaid\nflowchart TD\n  s[[센서 스킬]]\n  kind([종류 예: A])\n  s --> msg\n  kind --> msg\n```\n\n### msg — 메시지\n\n```sql\nSELECT v FROM m WHERE id = :snsr_id AND k = :kind\n```\n";
    const made = await skill("sub", sub, { role: "sub", ...linkTo });
    assert.equal(made.statusCode, 201, made.body);
    assert.equal((await skill("off", "# off\n\n## 도메인 지식\n\n### X\n\n글\n\n## 데이터\n\n### gone — 꺼짐\n\n```sql\nSELECT 1 FROM dual\n```\n", { ...linkTo, status: "inactive" })).statusCode, 201);
    assert.equal((await skill("far", "# far\n\n## 도메인 지식\n\n### X\n\n글\n\n## 데이터\n\n### far_q — 먼 조회\n\n```sql\nSELECT 1 FROM dual\n```\n")).statusCode, 201);

    const r = await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-choices" });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().queries, [
      {
        skill: "s", id: "row", title: "센서 행",
        sql: "SELECT a FROM t\n WHERE id = :snsr_id AND eqp = :EQP_ID\n   AND d BETWEEN :start_time AND :end_time",
        binds: [
          { name: "snsr_id", from: "input", title: "어느 센서인가요? 예: S-0004", example: "S-0004" },
          { name: "EQP_ID", from: "eqp" },
          { name: "start_time", from: "start" },
          { name: "end_time", from: "end" },
        ],
      },
      {
        skill: "sub", id: "msg", title: "메시지",
        sql: "SELECT v FROM m WHERE id = :snsr_id AND k = :kind",
        binds: [
          { name: "snsr_id", from: "input", title: "어느 센서인가요? 예: S-0004", example: "S-0004" },
          { name: "kind", from: "input", title: "종류 예: A", example: "A" },
        ],
      },
    ]);
    assert.equal((await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/none/verification-choices" })).statusCode, 404);

    // 일반 지식: own, LINK1 (sub), LINK2 (deep, linked to sub) — far and the inactive one are out of reach.
    const deep = await skill("deep", "# deep\n\n## 도메인 지식\n\n### D\n\n글\n", { role: "sub", links: [{ type: "domain-skill", id: "sub", rel: "related" }] });
    assert.equal(deep.statusCode, 201, deep.body);
    const pieces = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-choices" })).json().pieces;
    assert.deepEqual(pieces, [
      { skill: "s", tier: "own", paths: ["A"] },
      { skill: "sub", tier: "link1", paths: ["X"] },
      { skill: "deep", tier: "link2", paths: ["D"] },
    ]);
    const { rev: sRev } = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s" })).json();
    const set = {
      questions: ["s/A", "sub/X", "deep/D", "far/X"].map((path, i) => ({ kind: "general", text: `q${i}`, answer: { path } })),
    };
    const put = await app.inject({ method: "PUT", url: "/api/docs/domain-skill/s/verification-set", headers: { ...h, "if-match": sRev }, payload: set });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().warnings.length, 1);
    assert.match(put.json().warnings[0], /#### q3": .* — far\/X/);
  } finally {
    await cleanup();
  }
});

test("verification-choices: a domain document a main links to is LINK1, one it links to is LINK2, as a sub skill would be", async () => {
  const { app, cleanup } = await setup();
  const h = as("edtok");
  const post = (type, id, markdown, extra = {}) =>
    app.inject({
      method: "POST",
      url: `/api/docs/${type}`,
      headers: h,
      payload: { schema: `${type}/v1`, id, keywords: [{ kw: id, inject: "full" }], status: "active", body: { name: id, markdown }, ...extra },
    });
  try {
    const near = await post("domain", "near", "# near\n\n## 도메인 지식\n\n### DB\n\n#### PARAM_INFO\n\n글\n\n## 데이터\n\n### p — 파라미터\n\n```sql\nSELECT 1 FROM p\n```\n", { links: [{ type: "domain-skill", id: "s", rel: "related" }] });
    assert.equal(near.statusCode, 201, near.body);
    const deep = await post("domain", "deep", "# deep\n\n## 도메인 지식\n\n### D\n\n글\n", { links: [{ type: "domain", id: "near", rel: "related" }] });
    assert.equal(deep.statusCode, 201, deep.body);
    const r = (await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/s/verification-choices" })).json();
    assert.deepEqual(r.pieces, [
      { skill: "s", tier: "own", paths: ["A"] },
      { skill: "near", tier: "link1", paths: ["DB / PARAM_INFO"] },
      { skill: "deep", tier: "link2", paths: ["D"] },
    ]);
    assert.deepEqual(r.queries.map((q) => `${q.skill}/${q.id}`), ["near/p"]);
  } finally {
    await cleanup();
  }
});
