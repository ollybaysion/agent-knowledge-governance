// A domain-skill's or domain document's `## 데이터` item ids and its flow
// fence's subgraph ids are names the consumer looks up across every stored
// skill (active or inactive; archived ones are out), so one may not sit in two,
// and a subgraph id may not be another skill's name.
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

/** A skill with a sql item per id; `sub` puts the first item in that subgraph of a flow fence. */
function skill(name, ids, status = "active", sub = null) {
  const items = ids.map((id) => `### ${id} — 조회\n\n\`\`\`sql\nSELECT k FROM t WHERE k = 1\n\`\`\``).join("\n\n");
  const fence = sub ? `\`\`\`mermaid\nflowchart TD\n  subgraph ${sub} [묶음]\n    ${ids[0]}\n  end\n\`\`\`\n\n` : "";
  return {
    schema: "domain-skill/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status,
    body: { name, markdown: `# ${name}\n\n## 데이터\n\n${fence}${items}\n` },
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
    assert.deepEqual(r.json(), { error: "data_id_conflict", conflicts: [{ id: "snsr_id", doc: "a", kind: "data" }] });
    const got = await app.inject({ headers: as("reader"), method: "GET", url: "/api/docs/domain-skill/b" });
    assert.equal(got.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("POST: a subgraph id clashes with another skill's data id, subgraph id and name; a skill's name with another's subgraph id", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await post(app, skill("a", ["trace"], "active", "pick"))).statusCode, 201);
    const subVsSub = await post(app, skill("b", ["events"], "active", "pick"));
    assert.equal(subVsSub.statusCode, 409, subVsSub.body);
    assert.deepEqual(subVsSub.json().conflicts, [{ id: "pick", doc: "a", kind: "subgraph" }]);
    const subVsData = await post(app, skill("b", ["events"], "active", "trace"));
    assert.deepEqual(subVsData.json().conflicts, [{ id: "trace", doc: "a", kind: "data" }]);
    const subVsName = await post(app, skill("b", ["events"], "active", "a"));
    assert.deepEqual(subVsName.json().conflicts, [{ id: "a", doc: "a", kind: "md" }]);
    const dataVsSub = await post(app, skill("b", ["pick"]));
    assert.deepEqual(dataVsSub.json().conflicts, [{ id: "pick", doc: "a", kind: "subgraph" }]);
    const nameVsSub = await post(app, skill("pick", ["events"]));
    assert.equal(nameVsSub.statusCode, 409, nameVsSub.body);
    assert.deepEqual(nameVsSub.json().conflicts, [{ id: "pick", doc: "a", kind: "subgraph" }]);
    assert.equal((await post(app, skill("b", ["events"], "active", "pick_b"))).statusCode, 201);
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
      assert.deepEqual(r.json().conflicts, [{ id: "snsr_id", doc: "a", kind: "data" }]);
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

test("POST: a deleted skill's ids are free again", async () => {
  const { app, cleanup } = await setup();
  try {
    const { rev } = (await post(app, skill("a", ["snsr_id"]))).json();
    const del = await app.inject({ method: "DELETE", url: "/api/docs/domain-skill/a", headers: { ...auth("aptok"), "if-match": rev } });
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
    assert.deepEqual(taken.json(), { error: "data_id_conflict", conflicts: [{ id: "row_b", doc: "b", kind: "data" }] });
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
      conflicts: [{ id: "row", doc: "b", kind: "data", source: "c" }],
    });

    const store = await batch([skill("b", ["snsr_id"])]);
    assert.equal(store.statusCode, 409, store.body);
    assert.deepEqual(store.json().conflicts, [{ id: "snsr_id", doc: "a", kind: "data", source: "b" }]);

    const sub = await batch([skill("b", ["row_b"], "inactive", "pick"), skill("c", ["pick"])]);
    assert.equal(sub.statusCode, 409, sub.body);
    assert.deepEqual(sub.json().conflicts, [{ id: "pick", doc: "b", kind: "subgraph", source: "c" }]);

    const ok = await batch([skill("b", ["row_b"]), skill("c", ["row_c"])]);
    assert.equal(ok.statusCode, 201, ok.body);
  } finally {
    await cleanup();
  }
});

function domain(name, ids, status = "active") {
  const doc = skill(name, ids, status);
  return {
    ...doc,
    schema: "domain/v1",
    body: { name, markdown: doc.body.markdown.replace("## 데이터", "## 도메인 지식\n\n글\n\n## 데이터") },
  };
}
const postDomain = (app, doc) =>
  app.inject({ method: "POST", url: "/api/docs/domain", headers: auth("edtok"), payload: doc });

test("domain-skill and domain share the data ids: a query id in one type is 409 in the other, both ways", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await postDomain(app, domain("k", ["snsr_id"]))).statusCode, 201);
    const fromSkill = await post(app, skill("a", ["snsr_id"]));
    assert.equal(fromSkill.statusCode, 409, fromSkill.body);
    assert.deepEqual(fromSkill.json().conflicts, [{ id: "snsr_id", doc: "k", kind: "data" }]);
    assert.equal((await post(app, skill("a", ["row_a"]))).statusCode, 201);
    const fromDomain = await postDomain(app, domain("j", ["row_a"], "inactive"));
    assert.equal(fromDomain.statusCode, 409, fromDomain.body);
    assert.deepEqual(fromDomain.json().conflicts, [{ id: "row_a", doc: "a", kind: "data" }]);
  } finally {
    await cleanup();
  }
});

test("PUT: a domain document's own ids are not a conflict; a domain-skill of the same id is another document", async () => {
  const { app, cleanup } = await setup();
  try {
    await postDomain(app, domain("a", ["snsr_id"]));
    await post(app, skill("a", ["row_a"]));
    const put = async (type, doc) => {
      const url = `/api/docs/${type}/a`;
      const { rev } = (await app.inject({ headers: as("reader"), method: "GET", url })).json();
      return app.inject({ method: "PUT", url, headers: { ...auth("edtok"), "if-match": rev }, payload: doc.body });
    };
    const same = await put("domain", domain("a", ["snsr_id", "extra"]));
    assert.equal(same.statusCode, 200, same.body);
    const taken = await put("domain-skill", skill("a", ["row_a", "snsr_id"]));
    assert.equal(taken.statusCode, 409, taken.body);
    assert.deepEqual(taken.json().conflicts, [{ id: "snsr_id", doc: "a", kind: "data" }]);
  } finally {
    await cleanup();
  }
});
