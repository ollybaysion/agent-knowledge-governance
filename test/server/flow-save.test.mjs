// An agent md's save goes through the consumer's flow check against the
// store's active agent mds: the doc's own flow errors refuse it, the other mds
// it breaks come back as flowWarnings, and a draft waits for its activation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "flow");
const fixture = (rel) => readFileSync(join(FIXTURES, rel), "utf8");

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-flow-save-"));
  const signedIn = await signIn(home, [
    { id: "ed", group: "admin", token: "flow-ed" },
    { id: "bot", group: "agent", token: "flow-bot" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth: signedIn });
  const call = (token, method, url, payload, headers = {}) => app.inject({ method, url, headers: { ...as(token), ...headers }, payload });
  return {
    app,
    storeDir,
    admin: (...a) => call("flow-ed", ...a),
    agent: (...a) => call("flow-bot", ...a),
    revOf: async (type, id) => (await call("flow-ed", "GET", `/api/docs/${type}/${id}`)).json().rev,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const skill = (id, markdown, status = "active") => ({
  schema: "domain-skill/v1",
  id,
  keywords: [{ kw: id, inject: "full" }],
  status,
  body: { name: id, markdown },
});

test("POST: an active agent md with a flow error is 400 flow_rejected with code · line · text, and nothing is stored; a draft is stored", async () => {
  const t = await setup();
  try {
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("eqp-scope", fixture("skills/eqp-scope.md")))).statusCode, 201);
    const spec = fixture("subgraph/param-spec.md");
    const r = await t.admin("POST", "/api/docs/domain-skill", skill("param-spec", spec));
    assert.equal(r.statusCode, 400, r.body);
    const body = r.json();
    assert.equal(body.error, "flow_rejected");
    assert.equal(body.fenceLine, 13);
    assert.deepEqual(body.errors.map((e) => [e.line, e.code]), [[0, "UNKNOWN_ID"], [0, "UNSOURCED_VAR"]]);
    assert.equal(body.errors[0].message, "흐름 노드 param_pick: 등재된 md 이름도, 등재된 subgraph id 도 아니다");
    assert.deepEqual(body.details, body.errors.map((e) => `$.body.markdown: 플로우 오류 ${e.code} ${e.message}`));
    assert.equal((await t.admin("GET", "/api/docs/domain-skill/param-spec")).statusCode, 404);

    // a draft is no registered md: it waits for its activation, which runs the check
    const draft = await t.admin("POST", "/api/docs/domain-skill", skill("param-spec", spec, "inactive"));
    assert.equal(draft.statusCode, 201, draft.body);
    const on = await t.admin("POST", "/api/docs/domain-skill/param-spec/activate", null, { "if-match": draft.json().rev });
    assert.equal(on.statusCode, 400, on.body);
    assert.equal(on.json().error, "flow_rejected");

    // with the md that holds the subgraph registered, it activates
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("param-interlock", fixture("subgraph/param-interlock.md")))).statusCode, 201);
    const again = await t.admin("POST", "/api/docs/domain-skill/param-spec/activate", null, { "if-match": await t.revOf("domain-skill", "param-spec") });
    assert.equal(again.statusCode, 200, again.body);
    assert.equal(again.json().flowWarnings, undefined);
  } finally {
    await t.cleanup();
  }
});

test("PUT: a save that breaks another agent md is stored and names it in flowWarnings; deactivate and delete name it too", async () => {
  const t = await setup();
  try {
    for (const [id, rel] of [["eqp-scope", "skills/eqp-scope.md"], ["param-interlock", "subgraph/param-interlock.md"], ["param-spec", "subgraph/param-spec.md"]])
      assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill(id, fixture(rel)))).statusCode, 201, id);
    const owner = fixture("subgraph/param-interlock.md");
    const flat = owner
      .replace("  subgraph param_pick [파라미터 고르기]\n", "")
      .replace("  end\n", "")
      .replace("  param_pick --> interlock_history", "  eqp-scope --> interlock_history");
    const r = await t.admin("PUT", "/api/docs/domain-skill/param-interlock", { name: "param-interlock", markdown: flat }, { "if-match": await t.revOf("domain-skill", "param-interlock") });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().flowWarnings.map((w) => [w.md, w.errors[0].code]), [["param-spec", "UNKNOWN_ID"]]);

    // put it back: nothing is broken
    const back = await t.admin("PUT", "/api/docs/domain-skill/param-interlock", { name: "param-interlock", markdown: owner }, { "if-match": await t.revOf("domain-skill", "param-interlock") });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(back.json().flowWarnings, undefined);

    const off = await t.admin("POST", "/api/docs/domain-skill/param-interlock/deactivate", null, { "if-match": await t.revOf("domain-skill", "param-interlock") });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual(off.json().flowWarnings.map((w) => w.md), ["param-spec"]);
    const on = await t.admin("POST", "/api/docs/domain-skill/param-interlock/activate", null, { "if-match": await t.revOf("domain-skill", "param-interlock") });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().flowWarnings, undefined);
    const del = await t.admin("DELETE", "/api/docs/domain-skill/param-interlock", null, { "if-match": await t.revOf("domain-skill", "param-interlock") });
    assert.equal(del.statusCode, 200, del.body);
    assert.deepEqual(del.json().flowWarnings.map((w) => w.md), ["param-spec"]);
  } finally {
    await t.cleanup();
  }
});

