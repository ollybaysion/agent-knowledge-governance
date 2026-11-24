import { test } from "node:test";
import assert from "node:assert/strict";

import { FACETS, activeCount, emptyState, facetCounts, filterRows, parseState, sortRows, stateQuery, tableHash, toggleFacet, toggleSort } from "../../public/lib/doc-table.mjs";
import { docFacts } from "../../public/lib/health.mjs";

const NOW = Date.parse("2026-11-24T00:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const DOCS = [
  { type: "db-schema", id: "fdc_alarm", status: "active", title: "FDC_ALARM", updatedAt: ago(3), size: 15000, links: [], keywords: [{ kw: "알람" }] },
  { type: "manual", id: "alarm-guide", status: "active", title: "알람 대응", updatedAt: ago(40), size: 3000, links: [{ type: "db-schema", id: "fdc_alarm", rel: "related" }] },
  { type: "voc", id: "voc-1", status: "inactive", title: "알람 대응", updatedAt: ago(300), size: 120, links: [{ type: "voc", id: "gone", rel: "related" }] },
  { type: "voc", id: "voc-2", status: "active", title: null, updatedAt: null, links: [] },
];
const rows = docFacts(DOCS, NOW);
const ids = (list) => list.map((r) => r.doc.id);
const st = (patch) => ({ ...emptyState(), ...patch });

test("패싯 여섯의 값: 타입 · 상태 · 수정 · 연결 · 크기 · 제목", () => {
  const of = (id, doc) => FACETS.find((f) => f.id === id).of(rows.find((r) => r.doc.id === doc));
  assert.deepEqual(FACETS.map((f) => f.id), ["type", "status", "age", "links", "size", "title"]);
  assert.deepEqual([of("age", "fdc_alarm"), of("age", "alarm-guide"), of("age", "voc-1"), of("age", "voc-2")], [["7"], ["90"], ["old"], []]);
  assert.deepEqual([of("links", "fdc_alarm"), of("links", "voc-1"), of("links", "voc-2")], [["linked"], ["none", "broken"], ["none"]]);
  assert.deepEqual([of("size", "fdc_alarm"), of("size", "alarm-guide"), of("size", "voc-1"), of("size", "voc-2")], [["long"], ["mid"], ["short"], []]);
  assert.deepEqual([of("title", "alarm-guide"), of("title", "voc-2"), of("title", "fdc_alarm")], [["dup"], ["none"], []]);
});

test("거르기: 한 패싯 안은 OR, 패싯끼리는 AND, 찾는 글은 id · 제목 · 키워드", () => {
  assert.deepEqual(ids(filterRows(rows, st({ type: ["voc", "manual"] }))), ["alarm-guide", "voc-1", "voc-2"]);
  assert.deepEqual(ids(filterRows(rows, st({ type: ["voc", "manual"], status: ["active"] }))), ["alarm-guide", "voc-2"]);
  assert.deepEqual(ids(filterRows(rows, st({ links: ["broken"] }))), ["voc-1"]);
  assert.deepEqual(ids(filterRows(rows, st({ q: "알람" }))), ["fdc_alarm", "alarm-guide", "voc-1"]);
  assert.deepEqual(ids(filterRows(rows, st({ q: "알람 GUIDE" }))), ["alarm-guide"]);
  assert.deepEqual(ids(filterRows(rows, emptyState())), ids(rows));
});

test("패싯 수: 그 값을 고르면 남을 문서 수 — 자기 패싯의 고른 값은 빼고 센다", () => {
  const c = facetCounts(rows, st({ type: ["voc"] }));
  assert.deepEqual(Object.fromEntries(c.type), { "db-schema": 1, manual: 1, voc: 2 });
  assert.deepEqual(Object.fromEntries(c.status), { inactive: 1, active: 1 });
  assert.deepEqual(Object.fromEntries(c.links), { none: 2, broken: 1 });
  const both = facetCounts(rows, st({ type: ["voc"], status: ["active"] }));
  assert.deepEqual(Object.fromEntries(both.type), { "db-schema": 1, manual: 1, voc: 1 });
  assert.deepEqual(Object.fromEntries(both.status), { inactive: 1, active: 1 });
});

test("정렬: 열마다 양 방향, 값이 없는 줄은 늘 뒤, 같은 값은 타입/id 순", () => {
  assert.deepEqual(ids(sortRows(rows, "updated", "desc")), ["fdc_alarm", "alarm-guide", "voc-1", "voc-2"]);
  assert.deepEqual(ids(sortRows(rows, "updated", "asc")), ["voc-1", "alarm-guide", "fdc_alarm", "voc-2"]);
  assert.deepEqual(ids(sortRows(rows, "size", "desc")), ["fdc_alarm", "alarm-guide", "voc-1", "voc-2"]);
  assert.deepEqual(ids(sortRows(rows, "size", "asc")), ["voc-1", "alarm-guide", "fdc_alarm", "voc-2"]);
  assert.deepEqual(ids(sortRows(rows, "title", "asc")), ["fdc_alarm", "voc-2", "alarm-guide", "voc-1"]);
  assert.deepEqual(ids(sortRows(rows, "links", "desc")), ["fdc_alarm", "alarm-guide", "voc-1", "voc-2"]);
  assert.deepEqual(ids(sortRows(rows, "status", "asc")), ["fdc_alarm", "alarm-guide", "voc-2", "voc-1"]);
  assert.deepEqual(ids(sortRows(rows, "type", "asc", ["voc", "manual", "db-schema"])), ["voc-1", "voc-2", "alarm-guide", "fdc_alarm"]);
  assert.deepEqual(ids(sortRows(rows, "type", "desc", ["voc", "manual", "db-schema"])), ["fdc_alarm", "alarm-guide", "voc-1", "voc-2"]);
  assert.equal(rows[0].doc.id, "fdc_alarm", "받은 목록은 그대로다");
});

test("보기 상태 ↔ 해시: 기본값은 적지 않고, 읽으면 같은 상태가 된다", () => {
  assert.equal(stateQuery(emptyState()), "");
  assert.equal(tableHash({}), "#/table");
  const state = st({ type: ["voc", "manual"], links: ["none"], q: "알람 대응", sort: "size", dir: "asc" });
  const q = stateQuery(state);
  assert.equal(q, "type=voc,manual&links=none&q=%EC%95%8C%EB%9E%8C%20%EB%8C%80%EC%9D%91&sort=size&dir=asc");
  assert.deepEqual(parseState(q), state);
  assert.equal(stateQuery(st({ sort: "size", dir: "desc" })), "sort=size");
  assert.equal(stateQuery(st({ dir: "asc" })), "sort=updated&dir=asc");
  assert.deepEqual(parseState("?sort=nope&dir=up&type=voc,,voc"), st({ type: ["voc"] }));
  assert.equal(tableHash({ age: ["old"], status: ["active"] }), "#/table?status=active&age=old");
});

test("패싯 켜고 끄기 · 열 머리 누르기 · 고른 수", () => {
  const on = toggleFacet(emptyState(), "type", "voc");
  assert.deepEqual(on.type, ["voc"]);
  assert.deepEqual(toggleFacet(on, "type", "voc").type, []);
  assert.deepEqual([toggleSort(emptyState(), "updated").dir, toggleSort(emptyState(), "title").dir, toggleSort(emptyState(), "size").dir], ["asc", "asc", "desc"]);
  assert.equal(activeCount(st({ type: ["voc", "manual"], q: "x" })), 3);
});
