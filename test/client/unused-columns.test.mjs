import { test } from "node:test";
import assert from "node:assert/strict";

import { isUnused, toggleUnused, unusedSummary } from "../../public/lib/unused-columns.mjs";

test("isUnused: a name in the list is 미사용; no list reads as none", () => {
  assert.equal(isUnused(["A", "B"], "B"), true);
  assert.equal(isUnused(["A"], "B"), false);
  assert.equal(isUnused(undefined, "A"), false);
});

test("toggleUnused: on adds the name once at the end, off takes it out; the input is left alone", () => {
  const list = ["A", "B"];
  assert.deepEqual(toggleUnused(list, "C", true), ["A", "B", "C"]);
  assert.deepEqual(toggleUnused(list, "A", true), ["B", "A"]);
  assert.deepEqual(toggleUnused(list, "A", false), ["B"]);
  assert.deepEqual(toggleUnused(list, "Z", false), ["A", "B"]);
  assert.deepEqual(toggleUnused(undefined, "A", true), ["A"]);
  assert.deepEqual(list, ["A", "B"]);
});

test("unusedSummary: 열 n · 미사용 m over the catalog; a name the catalog lacks is not counted", () => {
  const cols = [{ name: "A" }, { name: "B" }, { name: "C" }];
  assert.equal(unusedSummary(cols, ["B", "GONE"]), "열 3 · 미사용 1");
  assert.equal(unusedSummary(cols, undefined), "열 3 · 미사용 0");
  assert.equal(unusedSummary(undefined, ["A"]), "열 0 · 미사용 0");
});
