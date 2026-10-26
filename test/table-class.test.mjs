import { test } from "node:test";
import assert from "node:assert/strict";

import { coverageOf, tablesOfSql, tableUses } from "../src/table-class.mjs";

test("tablesOfSql: the name after FROM and JOIN, upper case, the owner prefix cut", () => {
  assert.deepEqual(tablesOfSql("select * from fdc_trace t join TESTUSER.Fdc_Eqp e on e.id = t.eqp_id"), ["FDC_TRACE", "FDC_EQP"]);
  assert.deepEqual(tablesOfSql('SELECT 1 FROM "OWNER"."ALARM_HIST" a LEFT OUTER JOIN eqp_master m ON 1 = 1'), ["ALARM_HIST", "EQP_MASTER"]);
});

test("tablesOfSql: each table of a FROM list, with or without an alias", () => {
  assert.deepEqual(tablesOfSql("SELECT * FROM a x, b AS y, c WHERE x.k = y.k"), ["A", "B", "C"]);
});

test("tablesOfSql: a subquery's own FROM counts; its alias, a CTE name and a function's FROM do not", () => {
  const sql = `WITH recent AS (SELECT * FROM fdc_trace WHERE t > :start_time)
    SELECT EXTRACT(DAY FROM r.t), s.v
    FROM recent r
    JOIN (SELECT id, v FROM sensor_val) s ON s.id = r.id
    WHERE r.k IN (SELECT k FROM eqp_master)`;
  assert.deepEqual(tablesOfSql(sql), ["FDC_TRACE", "SENSOR_VAL", "EQP_MASTER"]);
});

test("tablesOfSql: comments and string literals are not read", () => {
  const sql = "SELECT 'from fake' FROM real_t -- join other_t\n /* FROM hidden */ WHERE a = 'x JOIN y'";
  assert.deepEqual(tablesOfSql(sql), ["REAL_T"]);
});

test("tablesOfSql: each table once, in order of appearance; no SQL is no table", () => {
  assert.deepEqual(tablesOfSql("SELECT * FROM a UNION ALL SELECT * FROM A"), ["A"]);
  assert.deepEqual(tablesOfSql(""), []);
  assert.deepEqual(tablesOfSql(null), []);
});

test("tableUses: table → the 조회 (skill · query id) that read it; a question item reads nothing", () => {
  const md = "# s\n\n## 데이터\n\n### trace — 트레이스\n\n```sql\nSELECT * FROM fdc_trace\n```\n\n### eqp — 설비\n\n```sql\nSELECT * FROM eqp_master e JOIN fdc_trace t ON 1=1\n```\n\n### duration — 기간\n\n어느 기간?\n";
  const uses = tableUses([{ type: "domain-skill", id: "s", markdown: md }, { type: "domain", id: "d", markdown: undefined }]);
  assert.deepEqual(uses.get("FDC_TRACE"), [
    { type: "domain-skill", id: "s", query: "trace" },
    { type: "domain-skill", id: "s", query: "eqp" },
  ]);
  assert.deepEqual(uses.get("EQP_MASTER"), [{ type: "domain-skill", id: "s", query: "eqp" }]);
  assert.equal(uses.size, 2);
});

test("coverageOf: confirmed over scaffold + inferred + confirmed of purpose, columnDescs and query notes; deprecated is out", () => {
  const body = {
    purpose: { text: "p", tier: "confirmed" },
    columnDescs: {
      A: { text: "a", tier: "confirmed" },
      B: { text: null, tier: "scaffold" },
      C: { text: "c", tier: "inferred" },
      D: { text: "d", tier: "deprecated" },
    },
    queries: [{ sql: "SELECT 1", note: { text: "n", tier: "confirmed" } }],
  };
  assert.deepEqual(coverageOf(body), { confirmed: 3, total: 5, ratio: 0.6 });
  assert.deepEqual(coverageOf({ purpose: { text: null, tier: "scaffold" }, columnDescs: {} }), { confirmed: 0, total: 1, ratio: 0 });
  assert.deepEqual(coverageOf({}), { confirmed: 0, total: 0, ratio: 0 });
});
