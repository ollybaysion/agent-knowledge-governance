import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWikilinks, wikiSegments, wikiTexts } from "../src/wikilinks.mjs";

test("both forms: [[id]] leaves the type open, [[type/id]] names it", () => {
  assert.deepEqual(parseWikilinks("화면은 [[spc-chart-config]], 표는 [[db-schema/fdc_sensor]]."), [
    { text: "spc-chart-config", type: null, id: "spc-chart-config" },
    { text: "db-schema/fdc_sensor", type: "db-schema", id: "fdc_sensor" },
  ]);
});

test("a [[ ]] inside a fenced block is text; one that cannot be an id has no target", () => {
  const md = "앞 [[a]]\n```sql\nSELECT '[[b]]'\n```\n~~~\n[[c]]\n~~~\n뒤 [[Not An Id]]";
  assert.deepEqual(parseWikilinks(md), [
    { text: "a", type: null, id: "a" },
    { text: "Not An Id", type: null, id: null },
  ]);
});

test("the same [[ ]] twice, across texts too, is one entry", () => {
  assert.deepEqual(parseWikilinks(["[[a]] 그리고 [[a]]", "[[ a ]] [[b]]"]).map((l) => l.text), ["a", "b"]);
});

test("segments give the text back unchanged when joined", () => {
  const md = "x [[a]] y\n```\n[[b]]\n```\nz [[c/d]]";
  const segs = wikiSegments(md);
  assert.equal(segs.map((s) => s.text).join(""), md);
  assert.deepEqual(segs.filter((s) => s.link).map((s) => s.link.text), ["a", "c/d"]);
});

test("the texts read: a skill's and an md type's markdown, a manual's step texts, nothing else", () => {
  assert.deepEqual(wikiTexts("domain-skill", { markdown: "m" }), ["m"]);
  assert.deepEqual(wikiTexts("meeting-notes", { name: "w", markdown: "m" }), ["m"]);
  assert.deepEqual(wikiTexts("manual", { steps: [{ text: "s1" }, { text: "s2" }] }), ["s1", "s2"]);
  assert.deepEqual(wikiTexts("db-schema", { table: "X" }), []);
});

test("db-schema: purpose, every column desc and query notes are read; null and the collector's comments are not", () => {
  const body = {
    table: "X",
    catalog: {
      columns: [{ name: "A", type: "NUMBER", nullable: false, comment: "[[from-comment]]" }],
      tableComment: "[[from-table-comment]]",
    },
    purpose: { text: "p [[a]]", tier: "inferred" },
    columnDescs: { A: { text: "c1\n[[b]]", tier: "inferred" }, B: { text: null, tier: "scaffold" }, C: { text: "c3", tier: "confirmed" } },
    queries: [{ sql: "SELECT 1", note: { text: "q [[c]]", tier: "inferred" } }, { sql: "SELECT 2", note: { text: null, tier: "scaffold" } }],
  };
  assert.deepEqual(wikiTexts("db-schema", body), ["p [[a]]", "c1\n[[b]]", "c3", "q [[c]]"]);
  assert.deepEqual(parseWikilinks(wikiTexts("db-schema", body)).map((l) => l.text), ["a", "b", "c"]);
  assert.deepEqual(wikiTexts("db-schema", { purpose: { text: null }, columnDescs: { A: null }, queries: "x" }), []);
});

test("a type id may carry digits: [[notes2/a]]", () => {
  assert.deepEqual(parseWikilinks("[[notes2/a]]"), [{ text: "notes2/a", type: "notes2", id: "a" }]);
});
