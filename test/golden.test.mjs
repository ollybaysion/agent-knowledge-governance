// Phase 0 acceptance (design §9.2): three golden round trips —
//   1. FDC md -> JSON -> md byte-identical (the 4 real db-schema docs)
//   2. foundry spec render byte-identical (domain-skill, akg's target state)
//   3. msg-format template example round trip (synthetic, 0 real instances)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas, validateDocument } from "../src/envelope.mjs";
import { renderDbSchemaMd } from "../src/render/db-schema.mjs";
import { migrateDbSchemaMd } from "../src/migrate/db-schema.mjs";
import { renderMsgFormatMd } from "../src/render/msg-format.mjs";
import { migrateMsgFormatMd } from "../src/migrate/msg-format.mjs";
import { renderDomainSkillMd } from "../src/render/domain-skill.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(__dirname, "..", "golden");
const refs = loadSchemas(join(__dirname, "..", "schemas"));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonIds(dir) {
  return readdirSync(join(GOLDEN, dir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

test("db-schema golden: schema-valid + render(json) === md", () => {
  for (const id of jsonIds("db-schema")) {
    const doc = readJson(join(GOLDEN, "db-schema", `${id}.json`));
    const md = readFileSync(join(GOLDEN, "db-schema", `${id}.md`), "utf8");
    assert.deepEqual(validateDocument(doc, refs), [], `${id}: schema errors`);
    assert.equal(renderDbSchemaMd(doc), md, `${id}: render(json) !== md`);
  }
});

test("db-schema golden: render(migrate(md)) === md (§9.1 acceptance)", () => {
  for (const id of jsonIds("db-schema")) {
    const md = readFileSync(join(GOLDEN, "db-schema", `${id}.md`), "utf8");
    const doc = readJson(join(GOLDEN, "db-schema", `${id}.json`));
    const { doc: migrated, warnings } = migrateDbSchemaMd(md, {
      fetchedAt: doc.body.catalog.fetchedAt,
    });
    assert.equal(
      warnings.length,
      0,
      `${id}: unexpected migrate warnings: ${warnings}`,
    );
    assert.equal(
      renderDbSchemaMd(migrated),
      md,
      `${id}: render(migrate(md)) !== md`,
    );
    // the stored golden JSON is itself migrate()'s output (§9.1 fixture
    // provenance) — migrate is deterministic, so re-running it must match.
    assert.deepEqual(
      migrated,
      doc,
      `${id}: migrate(md) !== stored golden JSON`,
    );
  }
});

test("db-schema migrate: reports the deprecated 마이그레이션 주의 section instead of dropping it silently", () => {
  // The real FDC files (outside this repo, at ~/.claude/docs/db) still carry
  // the section a pre-#109 renderer emitted. We only ship the truncated
  // golden md here, so simulate the untruncated shape inline.
  const md =
    readFileSync(join(GOLDEN, "db-schema", "testuser.fdc_sensor.md"), "utf8") +
    "\n\n## 마이그레이션 주의\n\n<!-- dbdoc:manual:migration -->\n{{선택 — 변경 이력, 함부로 바꾸면 안 되는 컬럼과 이유}}\n<!-- dbdoc:end:migration -->\n";
  const { warnings } = migrateDbSchemaMd(md, {
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /마이그레이션 주의/);
});

test("domain-skill golden: schema-valid + render(spec) === SKILL.md byte-identical", () => {
  const doc = readJson(join(GOLDEN, "domain-skill", "fdc-explain-sensor.json"));
  const md = readFileSync(
    join(GOLDEN, "domain-skill", "fdc-explain-sensor.md"),
    "utf8",
  );
  assert.deepEqual(validateDocument(doc, refs), []);
  assert.equal(renderDomainSkillMd(doc), md);
});

test("domain-skill golden: h1Title is rejected (format owner is akg now, json-spec §4.4)", () => {
  const doc = readJson(join(GOLDEN, "domain-skill", "fdc-explain-sensor.json"));
  const withH1Title = {
    ...doc,
    body: { ...doc.body, h1Title: "센서 설명 절차" },
  };
  const errors = validateDocument(withH1Title, refs);
  assert.ok(
    errors.some((e) => e.includes("h1Title")),
    `expected an h1Title rejection, got: ${errors}`,
  );
});

test("msg-format golden: schema-valid + render(json) === md", () => {
  const doc = readJson(join(GOLDEN, "msg-format", "cmd-start-lot.json"));
  const md = readFileSync(
    join(GOLDEN, "msg-format", "cmd-start-lot.md"),
    "utf8",
  );
  assert.deepEqual(validateDocument(doc, refs), []);
  assert.equal(renderMsgFormatMd(doc), md);
});

test("msg-format golden: render(migrate(md)) === md (템플릿 예제 왕복)", () => {
  const md = readFileSync(
    join(GOLDEN, "msg-format", "cmd-start-lot.md"),
    "utf8",
  );
  const migrated = migrateMsgFormatMd(md);
  assert.equal(renderMsgFormatMd(migrated), md);
  assert.deepEqual(validateDocument(migrated, refs), []);
});