test("the agent's writes go through the same check; an ASK item is refused in BE's words", async () => {
  const t = await setup();
  try {
    const bad = "# x\n\n## 데이터\n\n```mermaid\nflowchart TD\n  q --> nowhere\n```\n\n### q — 조회\n\n```sql\nSELECT a FROM t\n```\n";
    const r = await t.agent("POST", "/api/docs/domain-skill", skill("x", bad));
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().error, "flow_rejected");
    assert.deepEqual(r.json().errors.map((e) => e.code), ["UNKNOWN_ID"]);

    const ask = "# y\n\n## 데이터\n\n### operator — 담당자\n\n```ask\n담당자?\n```\n";
    const a = await t.agent("POST", "/api/docs/domain-skill", skill("y", ask));
    assert.equal(a.statusCode, 400, a.body);
    assert.deepEqual(a.json(), {
      error: "validation_failed",
      details: ["$.body.markdown: y needs[operator]: ask 펜스는 쓰지 않는다 — 입력은 흐름 펜스의 `id([글])` 노드로 적는다"],
    });

    const ok = bad.replace("  q --> nowhere", "  q[조회]");
    const made = await t.agent("POST", "/api/docs/domain-skill", skill("x", ok));
    assert.equal(made.statusCode, 201, made.body);
    const edit = await t.agent("PUT", "/api/docs/domain-skill/x", { name: "x", markdown: bad }, { "if-match": made.json().rev });
    assert.equal(edit.statusCode, 400, edit.body);
    assert.equal(edit.json().error, "flow_rejected");
  } finally {
    await t.cleanup();
  }
});

test("an md with two ## 데이터 sections is 400 validation_failed in BE's words, with each heading's line", async () => {
  const t = await setup();
  try {
    const item = "\n\n```sql\nselect a from t\n```\n\n";
    const two = `# two\n\n## 데이터\n\n### a — 하나${item}## 데이터\n\n### b — 둘${item}`;
    const r = await t.agent("POST", "/api/docs/domain-skill", skill("two", two));
    assert.equal(r.statusCode, 400, r.body);
    assert.deepEqual(r.json(), {
      error: "validation_failed",
      details: ["$.body.markdown: two: ## 데이터 절은 하나다, 2 개다 — 3 · 11 번째 줄"],
    });
  } finally {
    await t.cleanup();
  }
});

test("the 데이터 section keeps its flow fence and its queries, in order, through save · md · SKILL.md", async () => {
  const t = await setup();
  try {
    const md = fixture("subgraph/state-gate.md");
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("eqp-scope", fixture("skills/eqp-scope.md")))).statusCode, 201);
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("state-gate", md))).statusCode, 201);
    const got = (await t.admin("GET", "/api/docs/domain-skill/state-gate")).json();
    assert.equal(got.json.body.markdown, md);
    const rendered = (await t.admin("GET", "/api/docs/domain-skill/state-gate?format=md")).body;
    const data = rendered.slice(rendered.indexOf("## 데이터"));
    assert.ok(data.indexOf("```mermaid") < data.indexOf("### eqp_state") && data.indexOf("### eqp_state") < data.indexOf("### alarm_list"), data);
    assert.ok(rendered.endsWith(md.slice(md.indexOf("## 데이터"))), rendered);
  } finally {
    await t.cleanup();
  }
});

test("GET /api/flow-facts: the active agent mds, for the editor's check", async () => {
  const t = await setup();
  try {
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("eqp-scope", fixture("skills/eqp-scope.md")))).statusCode, 201);
    assert.equal((await t.admin("POST", "/api/docs/domain-skill", skill("param-spec", fixture("subgraph/param-spec.md"), "inactive"))).statusCode, 201);
    const r = await t.agent("GET", "/api/flow-facts");
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().mds, [{ type: "domain-skill", id: "eqp-scope", markdown: fixture("skills/eqp-scope.md") }]);
  } finally {
    await t.cleanup();
  }
});
