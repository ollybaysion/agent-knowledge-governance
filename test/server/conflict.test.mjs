import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas } from "../../src/envelope.mjs";
import { resolveConflict } from "../../server/conflict.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "..", "schemas"));
const schema = refs["db-schema/v1"];
const skillSchema = refs["domain-skill/v1"];
const NOW = "2026-07-20T00:00:00Z";

// domain-skill has no tiered-value slots (spec v2), so the whole body is the
// conflict unit — the slot-level rebase would otherwise silently drop the edit.
function skillBody() {
  return JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "examples", "domain-skill", "fdc-explain-sensor.json"),
    ),
  ).body;
}

function baseBody() {
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
      B: { text: null, tier: "scaffold" },
    },
    queries: [],
  };
}

test("non-overlapping slot edits (S6): two accounts edit different columns concurrently -> auto-rebase, no 409", () => {
  const base = baseBody();
  const alice = baseBody();
  alice.columnDescs.A = {
    text: "A 설명",
    tier: "confirmed",
    evidence: ["alice:1"],
  };
  const bob = baseBody();
  bob.columnDescs.B = {
    text: "B 설명",
    tier: "confirmed",
    evidence: ["bob:1"],
  };

  // Alice's write already landed — the store's "current" now reflects it.
  const currentAfterAlice = alice;
  const result = resolveConflict(
    schema,
    base,
    currentAfterAlice,
    bob,
    "bob",
    NOW,
  );

  assert.equal(result.conflict, false);
  assert.equal(result.rebased, true);
  assert.equal(result.mergedBody.columnDescs.A.text, "A 설명"); // alice's change preserved
  assert.equal(result.mergedBody.columnDescs.B.tier, "inferred"); // bob's change demoted, not confirmed
  assert.equal(result.mergedBody.columnDescs.B.text, "B 설명");
});

test("overlapping slot edits (S6): both accounts edit the SAME column concurrently -> 409", () => {
  const base = baseBody();
  const alice = baseBody();
  alice.columnDescs.A = {
    text: "Alice 버전",
    tier: "confirmed",
    evidence: ["alice:1"],
  };
  const bob = baseBody();
  bob.columnDescs.A = {
    text: "Bob 버전",
    tier: "confirmed",
    evidence: ["bob:1"],
  };

  const result = resolveConflict(schema, base, alice, bob, "bob", NOW);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.overlap, ["columnDescs.A"]);
});

test("no-op fast path: current === base (nobody else wrote) -> straightforward apply, not flagged as rebase", () => {
  const base = baseBody();
  const bob = baseBody();
  bob.purpose = { text: "새 목적", tier: "confirmed", evidence: ["bob:1"] };
  const result = resolveConflict(schema, base, base, bob, "bob", NOW);
  assert.equal(result.conflict, false);
  assert.equal(result.rebased, false);
});

test("row rule composes with S6: editing a query's sql and editing its note concurrently is the SAME unit -> 409", () => {
  const base = baseBody();
  base.queries = [
    {
      sql: "SELECT 1",
      note: { text: "노트", tier: "inferred", evidence: ["e:1"] },
    },
  ];
  const alice = structuredClone(base);
  alice.queries[0].sql = "SELECT 1, 2"; // alice only touches the fact field
  const bob = structuredClone(base);
  bob.queries[0].note = {
    text: "새 노트",
    tier: "confirmed",
    evidence: ["bob:1"],
  }; // bob only touches the tiered value

  const result = resolveConflict(schema, base, alice, bob, "bob", NOW);
  assert.equal(
    result.conflict,
    true,
    "sql and note of the same row are one review unit (§3.1)",
  );
  assert.deepEqual(result.overlap, ["queries[0]"]);
});

test("rebase correctly appends a brand-new row the client added while the server touched an unrelated column", () => {
  const base = baseBody();
  const alice = baseBody();
  alice.columnDescs.A = {
    text: "A 설명",
    tier: "confirmed",
    evidence: ["alice:1"],
  };
  const bob = baseBody();
  bob.queries.push({
    sql: "SELECT 2",
    note: { text: "새 쿼리", tier: "confirmed", evidence: ["bob:1"] },
  });

  const result = resolveConflict(schema, base, alice, bob, "bob", NOW);
  assert.equal(result.conflict, false);
  assert.equal(result.mergedBody.queries.length, 1);
  assert.equal(result.mergedBody.queries[0].note.tier, "inferred");
  assert.equal(result.mergedBody.columnDescs.A.text, "A 설명");
});

test("slotless type (domain-skill): stale base whose body the client changed -> 409, never a silent lost update", () => {
  const base = skillBody();
  const current = skillBody();
  current.intro = "서버가 먼저 바꾼 intro"; // someone else already saved onto base
  const client = skillBody();
  client.intro = "클라이언트가 바꾼 intro"; // client edited from the now-stale base
  const result = resolveConflict(skillSchema, base, current, client, "ed", NOW);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.overlap, ["(문서 전체)"]);
});

test("slotless type (domain-skill): fresh rev (base === current) -> not a rebase, route applies the full client body", () => {
  const base = skillBody();
  const client = skillBody();
  client.intro = "편집됨";
  const result = resolveConflict(skillSchema, base, base, client, "ed", NOW);
  assert.equal(result.conflict, false);
  assert.equal(result.rebased, false);
});

test("slotless type (domain-skill): stale base but client already equals current -> harmless no-op, not a conflict", () => {
  const base = skillBody();
  const current = skillBody();
  current.intro = "이미 반영된 값";
  const client = skillBody();
  client.intro = "이미 반영된 값"; // identical to current
  const result = resolveConflict(skillSchema, base, current, client, "ed", NOW);
  assert.equal(result.conflict, false);
  assert.equal(result.rebased, false);
});
