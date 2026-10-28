import { test } from "node:test";
import assert from "node:assert/strict";

import { findColumn, moveName, orderColumns, orderSteps, slotRowPlan, slotTableColumns } from "../../public/lib/column-order.mjs";

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

test("orderSteps: 맨 위로 · 위로 · 아래로 · 맨 아래로; the ends are off at the first and the last row", () => {
  assert.deepEqual(orderSteps(2, 5).map((s) => [s.label, s.to, s.off]), [
    ["맨 위로", 0, false],
    ["위로", 1, false],
    ["아래로", 3, false],
    ["맨 아래로", 4, false],
  ]);
  assert.deepEqual(orderSteps(0, 5).map((s) => s.off), [true, true, false, false]);
  assert.deepEqual(orderSteps(4, 5).map((s) => s.off), [false, false, true, true]);
  assert.deepEqual(orderSteps(0, 1).map((s) => s.off), [true, true, true, true]);
  assert.deepEqual(orderSteps(1, 3).map((s) => s.key), ["Home", "ArrowUp", "ArrowDown", "End"]);
});

test("맨 아래로 then 맨 위로: the row goes to the last place, then the first", () => {
  const names = ["A", "B", "C", "D"];
  const end = orderSteps(1, 4).at(-1);
  assert.deepEqual(moveName(names, 1, end.to), ["A", "C", "D", "B"]);
  assert.deepEqual(moveName(["A", "C", "D", "B"], 3, orderSteps(3, 4)[0].to), ["B", "A", "C", "D"]);
});
