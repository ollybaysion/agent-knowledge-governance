// A domain-skill's `## 데이터` query ids (items with a ```sql fence) are
// procurement keys the consumer looks up across every stored skill (active or
// inactive; archived ones are out), so one may not sit in two skills. A
// question (no sql) is the skill's own and may repeat across skills.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-data-id-"));
  const signedIn = await signIn(home, [
    { id: "ed", group: "admin", token: "edtok" },
    { id: "ap", group: "admin", token: "aptok" },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    auth: signedIn,
  });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const auth = (t) => (as(t));

function skill(name, ids, status = "active", asks = []) {
  const items = [
    ...ids.map((id) => `### ${id} — 조회\n\n\`\`\`sql\nSELECT 1 FROM t WHERE k = :${id}\n\`\`\``),
    ...asks.map((id) => `### ${id} — 물음\n\n어느 ${id}?`),
  ].join("\n\n");
  return {
    schema: "domain-skill/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status,
    body: { name, markdown: `# ${name}\n\n## 데이터\n\n${items}\n` },
  };
}
const post = (app, doc) =>
  app.inject({ method: "POST", url: "/api/docs/domain-skill", headers: auth("edtok"), payload: doc });

test("POST: a data id another skill holds is 409 data_id_conflict naming that skill, and nothing is stored", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, skill("a", ["snsr_id", "row_a"]))).statusCode, 201);
    const r = await post(app, skill("b", ["row_b", "snsr_id"]));
    assert.equal(r.statusCode, 409, r.body);
    assert.deepEqual(r.json(), { error: "data_id_conflict", conflicts: [{ id: "snsr_id", doc: "a" }] });
    const got = await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/b" });
    assert.equal(got.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("POST: a question id may sit in every skill; the same id as a query in either skill is 409", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, skill("a", ["trace"], "active", ["duration", "param_index"]))).statusCode, 201);
    assert.equal((await post(app, skill("b", ["events"], "active", ["duration", "param_index"]))).statusCode, 201);
    const askVsQuery = await post(app, skill("c", ["duration"]));
    assert.equal(askVsQuery.statusCode, 409, askVsQuery.body);
    assert.deepEqual(askVsQuery.json().conflicts, [{ id: "duration", doc: "a" }]);
    const queryVsAsk = await post(app, skill("d", [], "active", ["trace"]));
    assert.equal(queryVsAsk.statusCode, 409, queryVsAsk.body);
    assert.deepEqual(queryVsAsk.json().conflicts, [{ id: "trace", doc: "a" }]);
  } finally {
    await cleanup();
  }
});

test("POST: an inactive skill's ids count, and an inactive draft is refused the same way", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, skill("a", ["snsr_id"], "inactive"))).statusCode, 201);
    for (const status of ["active", "inactive"]) {
      const r = await post(app, skill("b", ["snsr_id"], status));
      assert.equal(r.statusCode, 409, `${status}: ${r.body}`);
      assert.deepEqual(r.json().conflicts, [{ id: "snsr_id", doc: "a" }]);
    }
  } finally {
    await cleanup();
  }
});

test("POST: a malformed or repeated id is 400 validation_failed, for a draft too", async () => {
  const { app, cleanup } = await setup();
  try {
    for (const ids of [["센서"], ["a", "a"]]) {
      const r = await post(app, skill("s", ids, "inactive"));
      assert.equal(r.statusCode, 400, r.body);
      assert.equal(r.json().error, "validation_failed");
    }
  } finally {
    await cleanup();
  }
});

test("POST: an archived skill's ids are free again", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, skill("a", ["snsr_id"]))).statusCode, 201);
    const del = await app.inject({ method: "DELETE", url: "/api/docs/domain-skill/a", headers: auth("aptok") });
    assert.equal(del.statusCode, 200, del.body);
    assert.equal((await post(app, skill("b", ["snsr_id"]))).statusCode, 201);
  } finally {
    await cleanup();
  }
});

test("PUT: the skill's own ids are not a conflict; an id another skill holds is 409", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, skill("a", ["snsr_id"]));
    await post(app, skill("b", ["row_b"]));
    const url = "/api/docs/domain-skill/a";
    const put = async (ids) => {
      const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url })).json();
      return app.inject({
        method: "PUT",
        url,
        headers: { ...auth("edtok"), "if-match": rev },
        payload: skill("a", ids).body,
      });
    };
    const same = await put(["snsr_id", "extra"]);
    assert.equal(same.statusCode, 200, same.body);
    const taken = await put(["snsr_id", "row_b"]);
    assert.equal(taken.statusCode, 409, taken.body);
    assert.deepEqual(taken.json(), { error: "data_id_conflict", conflicts: [{ id: "row_b", doc: "b" }] });
  } finally {
    await cleanup();
  }
});

test("batch POST: ids shared inside the batch or with the store are 409, with the batch doc that carries each", async () => {
  const { app, cleanup } = await setup();
  try {
    await post(app, skill("a", ["snsr_id"]));
    const batch = (docs) =>
      app.inject({ method: "POST", url: "/api/docs/domain-skill/batch", headers: auth("edtok"), payload: { docs } });

    const inside = await batch([skill("b", ["row"]), skill("c", ["row"])]);
    assert.equal(inside.statusCode, 409, inside.body);
    assert.deepEqual(inside.json(), {
      error: "data_id_conflict",
      conflicts: [{ id: "row", doc: "b", source: "c" }],
    });

    const store = await batch([skill("b", ["snsr_id"])]);
    assert.equal(store.statusCode, 409, store.body);
    assert.deepEqual(store.json().conflicts, [{ id: "snsr_id", doc: "a", source: "b" }]);

    const ok = await batch([skill("b", ["row_b"]), skill("c", ["row_c"])]);
    assert.equal(ok.statusCode, 201, ok.body);
  } finally {
    await cleanup();
  }
});
