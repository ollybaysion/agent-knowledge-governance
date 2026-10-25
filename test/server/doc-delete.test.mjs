// DELETE /api/docs/:type/:id takes the document out of the store: its JSON,
// its rendered md, its index entry, the links[] entries other documents hold
// to it and a main agent's score record, in one commit. git history keeps it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { readJson } from "../../server/store.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-delete-test-"));
  const signedIn = await signIn(home, [{ id: "renoir", group: "admin", token: "aptok" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth: signedIn });
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as("aptok"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const revOf = async (type, id) => (await call("GET", `/api/docs/${type}/${id}`)).json().rev;
  const del = async (type, id, rev) => call("DELETE", `/api/docs/${type}/${id}`, undefined, { "if-match": rev ?? (await revOf(type, id)) });
  return {
    app,
    storeDir,
    call,
    revOf,
    del,
    lastMessage: () => execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const link = (type, id, rel = "related") => ({ type, id, rel });

function table(name, extra = {}) {
  return {
    schema: "db-schema/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    ...extra,
    body: {
      owner: "T",
      table: name.toUpperCase(),
      catalog: { columns: [{ name: "A", type: "NUMBER", nullable: false }], primaryKey: ["A"], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

function skill(name, markdown, extra = {}) {
  return {
    schema: "domain-skill/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    ...extra,
    body: { name, markdown },
  };
}

test("DELETE removes the JSON, the rendered md and the index entry, in one commit", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("POST", "/api/docs/db-schema", table("x"))).statusCode, 201);
    assert.equal((await t.call("POST", "/api/docs/db-schema", table("y"))).statusCode, 201);
    assert.ok(existsSync(join(t.storeDir, "rendered/db-schema/docs/x.md")));

    const res = await t.del("db-schema", "x");
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().unlinked, []);
    assert.equal(t.lastMessage(), "delete db-schema/x");
    assert.equal(existsSync(join(t.storeDir, "db-schema/x.json")), false);
    assert.equal(existsSync(join(t.storeDir, "rendered/db-schema/docs/x.md")), false);
    assert.deepEqual(readJson(t.storeDir, "rendered/db-schema/index.json").map((e) => e.path), ["docs/y.md"]);
    assert.equal((await t.call("GET", "/api/docs/db-schema/x")).statusCode, 404);
    assert.deepEqual((await t.call("GET", "/api/docs")).json().docs.map((d) => d.id), ["y"]);
  } finally {
    await t.cleanup();
  }
});

test("DELETE a main skill removes its SKILL.md and its score record", async () => {
  const t = await setup();
  try {
    assert.equal((await t.call("POST", "/api/docs/domain-skill", skill("s", "# s\n\n## 도메인 지식\n\n글\n"))).statusCode, 201);
    const line = { kind: "data", text: "q", human: { score: 70 } };
    assert.equal((await t.call("POST", "/api/score/s", { lines: [line] })).statusCode, 201);
    assert.ok(existsSync(join(t.storeDir, "rendered/domain-skill/s/SKILL.md")));
    assert.ok(existsSync(join(t.storeDir, "score/s.json")));

    const res = await t.del("domain-skill", "s");
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(existsSync(join(t.storeDir, "domain-skill/s.json")), false);
    assert.equal(existsSync(join(t.storeDir, "rendered/domain-skill/s/SKILL.md")), false);
    assert.equal(existsSync(join(t.storeDir, "score/s.json")), false);
  } finally {
    await t.cleanup();
  }
});

test("DELETE drops the links[] entries that point at the doc and names those docs; a [[ ]] in a body stays as text", async () => {
  const t = await setup();
  try {
    await t.call("POST", "/api/docs/db-schema", table("x"));
    await t.call("POST", "/api/docs/db-schema", table("y", { links: [link("db-schema", "x")] }));
    const s = await t.call("POST", "/api/docs/domain-skill", skill("s", "# s\n\n## 도메인 지식\n\n[[db-schema/x]] 를 본다.\n"));
    assert.equal(s.statusCode, 201, s.body);
    assert.deepEqual(s.json().json.links, [link("db-schema", "x")]);

    const res = await t.del("db-schema", "x");
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().unlinked, [{ type: "db-schema", id: "y" }, { type: "domain-skill", id: "s" }]);
    assert.equal(readJson(t.storeDir, "db-schema/y.json").links, undefined);
    const after = readJson(t.storeDir, "domain-skill/s.json");
    assert.equal(after.links, undefined);
    assert.match(after.body.markdown, /\[\[db-schema\/x\]\]/);
    assert.deepEqual(readJson(t.storeDir, "rendered/db-schema/index.json"), [{ keywords: ["y"], path: "docs/y.md" }]);

    const view = (await t.call("GET", "/api/docs/domain-skill/s")).json();
    assert.deepEqual(view.wikilinks.map((w) => w.found), [false]);
  } finally {
    await t.cleanup();
  }
});

test("DELETE: If-Match required (428), a stale rev 409, a missing doc 404, a user 403", async () => {
  const t = await setup();
  try {
    const rev = (await t.call("POST", "/api/docs/db-schema", table("x"))).json().rev;
    assert.equal((await t.call("DELETE", "/api/docs/db-schema/x")).statusCode, 428);
    assert.equal((await t.call("DELETE", "/api/docs/db-schema/x")).json().error, "if_match_required");
    const stale = await t.del("db-schema", "x", "0".repeat(40));
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "unknown_base_rev");
    assert.equal((await t.del("db-schema", "nope", rev)).statusCode, 404);
    const asUser = await t.app.inject({ method: "DELETE", url: "/api/docs/db-schema/x", headers: { ...as("reader"), "if-match": rev } });
    assert.equal(asUser.statusCode, 403);
    assert.ok(existsSync(join(t.storeDir, "db-schema/x.json")));
  } finally {
    await t.cleanup();
  }
});

test("after DELETE the same id and the same data ids make a new document", async () => {
  const t = await setup();
  try {
    const md = "# s\n\n## 데이터\n\n### snsr_id — 센서\n\n```sql\nSELECT 1 FROM t WHERE k = :snsr_id\n```\n";
    assert.equal((await t.call("POST", "/api/docs/domain-skill", skill("s", md))).statusCode, 201);
    assert.equal((await t.del("domain-skill", "s")).statusCode, 200);
    assert.equal((await t.call("POST", "/api/docs/domain-skill", skill("s", md))).statusCode, 201);
    assert.equal((await t.call("POST", "/api/docs/domain-skill", skill("t", md.replace("# s", "# t")))).statusCode, 409, "the new s holds snsr_id");
  } finally {
    await t.cleanup();
  }
});
