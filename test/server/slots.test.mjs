import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas } from "../../src/envelope.mjs";
import {
  listSlotAddresses,
  getSlot,
  setSlot,
  diffSlots,
  hasNoSlots,
} from "../../server/slots.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "..", "schemas"));

function dbSchemaBody() {
  return {
    owner: "T",
    table: "X",
    catalog: {
      columns: [
        { name: "A", type: "NUMBER", nullable: false },
        { name: "B", type: "VARCHAR2(1)", nullable: true },
      ],
      primaryKey: ["A"],
      fetchedAt: "2026-01-01T00:00:00Z",
    },
    purpose: { text: "목적", tier: "confirmed", evidence: ["e:1"] },
    columnDescs: {
      A: { text: null, tier: "scaffold" },
      B: { text: "B 설명", tier: "inferred", evidence: ["e:2"] },
    },
    queries: [
      {
        sql: "SELECT 1",
        note: { text: "노트", tier: "inferred", evidence: ["e:3"] },
      },
    ],
  };
}

test("listSlotAddresses finds purpose, map-keyed columnDescs.*, and array-indexed queries[N].note — but not catalog fields", () => {
  const addrs = listSlotAddresses(refs["db-schema/v1"], dbSchemaBody()).sort();
  assert.deepEqual(
    addrs,
    ["columnDescs.A", "columnDescs.B", "purpose", "queries[0].note"].sort(),
  );
});

test("msg-format: fields[N].desc addresses", () => {
  const body = {
    command: "CMD_X",
    direction: "host->equipment",
    purpose: { text: null, tier: "scaffold" },
    fields: [
      {
        seq: 1,
        name: "A",
        type: "string",
        required: true,
        desc: { text: null, tier: "scaffold" },
      },
      {
        seq: 2,
        name: "B",
        type: "string",
        required: true,
        desc: { text: null, tier: "scaffold" },
      },
    ],
  };
  const addrs = listSlotAddresses(refs["msg-format/v1"], body).sort();
  assert.deepEqual(addrs, ["fields[0].desc", "fields[1].desc", "purpose"]);
});

test("domain-skill has zero slots (basis-string exception, json-spec §1.2)", () => {
  const body = {
    name: "x",
    argumentHint: "{id}",
    description: "설명.",
    steps: [{ title: "s", sql: "SELECT 1" }],
    valueRules: [{ target: "A", rule: "B", basis: "scaffold" }],
    output: { lead: "l", template: "t" },
  };
  assert.equal(hasNoSlots(refs["domain-skill/v1"], body), true);
});

test("getSlot/setSlot round-trip through a map-keyed and an array-indexed address", () => {
  const body = dbSchemaBody();
  assert.deepEqual(getSlot(body, "columnDescs.B"), {
    text: "B 설명",
    tier: "inferred",
    evidence: ["e:2"],
  });
  assert.deepEqual(getSlot(body, "queries[0].note").text, "노트");
  setSlot(body, "columnDescs.B", {
    text: "새 설명",
    tier: "confirmed",
    evidence: ["e:2"],
  });
  assert.equal(body.columnDescs.B.text, "새 설명");
});

test("diffSlots reports only the addresses whose tiered-value actually changed", () => {
  const a = dbSchemaBody();
  const b = dbSchemaBody();
  b.columnDescs.A = { text: "채워짐", tier: "inferred", evidence: ["e:9"] };
  assert.deepEqual(
    diffSlots(refs["db-schema/v1"], a, b),
    new Set(["columnDescs.A"]),
  );
});

test("diffSlots treats a slot present in only one version (new column) as changed", () => {
  const a = dbSchemaBody();
  const b = dbSchemaBody();
  b.catalog.columns.push({ name: "C", type: "NUMBER", nullable: true });
  b.columnDescs.C = { text: null, tier: "scaffold" };
  assert.deepEqual(
    diffSlots(refs["db-schema/v1"], a, b),
    new Set(["columnDescs.C"]),
  );
});

test("diffSlots is empty for two identical bodies", () => {
  assert.deepEqual(
    diffSlots(refs["db-schema/v1"], dbSchemaBody(), dbSchemaBody()),
    new Set(),
  );
});
