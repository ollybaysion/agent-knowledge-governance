// The cases of fdc-agent-be-spring SqlRenderTest, so the editor binds the way the consumer renders.
import { test } from "node:test";
import assert from "node:assert/strict";

import { bindSql, columnsOf, literal, timeOf, varsOf } from "../src/sql-bind.mjs";

const SECOND = (s) => `TO_DATE('${s}', 'YYYY-MM-DD HH24:MI:SS')`;

test("a string is quoted and a number is bare", () => {
  assert.deepEqual(bindSql("SELECT * FROM t WHERE id = :id AND idx = :idx", { id: "S-0004", idx: "7" }), {
    sql: "SELECT * FROM t WHERE id = 'S-0004' AND idx = 7",
    missing: [],
  });
});

test("a single quote is doubled, so a value cannot close the literal", () => {
  assert.equal(
    bindSql("SELECT * FROM t WHERE name = :name", { name: "O'Brien'; DROP TABLE t--" }).sql,
    "SELECT * FROM t WHERE name = 'O''Brien''; DROP TABLE t--'",
  );
});

test("date-times in any accepted shape are written as one TO_DATE mask; a fraction is TO_TIMESTAMP", () => {
  const second = SECOND("2026-05-01 09:30:00");
  for (const v of ["2026-05-01 09:30", "2026-05-01T09:30:00", "2026/05/01 09:30:00", "20260501093000", "2026-05-01T09:30"])
    assert.equal(literal(v), second, v);
  assert.equal(literal("2026/05/01"), SECOND("2026-05-01 00:00:00"));
  assert.equal(literal("2026-05-01 09:30:00.250"), "TO_TIMESTAMP('2026-05-01 09:30:00.250', 'YYYY-MM-DD HH24:MI:SS.FF')");
  assert.equal(literal("2026-05-01 09:30:00.1234567"), "TO_TIMESTAMP('2026-05-01 09:30:00.123456700', 'YYYY-MM-DD HH24:MI:SS.FF')");
  assert.equal(
    bindSql("SELECT * FROM t WHERE d BETWEEN :s AND :e", { s: "2026-05-01", e: "2026-05-31 23:59:59" }).sql,
    `SELECT * FROM t WHERE d BETWEEN ${SECOND("2026-05-01 00:00:00")} AND ${SECOND("2026-05-31 23:59:59")}`,
  );
});

test("a trailing Z or offset becomes this machine's local time", () => {
  const d = new Date("2026-05-01T00:30:00Z");
  const local = { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: 0, frac: "000000000" };
  for (const v of ["2026-05-01T00:30:00Z", "2026-05-01T09:30:00+09:00", "2026-05-01T09:30:00+0900"]) assert.deepEqual(timeOf(v), local, v);
});

test("a number that is no date stays a number; an impossible date is a string", () => {
  assert.equal(literal("12345678901234"), "12345678901234");
  assert.equal(literal("20261399000000"), "20261399000000");
  assert.equal(literal("2026-02-30"), "'2026-02-30'");
  assert.equal(literal(" 7 "), "7");
});

test("a colon inside a literal or a comment is no bind; a prefix does not eat a longer name", () => {
  assert.equal(
    bindSql("SELECT TO_CHAR(t, 'YYYY-MM-DD HH24:MI:SS') FROM t WHERE id = :id", { id: "A" }).sql,
    "SELECT TO_CHAR(t, 'YYYY-MM-DD HH24:MI:SS') FROM t WHERE id = 'A'",
  );
  assert.equal(
    bindSql("SELECT /* :x 는 안 받는다 */ a FROM t WHERE a = :a -- :b 도 안 받는다", { a: "1" }).sql,
    "SELECT /* :x 는 안 받는다 */ a FROM t WHERE a = 1 -- :b 도 안 받는다",
  );
  assert.equal(bindSql("SELECT a -- don't\nFROM t WHERE a = :a", { a: "1" }).sql, "SELECT a -- don't\nFROM t WHERE a = 1");
  assert.equal(bindSql("SELECT * FROM t WHERE a = :id AND b = :id_2", { id: "1", id_2: "2" }).sql, "SELECT * FROM t WHERE a = 1 AND b = 2");
  assert.deepEqual(varsOf("SELECT a FROM t WHERE a = :a -- :b\n AND c = :c /* :d */ AND e = 'x:y' AND f = :a"), ["a", "c"]);
});

test("a bind without a value stays as written and is listed; names match exactly", () => {
  assert.deepEqual(bindSql("SELECT * FROM t WHERE a = :a AND b = :b AND c = :B", { a: "1", b: "" }), {
    sql: "SELECT * FROM t WHERE a = 1 AND b = '' AND c = :B",
    missing: ["B"],
  });
  assert.deepEqual(bindSql("SELECT * FROM t WHERE a = :a", {}).missing, ["a"]);
});

test("columnsOf: an alias or a column name per item, upper case — the flow check's output columns", () => {
  assert.deepEqual(columnsOf("SELECT COUNT(*) AS CNT, ROUND(AVG(v), 2) AS MEAN, eqp_id\n  FROM t WHERE a = :a"), ["CNT", "MEAN", "EQP_ID"]);
  assert.deepEqual(columnsOf("-- 설명\nSELECT a, -- 첫째\n b /* 둘째 */ FROM t"), ["A", "B"]);
  assert.deepEqual(columnsOf("select t.param_index, CAST(x AS NUMBER) AS n from T t"), ["PARAM_INDEX", "N"]);
});

test("columnsOf: a name it cannot read gives nothing rather than half a list", () => {
  assert.equal(columnsOf("SELECT * FROM t"), null);
  assert.equal(columnsOf("SELECT a, b + c FROM t"), null);
  assert.equal(columnsOf("WITH w AS (SELECT a FROM t) SELECT a FROM w"), null);
  assert.equal(columnsOf("SELECT 1"), null);
  assert.equal(columnsOf(""), null);
});
