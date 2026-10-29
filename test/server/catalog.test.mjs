// The catalog (server/catalog.mjs) changes with each commit and only then: a
// catalog kept through a run of commits equals one read fresh from the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSchemas } from "../../src/envelope.mjs";
import { createCatalog } from "../../server/catalog.mjs";
import { commitFiles, initStore } from "../../server/store.mjs";
import { createTypes } from "../../server/types.mjs";

const EXAMPLES = new URL("../../examples/", import.meta.url);
const example = (p) => JSON.parse(readFileSync(new URL(p, EXAMPLES), "utf8"));
const json = (doc) => JSON.stringify(doc, null, 2) + "\n";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "akg-catalog-test-"));
  initStore(dir);
  const types = createTypes(dir, loadSchemas());
  return { dir, types, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const write = (dir, message, writes, removes = []) =>
  commitFiles(dir, {
    author: "renoir",
    message,
    writes: Object.entries(writes).map(([relpath, doc]) => ({ relpath, content: typeof doc === "string" ? doc : json(doc) })),
    removes,
  });

// Every type's projections, in order.
function snapshot(catalog, types) {
  return Object.fromEntries(types.ids().map((t) => [t, catalog.entries(t)]));
}

function freshSnapshot(dir, types) {
  const fresh = createCatalog(dir, types);
  try {
    fresh.load();
    return snapshot(fresh, types);
  } finally {
    fresh.close();
  }
}

test("the catalog kept through create, edit, sidecar, link and delete commits equals one read fresh", async () => {
  const { dir, types, done } = setup();
  const live = createCatalog(dir, types);
  live.load();
  const sensor = example("db-schema/fdc_sensor.json");
  const chamber = example("db-schema/fdc_chamber.json");
  const skill = example("domain-skill/fdc-explain-sensor-origin.json");

  await write(dir, "create", { "db-schema/fdc_sensor.json": sensor, "domain-skill/fdc-explain-sensor-origin.json": skill });
  assert.deepEqual(snapshot(live, types), freshSnapshot(dir, types));
  assert.equal(live.get("db-schema", "fdc_sensor").title, "FDC_SENSOR");

  await write(dir, "link", {
    "db-schema/fdc_chamber.json": { ...chamber, tags: ["etch"], links: [{ type: "db-schema", id: "fdc_sensor", rel: "related" }] },
  });
  assert.deepEqual(live.linkers(types.ids(), "db-schema", "fdc_sensor"), [["db-schema", "fdc_chamber"]]);
  assert.deepEqual(snapshot(live, types), freshSnapshot(dir, types));

  await write(dir, "archive", { "db-schema/fdc_sensor.json": { ...sensor, status: "archived" } });
  assert.equal(live.count("db-schema"), 1);
  await write(dir, "mark", { "db-schema/fdc_chamber.meta.json": { absorbed: { rev: "a".repeat(40), at: "2026-10-01T00:00:00Z", by: "kim" } } });
  assert.equal(live.get("db-schema", "fdc_chamber").absorbed.by, "kim");
  assert.deepEqual(snapshot(live, types), freshSnapshot(dir, types));

  await write(dir, "unlink", { "db-schema/fdc_chamber.json": chamber });
  assert.deepEqual(live.linkers(types.ids(), "db-schema", "fdc_sensor"), []);
  await write(dir, "delete", {}, ["db-schema/fdc_sensor.json", "db-schema/fdc_chamber.meta.json"]);
  assert.equal(live.get("db-schema", "fdc_sensor"), null);
  assert.equal(live.get("db-schema", "fdc_chamber").absorbed, undefined);
  assert.deepEqual(snapshot(live, types), freshSnapshot(dir, types));
  live.close();
  done();
});

test("a commit git refuses leaves the catalog and the file as they were", async () => {
  const { dir, types, done } = setup();
  const sensor = example("db-schema/fdc_sensor.json");
  await write(dir, "seed", { "db-schema/fdc_sensor.json": sensor });
  const live = createCatalog(dir, types);
  live.load();
  const before = snapshot(live, types);
  const hook = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);

  await assert.rejects(() =>
    write(dir, "refused", { "db-schema/fdc_sensor.json": { ...sensor, status: "archived" }, "db-schema/new_one.json": sensor }),
  );
  assert.deepEqual(snapshot(live, types), before);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "db-schema/fdc_sensor.json"), "utf8")), sensor);
  assert.deepEqual(freshSnapshot(dir, types), before);
  live.close();
  done();
});

test("while a commit runs the catalog still holds the document as it was before", async () => {
  const { dir, types, done } = setup();
  const sensor = example("db-schema/fdc_sensor.json");
  await write(dir, "seed", { "db-schema/fdc_sensor.json": sensor });
  const live = createCatalog(dir, types);
  live.load();

  const running = write(dir, "archive", { "db-schema/fdc_sensor.json": { ...sensor, status: "archived" }, "db-schema/fdc_new.json": sensor });
  // The files are written by now; git has not finished.
  assert.equal(live.get("db-schema", "fdc_sensor").status, "active");
  assert.deepEqual(live.ids("db-schema"), ["fdc_sensor"]);
  await running;
  assert.equal(live.get("db-schema", "fdc_sensor").status, "archived");
  assert.deepEqual(live.ids("db-schema"), ["fdc_new", "fdc_sensor"]);
  live.close();
  done();
});

test("ids keep listIds order: by file name, so a-b comes before a", async () => {
  const { dir, types, done } = setup();
  const sensor = example("db-schema/fdc_sensor.json");
  await write(dir, "seed", { "db-schema/a.json": { ...sensor, id: "a" }, "db-schema/a-b.json": { ...sensor, id: "a-b" } });
  const live = createCatalog(dir, types);
  live.load();
  assert.deepEqual(live.ids("db-schema"), ["a-b", "a"]);
  live.close();
  done();
});
