import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inferredColumns,
  slotFailText,
  togglePick,
  withObject,
} from "../../public/lib/column-bulk.mjs";

const slot = (address, tier) => ({ address, tier });

test("inferredColumns: the 추정 column slots only, in the table's order; purpose and queries stay out", () => {
  const slots = [
    slot("purpose", "inferred"),
    slot("columnDescs.A", "inferred"),
    slot("columnDescs.B", "confirmed"),
    slot("columnDescs.C", "inferred"),
    slot("columnDescs.D", "scaffold"),
    slot("queries[0].note", "inferred"),
  ];
  assert.deepEqual(inferredColumns(slots, ["C", "B", "A", "D"]), [
    { name: "C", address: "columnDescs.C" },
    { name: "A", address: "columnDescs.A" },
  ]);
});

test("inferredColumns: a column the order lacks follows in the slots' order; none gives []", () => {
  const slots = [
    slot("columnDescs.GONE", "inferred"),
    slot("columnDescs.A", "inferred"),
    slot("columnDescs.OLD", "inferred"),
  ];
  assert.deepEqual(
    inferredColumns(slots, ["A"]).map((r) => r.name),
    ["A", "GONE", "OLD"],
  );
  assert.deepEqual(inferredColumns([slot("columnDescs.A", "confirmed")]), []);
  assert.deepEqual(inferredColumns(undefined), []);
});

test("withObject: 을 after a closing consonant, 를 after a vowel", () => {
  assert.equal(withObject("열"), "열을");
  assert.equal(withObject("필드"), "필드를");
});

test("togglePick: a new address goes to the end, a picked one comes out; the input is left alone", () => {
  const list = ["columnDescs.A", "columnDescs.B"];
  assert.deepEqual(togglePick(list, "columnDescs.C"), [
    "columnDescs.A",
    "columnDescs.B",
    "columnDescs.C",
  ]);
  assert.deepEqual(togglePick(list, "columnDescs.A"), ["columnDescs.B"]);
  assert.deepEqual(
    togglePick(togglePick(list, "columnDescs.C"), "columnDescs.C"),
    list,
  );
  assert.deepEqual(togglePick(undefined, "columnDescs.A"), ["columnDescs.A"]);
  assert.deepEqual(list, ["columnDescs.A", "columnDescs.B"]);
});

test("slotFailText: the verb, the status, the server's error and the slots it named", () => {
  assert.equal(
    slotFailText("확정", 400, {
      error: "not_inferred",
      slots: ["columnDescs.A", "columnDescs.B"],
    }),
    "확정 실패 (400) — not_inferred: columnDescs.A · columnDescs.B",
  );
  assert.equal(
    slotFailText("폐기", 400, {
      error: "validation_failed",
      details: ["body: bad"],
    }),
    "폐기 실패 (400) — validation_failed: body: bad",
  );
  assert.equal(
    slotFailText("확정", 400, { error: "no_eligible_slots" }),
    "확정 실패 (400) — no_eligible_slots",
  );
  assert.equal(slotFailText("확정", 500, null), "확정 실패 (500)");
});
