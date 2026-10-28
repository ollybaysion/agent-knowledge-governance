import { test } from "node:test";
import assert from "node:assert/strict";

import { sqlPlan, tableLookup, tableRefs, tableTip, tokenize } from "../../public/lib/sql-tokens.mjs";

const kinds = (sql) => tokenize(sql).filter((t) => t.t !== "ws").map((t) => `${t.t}:${t.v}`);

test("tokenize: keywords any case, identifiers, numbers, binds, operators — and the text comes back whole", () => {
  const sql = "select EQP_ID, count(*) FROM fdc_sensor WHERE val > 1.5 AND eqp = :eqp";
  assert.deepEqual(kinds(sql), [
    "kw:select", "id:EQP_ID", "op:,", "kw:count", "op:(", "op:*", "op:)", "kw:FROM", "id:fdc_sensor",
    "kw:WHERE", "id:val", "op:>", "num:1.5", "kw:AND", "id:eqp", "op:=", "bind::eqp",
  ]);
  assert.equal(tokenize(sql).map((t) => t.v).join(""), sql);
});

test("tokenize: a keyword inside a string stays string; '' escapes a quote", () => {
  assert.deepEqual(kinds("WHERE note = 'SELECT it''s FROM x'"), ["kw:WHERE", "id:note", "op:=", "str:'SELECT it''s FROM x'"]);
});

test("tokenize: -- and /* */ comments, the second across lines", () => {
  assert.deepEqual(kinds("SELECT a -- FROM b\nFROM t /* JOIN\n u */ WHERE"), [
    "kw:SELECT", "id:a", "cmt:-- FROM b", "kw:FROM", "id:t", "cmt:/* JOIN\n u */", "kw:WHERE",
  ]);
});

test("tokenize: :name is a bind, a::b is a cast, an unclosed string runs to the end", () => {
  assert.deepEqual(kinds("x = :lot_id"), ["id:x", "op:=", "bind::lot_id"]);
  assert.deepEqual(kinds("a::int"), ["id:a", "op::", "op::", "id:int"]);
  assert.deepEqual(kinds("x = 'open"), ["id:x", "op:=", "str:'open"]);
});

test("tableRefs: FROM · JOIN · UPDATE · INSERT INTO, with aliases, AS, owner prefixes and comma lists", () => {
  const refs = (sql) => tableRefs(tokenize(sql)).map(({ table, alias }) => [table, alias]);
  assert.deepEqual(refs("SELECT p.EQP_ID FROM FDC_EQUIPMENT p JOIN TESTUSER.FDC_EQUIPMENT AS me ON p.M = me.M"), [
    ["FDC_EQUIPMENT", "P"],
    ["FDC_EQUIPMENT", "ME"],
  ]);
  assert.deepEqual(refs("select * from a, owner.b bb where 1=1"), [["A", null], ["B", "BB"]]);
  assert.deepEqual(refs("UPDATE fdc_sensor SET v = 1"), [["FDC_SENSOR", null]]);
  assert.deepEqual(refs("INSERT INTO fdc_sensor (a) VALUES (1)"), [["FDC_SENSOR", null]]);
  assert.deepEqual(refs("SELECT x FROM (SELECT y FROM inner_t) q"), [["INNER_T", null]]);
});

const INDEX = {
  fdc_equipment: { table: "FDC_EQUIPMENT", columns: { EQP_ID: { text: "설비 ID" }, MODEL_CD: { text: null } } },
  fdc_sensor: { table: "FDC_SENSOR", columns: { SENSOR_ID: { text: "센서" }, EQP_ID: { text: "설비 FK" } } },
};

test("tableLookup matches a document id or its table, any case", () => {
  const look = tableLookup(INDEX);
  assert.equal(look("FDC_EQUIPMENT"), "fdc_equipment");
  assert.equal(look("fdc_sensor"), "fdc_sensor");
  assert.equal(look("nope"), null);
});

test("sqlPlan links known tables, resolves alias.COL through the alias, and a bare COL through the first named table that has it", () => {
  const sql = "SELECT p.EQP_ID, s.SENSOR_ID, MODEL_CD, EQP_ID, nope FROM TESTUSER.FDC_EQUIPMENT p JOIN fdc_sensor s ON s.EQP_ID = p.EQP_ID JOIN other o ON o.EQP_ID = 1";
  const plan = sqlPlan(sql, INDEX);
  const tables = plan.filter((t) => t.table).map((t) => `${t.v}>${t.table}`);
  assert.deepEqual(tables, ["FDC_EQUIPMENT>fdc_equipment", "fdc_sensor>fdc_sensor"]);
  const cols = plan.filter((t) => t.column).map((t) => `${t.v}>${t.column.id}.${t.column.name}`);
  assert.deepEqual(cols, [
    "EQP_ID>fdc_equipment.EQP_ID", // p.EQP_ID
    "SENSOR_ID>fdc_sensor.SENSOR_ID", // s.SENSOR_ID
    "MODEL_CD>fdc_equipment.MODEL_CD",
    "EQP_ID>fdc_equipment.EQP_ID", // bare: first named table
    "EQP_ID>fdc_sensor.EQP_ID", // s.EQP_ID
    "EQP_ID>fdc_equipment.EQP_ID", // p.EQP_ID
  ]);
  assert.equal(plan.find((t) => t.v === "TESTUSER").column, undefined);
  assert.equal(plan.find((t) => t.v === "other").table, undefined);
  assert.equal(plan.filter((t) => t.column && t.column.name === "MODEL_CD")[0].column.text, null);
  assert.equal(plan.map((t) => t.v).join(""), sql);
});

test("sqlPlan without an index gives the colours only", () => {
  const plan = sqlPlan("SELECT EQP_ID FROM fdc_equipment", null);
  assert.ok(plan.every((t) => !t.table && !t.column));
});

test("tableTip: the table name, its column count and its description; 설명 없음 when empty, null for an unknown table", () => {
  const index = {
    fdc_sensor: { table: "FDC_SENSOR", purpose: "센서 — 설비 1:N 종속", columns: { SNSR_ID: { text: null }, EQP_ID: { text: "설비" } } },
    bare: { table: "BARE", purpose: null, columns: {} },
  };
  assert.deepEqual(tableTip(index, "fdc_sensor"), { head: "FDC_SENSOR", count: "열 2", text: "센서 — 설비 1:N 종속" });
  assert.deepEqual(tableTip(index, "bare"), { head: "BARE", count: "열 0", text: "설명 없음" });
  assert.equal(tableTip(index, "nope"), null);
  assert.equal(tableTip(null, "fdc_sensor"), null);
});
