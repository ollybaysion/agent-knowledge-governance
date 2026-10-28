import { test } from "node:test";
import assert from "node:assert/strict";

import { findColumn, moveName, orderColumns, slotRowPlan, slotTableColumns } from "../../public/lib/column-order.mjs";

const cols = (...names) => names.map((name) => ({ name, type: "NUMBER", nullable: true }));
const names = (list) => list.map((c) => c.name);

test("orderColumns: no columnOrder keeps the catalog order", () => {
  assert.deepEqual(names(orderColumns(cols("A", "B", "C"))), ["A", "B", "C"]);
  assert.deepEqual(names(orderColumns(cols("A", "B", "C"), [])), ["A", "B", "C"]);
});

test("orderColumns: the named columns come first in columnOrder's order", () => {
  assert.deepEqual(names(orderColumns(cols("A", "B", "C", "D"), ["C", "A", "D", "B"])), ["C", "A", "D", "B"]);
});

test("orderColumns: a catalog column columnOrder lacks follows, in catalog order", () => {
  assert.deepEqual(names(orderColumns(cols("A", "B", "C", "D", "E"), ["D", "B"])), ["D", "B", "A", "C", "E"]);
});

test("orderColumns: a name the catalog lacks is dropped, a repeated one counts once", () => {
  assert.deepEqual(names(orderColumns(cols("A", "B", "C"), ["GONE", "C", "C", "A"])), ["C", "A", "B"]);
});

test("orderColumns: the catalog's column objects come back as they are", () => {
  const catalog = cols("A", "B");
  const out = orderColumns(catalog, ["B"]);
  assert.equal(out[0], catalog[1]);
  assert.equal(out[1], catalog[0]);
});

test("moveName: moves one name up or down and leaves the input alone", () => {
  const list = ["A", "B", "C", "D"];
  assert.deepEqual(moveName(list, 2, 0), ["C", "A", "B", "D"]);
  assert.deepEqual(moveName(list, 0, 3), ["B", "C", "D", "A"]);
  assert.deepEqual(moveName(list, 1, 2), ["A", "C", "B", "D"]);
  assert.deepEqual(list, ["A", "B", "C", "D"]);
});

test("moveName: an index out of range gives the same order back", () => {
  assert.deepEqual(moveName(["A", "B"], 0, -1), ["A", "B"]);
  assert.deepEqual(moveName(["A", "B"], 1, 2), ["A", "B"]);
  assert.deepEqual(moveName(["A", "B"], 5, 0), ["A", "B"]);
});

test("findColumn: ?col= names the 열 row as the catalog spells it, null once the column is gone", () => {
  assert.equal(findColumn(cols("EQP_ID", "MODEL_CD"), "MODEL_CD"), "MODEL_CD");
  assert.equal(findColumn(cols("EQP_ID", "MODEL_CD"), "model_cd"), "MODEL_CD");
  assert.equal(findColumn(cols("EQP_ID"), "MODEL_CD"), null);
  assert.equal(findColumn(cols("EQP_ID"), null), null);
  assert.equal(findColumn(undefined, "A"), null);
});

test("slotTableColumns: the buttons lead, a db-schema puts 타입 last; use · order only for the admin", () => {
  const keys = (cols) => cols.map((c) => c.key);
  assert.deepEqual(keys(slotTableColumns("db-schema")), ["acts", "name", "nullable", "desc", "type"]);
  assert.deepEqual(keys(slotTableColumns("db-schema", { canOrder: true })), ["acts", "use", "order", "name", "nullable", "desc", "type"]);
  assert.deepEqual(slotTableColumns("db-schema", { canOrder: true }).map((c) => c.label), ["", "사용", "순서", "열", "빈칸", "설명", "타입"]);
  assert.deepEqual(keys(slotTableColumns("msg-format")), ["acts", "seq", "name", "type", "required", "desc"]);
});

test("slotRowPlan: the buttons sit in the first cell; an open slot empties it, marks its 설명 and spans every cell below", () => {
  const cols = slotTableColumns("db-schema", { canOrder: true });
  const closed = slotRowPlan(cols);
  assert.equal(closed.cells[0], "acts");
  assert.deepEqual(closed.cells, cols.map((c) => c.key));
  assert.equal(closed.editColspan, null);
  const open = slotRowPlan(cols, { open: true });
  assert.deepEqual(open.cells, ["empty", "use", "order", "name", "nullable", "mark", "type"]);
  assert.equal(open.editColspan, cols.length);
  assert.equal(slotRowPlan(slotTableColumns("msg-format"), { open: true }).editColspan, 6);
});
