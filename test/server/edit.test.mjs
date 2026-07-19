import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas } from "../../src/envelope.mjs";
import { applyEdit, EditError } from "../../server/edit.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "..", "schemas"));
const schema = refs["db-schema/v1"];
const NOW = "2026-07-20T00:00:00Z";

function baseBody() {
  return {
    owner: "T",
    table: "X",
    catalog: {
      columns: [{ name: "A", type: "NUMBER", nullable: false }],
      primaryKey: ["A"],
      fetchedAt: "2026-01-01T00:00:00Z",
    },
    purpose: {
      text: "확정된 목적",
      tier: "confirmed",
      evidence: ["e:1"],
      by: "promote:x",
      at: "2026-01-01T00:00:00Z",
    },
    columnDescs: { A: { text: null, tier: "scaffold" } },
    queries: [
      {
        sql: "SELECT 1",
        note: { text: "노트", tier: "inferred", evidence: ["e:2"] },
      },
    ],
  };
}

test("re-submitting a slot's text unchanged preserves its confirmed tier/evidence/by/at verbatim", () => {
  const client = baseBody();
  client.purpose = { text: "확정된 목적", tier: "scaffold" }; // client lies about tier — must be ignored
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.deepEqual(merged.purpose, baseBody().purpose);
});

test("changing a confirmed slot's text demotes it to inferred with the new evidence and edit: actor", () => {
  const client = baseBody();
  client.purpose = { text: "새 목적", tier: "confirmed", evidence: ["new:1"] };
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.deepEqual(merged.purpose, {
    text: "새 목적",
    tier: "inferred",
    evidence: ["new:1"],
    by: "edit:renoir",
    at: NOW,
  });
});

test("clearing a slot's text (null) demotes it to scaffold", () => {
  const client = baseBody();
  client.purpose = { text: null, tier: "scaffold" };
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.deepEqual(merged.purpose, { text: null, tier: "scaffold" });
});

test("a changed slot with no evidence is rejected", () => {
  const client = baseBody();
  client.purpose = { text: "새 목적", tier: "confirmed", evidence: [] };
  assert.throws(
    () => applyEdit(schema, baseBody(), client, "renoir", NOW),
    EditError,
  );
});

test("catalog is always taken from the current body — PUT can't smuggle catalog changes (machine-owned)", () => {
  const client = baseBody();
  client.catalog.columns.push({
    name: "SNEAKY",
    type: "NUMBER",
    nullable: true,
  });
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.deepEqual(merged.catalog, baseBody().catalog);
});

test("row rule (§3.1): editing a query row's sql demotes its note even if note.text is unchanged", () => {
  const client = baseBody();
  client.queries[0].sql = "SELECT 1, 2"; // fact field changed, note.text identical
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.equal(merged.queries[0].note.tier, "inferred");
  assert.equal(merged.queries[0].note.by, "edit:renoir");
});

test("a brand new row (no current counterpart) always counts as changed", () => {
  const client = baseBody();
  client.queries.push({
    sql: "SELECT 2",
    note: { text: "새 노트", tier: "confirmed", evidence: ["e:9"] },
  });
  const merged = applyEdit(schema, baseBody(), client, "renoir", NOW);
  assert.equal(merged.queries[1].note.tier, "inferred");
});
