// A screen-map document's `data` through the routes: the ids no registered
// query has come back as screen_data_unknown warnings on POST, PUT and GET,
// the document is saved anyway, and the doc view carries each id with the
// document that registers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const EXAMPLES = new URL("../../examples/", import.meta.url);
const example = (p) => JSON.parse(readFileSync(new URL(p, EXAMPLES), "utf8"));

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-screen-data-"));
  const auth = await signIn(home, [{ id: "ed", group: "admin", token: "edtok" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as("edtok"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const put = async (type, id, body) => {
    const { rev } = (await call("GET", `/api/docs/${type}/${id}`)).json();
    return call("PUT", `/api/docs/${type}/${id}`, body, { "if-match": rev });
  };
  // The tables the examples link to and read.
  for (const id of ["fdc_equipment", "fdc_chamber", "fdc_setup_event", "fdc_sensor"])
    assert.equal((await call("POST", "/api/docs/db-schema", example(`db-schema/${id}.json`))).statusCode, 201, id);
  return {
    call,
    put,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const unknown = (id) =>
  `screen_data_unknown: 화면 데이터 \`${id}\` 는 등재된 조회가 아니다. 활성 첫 선택 데이터 문서의 항목에도, 에이전트 문서의 조회에도 없다.`;

function screen(data) {
  const doc = example("screen-map/fdc-monitor-history.json");
  doc.body.data = data;
  return doc;
}

test("screen-map data: an id no registered query has is warned on POST, PUT and GET, and the document is saved", async () => {
  const t = await setup();
  try {
    const created = await t.call("POST", "/api/docs/screen-map", screen(["eqp_info", "ghost_rows"]));
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().queryWarnings, [unknown("eqp_info"), unknown("ghost_rows")], "no starter yet: both are unknown");

    assert.equal((await t.call("POST", "/api/docs/starter", example("starter/eqp-basics.json"))).statusCode, 201);
    const view = (await t.call("GET", "/api/docs/screen-map/fdc-monitor-history")).json();
    assert.deepEqual(view.queryWarnings, [unknown("ghost_rows")], "the starter registers eqp_info");
    assert.deepEqual(view.screenData, [
      { id: "eqp_info", doc: { type: "starter", id: "eqp-basics" } },
      { id: "ghost_rows", doc: null },
    ]);

    const { body } = screen(["setup_events", "eqp_info"]);
    const edited = await t.put("screen-map", "fdc-monitor-history", body);
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().queryWarnings, undefined, "both are starter items");
  } finally {
    await t.cleanup();
  }
});

test("screen-map data: an inactive starter registers nothing; a screen without data has no warning and an empty list", async () => {
  const t = await setup();
  try {
    const off = example("starter/eqp-basics.json");
    off.status = "inactive";
    assert.equal((await t.call("POST", "/api/docs/starter", off)).statusCode, 201);
    const created = await t.call("POST", "/api/docs/screen-map", screen(["eqp_info"]));
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().queryWarnings, [unknown("eqp_info")]);

    const bare = example("screen-map/spc-chart-config.json");
    const r = await t.call("POST", "/api/docs/screen-map", bare);
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().queryWarnings, undefined);
    const view = (await t.call("GET", "/api/docs/screen-map/spc-chart-config")).json();
    assert.deepEqual(view.screenData, []);
    assert.equal(view.queryWarnings, undefined);
  } finally {
    await t.cleanup();
  }
});

test("screen-map data: the shipped example's id is the shipped agent document's query", async () => {
  const t = await setup();
  try {
    const skill = await t.call("POST", "/api/docs/domain-skill", example("domain-skill/fdc-explain-sensor-origin.json"));
    assert.equal(skill.statusCode, 201, skill.body);
    const r = await t.call("POST", "/api/docs/screen-map", example("screen-map/fdc-monitor-history.json"));
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().queryWarnings, undefined);
    const view = (await t.call("GET", "/api/docs/screen-map/fdc-monitor-history")).json();
    assert.deepEqual(view.screenData, [{ id: "sensor_row", doc: { type: "domain-skill", id: "fdc-explain-sensor-origin" } }]);
  } finally {
    await t.cleanup();
  }
});
