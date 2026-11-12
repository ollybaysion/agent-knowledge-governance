// The starter type (첫 선택 데이터) through the routes: write · render · list ·
// doc view, the query ids it shares with domain-skill and domain, the four
// save warnings, and the info-bind warning on an agent md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const EXAMPLES = new URL("../../examples/", import.meta.url);
const example = (p) => JSON.parse(readFileSync(new URL(p, EXAMPLES), "utf8"));
const FLOW = new URL("../fixtures/flow/", import.meta.url);
const flowMd = (p) => readFileSync(new URL(p, FLOW), "utf8");

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-starter-"));
  const auth = await signIn(home, [{ id: "ed", group: "admin", token: "edtok" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as("edtok"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const put = async (type, id, body) => {
    const { rev } = (await call("GET", `/api/docs/${type}/${id}`)).json();
    return call("PUT", `/api/docs/${type}/${id}`, body, { "if-match": rev });
  };
  return {
    call,
    put,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const fence = (sql) => "```sql\n" + sql + "\n```";
const mdDoc = (schema, name, markdown, status = "active") => ({
  schema,
  id: name,
  keywords: [{ kw: name, inject: "full" }],
  status,
  body: { name, markdown },
});
const starter = (name, markdown, status) => mdDoc("starter/v1", name, markdown, status);
/** An agent md with one sql item per [id, sql]. */
const agentMd = (name, items) =>
  `# ${name}\n\n## 도메인 지식\n\n글\n\n## 데이터\n\n${items.map(([id, sql]) => `### ${id} — 조회\n\n${fence(sql)}`).join("\n\n")}\n`;

async function withTables(t) {
  for (const id of ["fdc_equipment", "fdc_chamber", "fdc_setup_event", "fdc_sensor"])
    assert.equal((await t.call("POST", "/api/docs/db-schema", example(`db-schema/${id}.json`))).statusCode, 201, id);
}

test("starter: the example is stored, rendered to rendered/starter/<name>/STARTER.md, listed and shown with its items' tables and kinds", async () => {
  const t = await setup();
  try {
    await withTables(t);
    const doc = example("starter/eqp-basics.json");
    const r = await t.call("POST", "/api/docs/starter", doc);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().queryWarnings, undefined, "the example has no warning");
    const rendered = join(t.storeDir, "rendered", "starter", "eqp-basics", "STARTER.md");
    assert.equal(readFileSync(rendered, "utf8"), doc.body.markdown);

    const list = (await t.call("GET", "/api/docs?type=starter&fields=body")).json().docs;
    assert.equal(list.length, 1);
    assert.equal(list[0].type, "starter");
    assert.equal(list[0].id, "eqp-basics");
    assert.equal(list[0].status, "active");
    assert.equal(typeof list[0].rev, "string");
    assert.equal(list[0].json.body.markdown, doc.body.markdown);

    const view = (await t.call("GET", "/api/docs/starter/eqp-basics")).json();
    assert.equal(view.md, doc.body.markdown);
    assert.deepEqual(
      view.starter.items.map(({ id, title, tables, kind }) => ({ id, title, tables, kind })),
      [
        { id: "eqp_info", title: "설비 정보", tables: ["FDC_EQUIPMENT"], kind: "info" },
        { id: "chamber_info", title: "챔버 정보", tables: ["FDC_CHAMBER"], kind: "info" },
        { id: "setup_events", title: "셋업 이벤트 이력", tables: ["FDC_SETUP_EVENT"], kind: "data" },
      ],
    );
    assert.deepEqual(view.starter.presets, [{ name: "기본 점검", items: ["eqp_info", "chamber_info"], line: 29, warnings: [] }]);

    // Off: the rendered md leaves the bundle.
    const { rev } = view;
    assert.equal((await t.call("POST", "/api/docs/starter/eqp-basics/deactivate", undefined, { "if-match": rev })).statusCode, 200);
    assert.equal(existsSync(rendered), false);
  } finally {
    await t.cleanup();
  }
});

test("starter: the four warnings come back on POST, PUT and GET, and the document is saved", async () => {
  const t = await setup();
  try {
    await withTables(t);
    const md = [
      "# 경고 넷",
      "",
      "## 데이터",
      "",
      "### sensor_one — 센서 하나",
      "",
      fence("SELECT * FROM FDC_SENSOR WHERE EQP_ID = :eqp_id AND SNSR_ID = :snsr_id"),
      "",
      "### ghost_rows — 없는 표",
      "",
      fence("SELECT * FROM FDC_GHOST WHERE EQP_ID = :eqp_id"),
      "",
      "### no_sql — 펜스 없음",
      "",
      "글",
      "",
      "## 프리셋",
      "",
      "- 기본: sensor_one, nowhere",
      "",
    ].join("\n");
    const want = [
      "info 조회 `sensor_one` 가 바인드 `snsr_id` 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다.",
      "항목 `ghost_rows` 가 읽는 표 `FDC_GHOST` 에 활성 DB 스키마 문서가 없다. 이 표는 info 로 센다.",
      "항목 `no_sql` 에 ```sql 펜스가 없다.",
      "프리셋 `기본` 이 없는 항목 `nowhere` 를 가리킨다.",
    ];
    const created = await t.call("POST", "/api/docs/starter", starter("warn", md));
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().queryWarnings, want);
    const got = (await t.call("GET", "/api/docs/starter/warn")).json();
    assert.deepEqual(got.queryWarnings, want);
    assert.deepEqual(got.starter.items.map((i) => i.warnings.length), [1, 1, 1]);
    assert.deepEqual(got.starter.presets[0].warnings, [want[3]]);
    const edited = await t.put("starter", "warn", { name: "warn", markdown: md.replace(", nowhere", "") });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.deepEqual(edited.json().queryWarnings, want.slice(0, 3));
  } finally {
    await t.cleanup();
  }
});

test("starter: a query id is one across domain-skill, domain and starter — 409 both ways, inside a batch too", async () => {
  const t = await setup();
  try {
    const one = (id) => `# s\n\n## 데이터\n\n### ${id} — 조회\n\n${fence("SELECT * FROM T WHERE EQP_ID = :eqp_id")}\n`;
    assert.equal((await t.call("POST", "/api/docs/starter", starter("first", one("eqp_info")))).statusCode, 201);

    const fromSkill = await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "a", agentMd("a", [["eqp_info", "SELECT 1 FROM T"]])));
    assert.equal(fromSkill.statusCode, 409, fromSkill.body);
    assert.deepEqual(fromSkill.json(), { error: "data_id_conflict", conflicts: [{ id: "eqp_info", doc: "first", kind: "data" }] });

    assert.equal((await t.call("POST", "/api/docs/domain", mdDoc("domain/v1", "k", agentMd("k", [["sensor_row", "SELECT 1 FROM T"]])))).statusCode, 201);
    const fromStarter = await t.call("POST", "/api/docs/starter", starter("second", one("sensor_row"), "inactive"));
    assert.equal(fromStarter.statusCode, 409, fromStarter.body);
    assert.deepEqual(fromStarter.json().conflicts, [{ id: "sensor_row", doc: "k", kind: "data" }]);
    const twoStarters = await t.call("POST", "/api/docs/starter", starter("second", one("eqp_info")));
    assert.deepEqual(twoStarters.json().conflicts, [{ id: "eqp_info", doc: "first", kind: "data" }]);

    const ownIds = await t.put("starter", "first", { name: "first", markdown: `${one("eqp_info")}\n### more_rows — 더\n` });
    assert.equal(ownIds.statusCode, 200, ownIds.body);

    const batch = await t.call("POST", "/api/docs/starter/batch", { docs: [starter("b1", one("row_x")), starter("b2", one("row_x"))] });
    assert.equal(batch.statusCode, 409, batch.body);
    assert.deepEqual(batch.json().conflicts, [{ id: "row_x", doc: "b1", kind: "data", source: "b2" }]);
  } finally {
    await t.cleanup();
  }
});

test("starter: its name is no agent name — an agent's subgraph may share it", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("POST", "/api/docs/starter", starter("pick", `# p\n\n## 데이터\n\n### p_row — 행\n\n${fence("SELECT 1 FROM T")}\n`))).statusCode, 201);
    const md = `# a\n\n## 데이터\n\n\`\`\`mermaid\nflowchart TD\n  subgraph pick [묶음]\n    a_row\n  end\n\`\`\`\n\n### a_row — 행\n\n${fence("SELECT 1 FROM T")}\n`;
    const r = await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "a", md));
    assert.equal(r.statusCode, 201, r.body);
  } finally {
    await t.cleanup();
  }
});

