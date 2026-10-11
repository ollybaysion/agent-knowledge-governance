import { test } from "node:test";
import assert from "node:assert/strict";

import { searchDocs } from "../../public/search.mjs";

const order = ["db-schema", "domain-skill", "screen-map", "manual"];
const docs = [
  { type: "db-schema", id: "fdc_sensor", keywords: [{ kw: "fdc_sensor" }, { kw: "센서" }], title: "FDC_SENSOR" },
  { type: "db-schema", id: "fdc_equipment", keywords: [{ kw: "fdc_equipment" }], title: "FDC_EQUIPMENT" },
  { type: "domain-skill", id: "fdc-explain-sensor-origin", keywords: [{ kw: "fdc-explain-sensor-origin" }], title: "fdc-explain-sensor-origin" },
  { type: "screen-map", id: "spc-chart-config", keywords: [{ kw: "spc-chart-config" }], title: "차트 관리" },
  { type: "manual", id: "spc-chart-limit-setup", keywords: [{ kw: "spc limit" }], title: "SPC 관리 한계 설정" },
];
const ids = (groups) => groups.map((g) => [g.type, g.docs.map((d) => d.id)]);

test("a term matches id, keyword or title, case-insensitively, grouped by type in the given order", () => {
  assert.deepEqual(ids(searchDocs(docs, { q: "SENSOR", order })), [
    ["db-schema", ["fdc_sensor"]],
    ["domain-skill", ["fdc-explain-sensor-origin"]],
  ]);
  assert.deepEqual(ids(searchDocs(docs, { q: "관리", order })), [
    ["screen-map", ["spc-chart-config"]],
    ["manual", ["spc-chart-limit-setup"]],
  ]);
  assert.deepEqual(ids(searchDocs(docs, { q: "센서", order })), [["db-schema", ["fdc_sensor"]]]);
});

test("every term must match; type chips narrow, and alone list the whole type", () => {
  assert.deepEqual(ids(searchDocs(docs, { q: "spc 한계", order })), [["manual", ["spc-chart-limit-setup"]]]);
  assert.deepEqual(ids(searchDocs(docs, { q: "spc", types: ["screen-map"], order })), [
    ["screen-map", ["spc-chart-config"]],
  ]);
  assert.deepEqual(ids(searchDocs(docs, { types: ["db-schema"], order })), [
    ["db-schema", ["fdc_equipment", "fdc_sensor"]],
  ]);
});

test("an empty query with no chip, or no hit, gives no groups", () => {
  assert.deepEqual(searchDocs(docs, { q: "  ", order }), []);
  assert.deepEqual(searchDocs(docs, { q: "nothing-like-this", order }), []);
});
