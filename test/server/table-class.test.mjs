// db-schema 분류: kind (info · data) is a stored body field a person sets with
// the document PUT and the collector's pushes keep; 주요 and 확정 커버리지 are
// the server's counts, carried on the list and the doc view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-table-class-"));
  const signedIn = await signIn(home, [
    { id: "ed", group: "admin", token: "edtok" },
    { id: "bot", group: "agent", token: "bottok" },
    { id: "reader", group: "user", token: "rtok" },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), auth: signedIn });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const catalog = (names) => ({
  columns: names.map((name) => ({ name, type: "NUMBER", nullable: true })),
  primaryKey: [names[0]],
  fetchedAt: "2026-01-01T00:00:00Z",
});
function table(name, extra = {}) {
  return {
    schema: "db-schema/v1",
    id: name.toLowerCase(),
    keywords: [{ kw: name.toLowerCase(), inject: "full" }],
    status: "active",
    body: {
      table: name,
      catalog: catalog(["A", "B"]),
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" }, B: { text: null, tier: "scaffold" } },
      ...extra,
    },
  };
}
function skill(id, sqls, { type = "domain-skill", status = "active" } = {}) {
  const items = Object.entries(sqls)
    .map(([q, sql]) => `### ${q} — 조회\n\n\`\`\`sql\n${sql}\n\`\`\``)
    .join("\n\n");
  return {
    schema: `${type}/v1`,
    id,
    keywords: [{ kw: id, inject: "full" }],
    status,
    body: { name: id, markdown: `# ${id}\n\n## 데이터\n\n${items}\n` },
  };
}
const post = (app, doc) => app.inject({ method: "POST", url: `/api/docs/${doc.schema.split("/")[0]}`, headers: as("edtok"), payload: doc });
const get = (app, url) => app.inject({ method: "GET", url, headers: as("rtok") });

test("kind: info and data are stored, any other value is refused, and a table without kind stays valid", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, table("T_INFO", { kind: "info" }))).statusCode, 201);
    assert.equal((await post(app, table("T_DATA", { kind: "data" }))).statusCode, 201);
    assert.equal((await post(app, table("T_NONE"))).statusCode, 201);
    const bad = await post(app, table("T_BAD", { kind: "major" }));
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error, "validation_failed");
    const list = (await get(app, "/api/docs?type=db-schema")).json().docs;
    assert.deepEqual(Object.fromEntries(list.map((d) => [d.id, d.kind ?? null])), { t_data: "data", t_info: "info", t_none: null });
  } finally {
    await cleanup();
  }
});

test("kind: the document PUT sets and clears it with no slot moving", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table("T1"));
    const read = (await get(app, "/api/docs/db-schema/t1")).json();
    const put = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1", headers: { ...as("edtok"), "if-match": read.rev }, payload: { ...read.json.body, kind: "data" } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().json.body.kind, "data");
    assert.deepEqual(put.json().json.body.columnDescs, read.json.body.columnDescs);
    const { kind: _k, ...cleared } = put.json().json.body;
    const back = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1", headers: { ...as("edtok"), "if-match": put.json().rev }, payload: cleared });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal("kind" in back.json().json.body, false);
    const asUser = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1", headers: { ...as("rtok"), "if-match": back.json().rev }, payload: { ...cleared, kind: "info" } });
    assert.equal(asUser.statusCode, 403);
  } finally {
    await cleanup();
  }
});

test("kind: catalog-push and facts-push keep it", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table("T1", { kind: "info" }));
    const cat = await app.inject({ method: "PUT", url: "/api/docs/db-schema/t1/catalog", headers: as("bottok"), payload: catalog(["A", "C"]) });
    assert.equal(cat.statusCode, 200, cat.body);
    assert.equal(cat.json().json.body.kind, "info");
    const facts = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/t1/facts",
      headers: as("bottok"),
      payload: { body: { table: "T1", catalog: catalog(["A"]), purpose: { text: null, tier: "scaffold" }, columnDescs: { A: { text: null, tier: "scaffold" } } } },
    });
    assert.equal(facts.statusCode, 200, facts.body);
    assert.equal(facts.json().json.body.kind, "info");
    const stored = (await get(app, "/api/docs/db-schema/t1")).json();
    assert.equal(stored.json.body.kind, "info");
  } finally {
    await cleanup();
  }
});

test("주요: a table an active skill's or domain's 조회 reads (FROM · JOIN, any case, owner cut); the list and the doc view carry who reads it", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, table("FDC_TRACE"));
    await post(app, table("EQP_MASTER"));
    await post(app, table("LONELY"));
    await post(app, table("ONLY_OFF"));
    assert.equal((await post(app, skill("s1", { trace: "SELECT * FROM testuser.fdc_trace t JOIN Eqp_Master e ON e.id = t.eqp" }))).statusCode, 201);
    assert.equal((await post(app, skill("dm", { eqp_list: "SELECT id FROM EQP_MASTER" }, { type: "domain" }))).statusCode, 201);
    assert.equal((await post(app, skill("off", { only: "SELECT * FROM only_off" }, { status: "inactive" }))).statusCode, 201);

    const list = (await get(app, "/api/docs?type=db-schema")).json().docs;
    const by = Object.fromEntries(list.map((d) => [d.id, d]));
    assert.equal(by.fdc_trace.major, true);
    assert.deepEqual(by.fdc_trace.usedBy, [{ type: "domain-skill", id: "s1", query: "trace" }]);
    assert.deepEqual(by.eqp_master.usedBy, [
      { type: "domain-skill", id: "s1", query: "trace" },
      { type: "domain", id: "dm", query: "eqp_list" },
    ]);
    assert.equal(by.lonely.major, false);
    assert.deepEqual(by.lonely.usedBy, []);
    assert.equal(by.only_off.major, false, "an inactive skill's 조회 does not count");
    assert.deepEqual(by.lonely.coverage, { confirmed: 0, total: 3, ratio: 0 });

    const view = (await get(app, "/api/docs/db-schema/fdc_trace")).json();
    assert.equal(view.major, true);
    assert.deepEqual(view.usedBy, by.fdc_trace.usedBy);
    assert.deepEqual(view.coverage, by.fdc_trace.coverage);

    const all = (await get(app, "/api/docs")).json().docs;
    assert.equal(all.find((d) => d.id === "s1").major, undefined, "only db-schema rows carry it");
    assert.equal(all.find((d) => d.id === "fdc_trace").major, true);
  } finally {
    await cleanup();
  }
});
