import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inferredColumns,
  slotFailText,
  TIER_FILTERS,
  tierCounts,
  tierShown,
  togglePick,
  withObject,
} from "../../public/lib/column-bulk.mjs";

const slot = (address, tier) => ({ address, tier });

test("TIER_FILTERS: 전체 · 빈칸 · 추정 · 확정, left to right", () => {
  assert.deepEqual(
    TIER_FILTERS.map(([, label]) => label),
    ["전체", "빈칸", "추정", "확정"],
  );
});

test("tierShown: 전체 keeps every row; a tier keeps its own rows; a row without a slot is 전체 only", () => {
  const inf = slot("columnDescs.A", "inferred");
  const dep = slot("columnDescs.B", "deprecated");
  assert.equal(tierShown("all", inf), true);
  assert.equal(tierShown("all", undefined), true);
  assert.equal(tierShown("inferred", inf), true);
  assert.equal(tierShown("confirmed", inf), false);
  assert.equal(tierShown("scaffold", undefined), false);
  assert.equal(tierShown("all", dep), true);
  assert.equal(tierShown("inferred", dep), false);
});

test("tierCounts: rows per chip; a deprecated row and a row without a slot count in 전체 only", () => {
  const rows = [
    slot("columnDescs.A", "inferred"),
    slot("columnDescs.B", "inferred"),
    slot("columnDescs.C", "confirmed"),
    slot("columnDescs.D", "scaffold"),
    slot("columnDescs.E", "deprecated"),
    undefined,
  ];
  assert.deepEqual(tierCounts(rows), {
    all: 6,
    scaffold: 1,
    inferred: 2,
    confirmed: 1,
  });
  assert.deepEqual(tierCounts(undefined), {
    all: 0,
    scaffold: 0,
    inferred: 0,
    confirmed: 0,
  });
});

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