test("agent md: an info query with a bind beyond 설비 · 라인 is warned about on POST, PUT and GET; a data query is not", async () => {
  const t = await setup();
  try {
    await withTables(t);
    const md = agentMd("k", [
      ["sensor_row", "SELECT * FROM FDC_SENSOR WHERE EQP_ID = :eqp_id AND SNSR_ID = :snsr_id"],
      ["events", "SELECT * FROM FDC_SETUP_EVENT WHERE EQP_ID = :eqp_id AND EVT_TIME > :start_time"],
      ["eqp_line", "SELECT * FROM FDC_EQUIPMENT WHERE EQP_ID = :eqp AND LINE_ID = :line"],
    ]);
    const want = ["info 조회 `sensor_row` 가 바인드 `snsr_id` 를 받는다. info 조회는 설비마다 한 번만 돌고 그 뒤에는 바인드 값이 달라도 첫 표를 다시 쓴다."];
    // Inactive: an active agent md with binds needs a flow fence, which this test is not about.
    const created = await t.call("POST", "/api/docs/domain", mdDoc("domain/v1", "k", md, "inactive"));
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().queryWarnings, want);
    assert.deepEqual((await t.call("GET", "/api/docs/domain/k")).json().queryWarnings, want);
    const skill = await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "a", agentMd("a", [["chm_one", "SELECT * FROM FDC_CHAMBER WHERE CHM_ID = :chm_id"]]), "inactive"));
    assert.equal(skill.statusCode, 201, skill.body);
    assert.equal(skill.json().queryWarnings.length, 1);
    const fixed = await t.put("domain", "k", { name: "k", markdown: md.replace(" AND SNSR_ID = :snsr_id", "") });
    assert.equal(fixed.statusCode, 200, fixed.body);
    assert.equal(fixed.json().queryWarnings, undefined);
  } finally {
    await t.cleanup();
  }
});

