import { test } from "node:test";
import assert from "node:assert/strict";

import { coverageText, kindOf, majorCoverage, readFilter, tableGroups, userCount } from "../../public/lib/table-class.mjs";

const cov = (confirmed, total) => ({ confirmed, total, ratio: total ? confirmed / total : 0 });
const ROWS = [
  { type: "db-schema", id: "c", major: false, kind: "data", coverage: cov(1, 4) },
  { type: "db-schema", id: "a", major: true, kind: "info", coverage: cov(5, 10), usedBy: [{ type: "domain-skill", id: "s1", query: "q1" }, { type: "domain-skill", id: "s1", query: "q2" }] },
  { type: "db-schema", id: "d", major: false, coverage: cov(0, 3) },
  { type: "db-schema", id: "b", major: true, kind: "data", coverage: cov(0, 8), usedBy: [{ type: "domain-skill", id: "s1", query: "q3" }, { type: "domain", id: "dm", query: "q4" }] },
];
const ids = (groups) => groups.map((g) => [g.key, g.rows.map((r) => r.id)]);

test("tableGroups: 주요 then 기타, each in the order given", () => {
  assert.deepEqual(ids(tableGroups(ROWS)), [
    ["major", ["a", "b"]],
    ["other", ["c", "d"]],
  ]);
});

test("tableGroups: the 중요도 filter keeps one group, the 성격 filter keeps the rows of that kind; 미정 = no kind", () => {
  assert.deepEqual(ids(tableGroups(ROWS, { major: "other", kind: "all" })), [["other", ["c", "d"]]]);
  assert.deepEqual(ids(tableGroups(ROWS, { major: "all", kind: "data" })), [
    ["major", ["b"]],
    ["other", ["c"]],
  ]);
  assert.deepEqual(ids(tableGroups(ROWS, { major: "all", kind: "none" })), [["other", ["d"]]]);
  assert.deepEqual(ids(tableGroups(ROWS, { major: "major", kind: "none" })), []);
});

test("readFilter: the stored filter back; anything unknown or unreadable is 전체", () => {
  assert.deepEqual(readFilter('{"major":"major","kind":"info"}'), { major: "major", kind: "info" });
  assert.deepEqual(readFilter('{"major":"x","kind":"none"}'), { major: "all", kind: "none" });
  assert.deepEqual(readFilter(null), { major: "all", kind: "all" });
  assert.deepEqual(readFilter("{nope"), { major: "all", kind: "all" });
});

test("kindOf: info · data as stored, anything else 미정", () => {
  assert.equal(kindOf({ kind: "info" }), "info");
  assert.equal(kindOf({ kind: "other" }), "none");
  assert.equal(kindOf(undefined), "none");
});

test("majorCoverage: the 주요 tables only, the sum of their slots, the lowest coverage first", () => {
  const m = majorCoverage([...ROWS, { type: "msg-format", id: "z", major: true, coverage: cov(0, 9) }]);
  assert.deepEqual(m.rows.map((r) => r.id), ["b", "a"]);
  assert.equal(m.confirmed, 5);
  assert.equal(m.total, 18);
  assert.deepEqual(majorCoverage([]), { confirmed: 0, total: 0, ratio: 0, rows: [] });
});

test("coverageText · userCount: 확정 n/m, and the distinct documents among usedBy", () => {
  assert.equal(coverageText(cov(12, 40)), "확정 12/40");
  assert.equal(userCount(ROWS[1]), 1);
  assert.equal(userCount(ROWS[3]), 2);
  assert.equal(userCount(ROWS[0]), 0);
});
