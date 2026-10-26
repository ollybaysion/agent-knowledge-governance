// GET /api/schema-index: the db-schema documents as {table, columns} for the
// reading view's SQL links and column tooltips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { schemaIndex } from "../../server/routes/schema-index.mjs";
import { signIn, as } from "../sign-in.mjs";

const example = (id) => JSON.parse(readFileSync(new URL(`../../examples/db-schema/${id}.json`, import.meta.url), "utf8"));

test("the index lists each db-schema doc's table and columns, and is built again after a write", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-schema-index-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  try {
    const empty = await app.inject({ method: "GET", url: "/api/schema-index", headers: as("reader") });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), {});
    const r = await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: as("a"), payload: example("fdc_equipment") });
    assert.equal(r.statusCode, 201, r.body);
    const index = (await app.inject({ method: "GET", url: "/api/schema-index", headers: as("reader") })).json();
    assert.deepEqual(Object.keys(index), ["fdc_equipment"]);
    assert.equal(index.fdc_equipment.table, "FDC_EQUIPMENT");
    const doc = example("fdc_equipment");
    assert.deepEqual(Object.keys(index.fdc_equipment.columns), doc.body.catalog.columns.map((c) => c.name));
    // EQP_ID's slot is an empty scaffold: the catalog comment stands in.
    assert.equal(doc.body.columnDescs.EQP_ID.text, null);
    assert.equal(index.fdc_equipment.columns.EQP_ID.text, "설비 ID");
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: as("a"), payload: example("fdc_sensor") });
    const again = (await app.inject({ method: "GET", url: "/api/schema-index", headers: as("reader") })).json();
    assert.deepEqual(Object.keys(again).sort(), ["fdc_equipment", "fdc_sensor"]);
    assert.equal((await app.inject({ method: "GET", url: "/api/schema-index" })).statusCode, 401);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("schemaIndex: description from columnDescs, else the catalog comment, else null; inactive and archived docs left out", () => {
  const body = (extra) => ({
    table: "T",
    catalog: { columns: [{ name: "A", comment: "주석 A" }, { name: "B", comment: null }, { name: "C", comment: "주석 C" }] },
    columnDescs: { A: { text: "설명 A" }, C: { text: "" } },
    ...extra,
  });
  assert.deepEqual(
    schemaIndex([
      { id: "t", status: "active", body: body() },
      { id: "off", status: "inactive", body: body() },
      { id: "gone", status: "archived", body: body() },
    ]),
    { t: { table: "T", columns: { A: { text: "설명 A" }, B: { text: null }, C: { text: "주석 C" } } } },
  );
});
