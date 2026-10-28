import { test } from "node:test";
import assert from "node:assert/strict";

import { TAGS_MAX, TAG_RE, addTag, tagRows, withTag } from "../../public/lib/tags.mjs";
import { tagGroups, typeRows } from "../../public/lib/miller.mjs";
import { TAGS_MAX as ENVELOPE_MAX, TAG_PATTERN } from "../../src/envelope.mjs";

test("the screen's tag rule is the envelope's", () => {
  assert.equal(TAG_RE.source, TAG_PATTERN);
  assert.equal(TAGS_MAX, ENVELOPE_MAX);
});

test("addTag: a typed tag is trimmed and lower-cased; one already there changes nothing; a bad one or the 21st is refused", () => {
  assert.deepEqual(addTag([], "  Sensor "), { tags: ["sensor"] });
  const tags = ["sensor"];
  assert.equal(addTag(tags, "sensor").tags, tags);
  assert.match(addTag([], "두 단어").error, /소문자/);
  assert.match(addTag([], "a b").error, /소문자/);
  assert.match(addTag([], "").error, /1~32/);
  assert.match(addTag([], "x".repeat(33)).error, /1~32/);
  const full = Array.from({ length: 20 }, (_, i) => `t${i}`);
  assert.match(addTag(full, "one-more").error, /20 개까지/);
});

test("tagRows: the most used first, then by name; the search keeps the names that hold it", () => {
  const counts = { spc: 2, sensor: 5, "2026": 1, eqp: 2 };
  assert.deepEqual(tagRows(counts).map((r) => `${r.tag}:${r.count}`), ["sensor:5", "eqp:2", "spc:2", "2026:1"]);
  assert.deepEqual(tagRows(counts, " S").map((r) => r.tag), ["sensor", "spc"]);
  assert.deepEqual(tagRows(null), []);
});

const TYPES = [
  { id: "db-schema", label: "DB 스키마", color: "#1", status: "active" },
  { id: "domain-skill", label: "도메인 스킬", color: "#2", status: "active" },
  { id: "voc", label: "VOC", color: "#3", status: "active" },
];
const DOCS = [
  { type: "db-schema", id: "fdc_sensor", tags: ["sensor"], updatedAt: "2026-10-25" },
  { type: "db-schema", id: "fdc_alarm", tags: ["sensor", "spc"], updatedAt: "2026-10-27" },
  { type: "db-schema", id: "fdc_equipment", updatedAt: "2026-10-28" },
  { type: "domain-skill", id: "explain", role: "main", tags: ["sensor"], updatedAt: "2026-10-27" },
  { type: "domain-skill", id: "formula", role: "sub", tags: ["sensor"], updatedAt: "2026-10-26" },
  { type: "voc", id: "v1", tags: ["spc"] },
];

test("tagGroups: the tag's documents across the types, in the type order, the last changed first; agents in their own group", () => {
  const groups = tagGroups(TYPES, DOCS, "sensor");
  assert.deepEqual(
    groups.map((g) => [g.label, g.rows.map((d) => d.id)]),
    [
      ["DB 스키마", ["fdc_alarm", "fdc_sensor"]],
      ["도메인 스킬", ["formula"]],
      ["에이전트", ["explain"]],
    ],
  );
  assert.deepEqual(tagGroups(TYPES, DOCS, "none"), []);
});

test("with a tag picked the types count its documents; a type without one counts 0", () => {
  const rows = typeRows(TYPES, withTag(DOCS, "spc"));
  assert.deepEqual(rows.map((t) => `${t.id}:${t.count}`), ["db-schema:1", "voc:1"]);
  assert.deepEqual(typeRows(TYPES, withTag(DOCS, "sensor")).map((t) => `${t.id}:${t.count}`), ["db-schema:2", "domain-skill:1", "voc:0"]);
});
