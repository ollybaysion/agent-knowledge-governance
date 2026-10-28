import { test } from "node:test";
import assert from "node:assert/strict";

import { slotFailText, togglePick } from "../../public/lib/column-bulk.mjs";

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