test("starter: a table only a starter reads stays 기타 — 주요 · 쓰는 조회 count the agent mds", async () => {
  const t = await setup();
  try {
    await withTables(t);
    assert.equal((await t.call("POST", "/api/docs/starter", example("starter/eqp-basics.json"))).statusCode, 201);
    const md = agentMd("a", [["eqp_peers", "SELECT * FROM FDC_EQUIPMENT"]]);
    assert.equal((await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "a", md))).statusCode, 201);
    const rows = (await t.call("GET", "/api/docs?type=db-schema")).json().docs;
    const byId = Object.fromEntries(rows.map((d) => [d.id, d]));
    assert.equal(byId.fdc_equipment.major, true);
    assert.deepEqual(byId.fdc_equipment.usedBy, [{ type: "domain-skill", id: "a", query: "eqp_peers" }]);
    assert.equal(byId.fdc_chamber.major, false);
    assert.deepEqual(byId.fdc_chamber.usedBy, []);
    assert.equal((await t.call("GET", "/api/docs/db-schema/fdc_setup_event")).json().major, false);
    const facts = (await t.call("GET", "/api/flow-facts")).json().mds;
    assert.deepEqual(facts.map((m) => m.type), ["domain-skill", "starter"]);
  } finally {
    await t.cleanup();
  }
});

test("starter: its active items are registered queries — /api/flow-facts carries them and an agent md's flow may point at them", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "eqp-scope", flowMd("skills/eqp-scope.md")))).statusCode, 201);
    assert.equal((await t.call("POST", "/api/docs/starter", starter("eqp-basics", flowMd("starter-ref/eqp-basics.md")))).statusCode, 201);
    const gone = `# 옛\n\n## 데이터\n\n### old_row — 행\n\n${fence("SELECT * FROM T WHERE EQP_ID = :eqp_id")}\n`;
    assert.equal((await t.call("POST", "/api/docs/starter", starter("old-basics", gone, "archived"))).statusCode, 201);
    assert.equal((await t.call("POST", "/api/docs/starter", starter("off-basics", gone.replace("old_row", "off_row"), "inactive"))).statusCode, 201);

    const facts = await t.call("GET", "/api/flow-facts");
    assert.equal(facts.statusCode, 200);
    assert.deepEqual(facts.json().mds.map((m) => [m.type, m.id]), [["domain-skill", "eqp-scope"], ["starter", "eqp-basics"]]);
    assert.deepEqual(facts.json().mds[1], { type: "starter", id: "eqp-basics", markdown: flowMd("starter-ref/eqp-basics.md") });

    const check = flowMd("starter-ref/interlock-check.md");
    const nowhere = await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "interlock-check", check.replace("eqp_info --> interlock_data", "old_row --> interlock_data")));
    assert.equal(nowhere.statusCode, 400, nowhere.body);
    assert.equal(nowhere.json().error, "flow_rejected");
    assert.equal(nowhere.json().errors[0].code, "UNKNOWN_ID", "an archived starter's item is not registered");
    const created = await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "interlock-check", check));
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().flowWarnings, undefined);
  } finally {
    await t.cleanup();
  }
});

test("starter: a write that takes a referenced item away is saved and names the agent md it breaks, as an agent md's would", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "eqp-scope", flowMd("skills/eqp-scope.md")))).statusCode, 201);
    const basics = flowMd("starter-ref/eqp-basics.md");
    assert.equal((await t.call("POST", "/api/docs/starter", starter("eqp-basics", basics))).statusCode, 201);
    assert.equal((await t.call("POST", "/api/docs/domain-skill", mdDoc("domain-skill/v1", "interlock-check", flowMd("starter-ref/interlock-check.md")))).statusCode, 201);

    const renamed = await t.put("starter", "eqp-basics", { name: "eqp-basics", markdown: basics.replace("eqp_info", "eqp_row") });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.deepEqual(renamed.json().flowWarnings.map((w) => [w.md, w.errors[0].code]), [["interlock-check", "UNKNOWN_ID"]]);

    const back = await t.put("starter", "eqp-basics", { name: "eqp-basics", markdown: basics });
    assert.equal(back.json().flowWarnings, undefined);
    const off = await t.call("POST", "/api/docs/starter/eqp-basics/deactivate", undefined, { "if-match": back.json().rev });
    assert.equal(off.statusCode, 200, off.body);
    assert.deepEqual(off.json().flowWarnings.map((w) => w.md), ["interlock-check"]);
  } finally {
    await t.cleanup();
  }
});
