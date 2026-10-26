// An agent (Bearer) creates and edits documents and their links. It never
// reaches confirmed (D4), and promote · delete · role · retype · types stay
// the admin's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-agent-write-test-"));
  const auth = await signIn(home, [
    { id: "kim", group: "admin", token: "admin-pw" },
    { id: "lee", group: "user", token: "user-pw" },
    { id: "bot-cc", group: "agent", token: "bot-pw" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const call = (token, method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, payload });
  return {
    app,
    storeDir,
    admin: (...a) => call("admin-pw", ...a),
    agent: (...a) => call("bot-pw", ...a),
    lastCommit: () =>
      execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).trim(),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function dbSchemaDoc() {
  return {
    schema: "db-schema/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: "X",
      catalog: {
        columns: [{ name: "A", type: "NUMBER", nullable: false }],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

const vocDoc = (id, markdown) => ({
  schema: "voc/v1",
  id,
  keywords: [{ kw: id, inject: "pointer" }],
  status: "active",
  body: { name: id, markdown },
});

test("agent: a new document is 201 without x-csrf-token, its confirmed lands inferred, the commit author is the agent", async () => {
  const t = await setup();
  try {
    const doc = dbSchemaDoc();
    doc.body.purpose = { text: "몰래 confirmed", tier: "confirmed", evidence: ["x:1"] };
    const headers = as("bot-pw");
    assert.equal(headers["x-csrf-token"], undefined);
    assert.equal(headers.cookie, undefined);
    const res = await t.agent("POST", "/api/docs/db-schema", doc);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().json.body.purpose.tier, "inferred");
    assert.equal(t.lastCommit(), "bot-cc|create db-schema/x");
  } finally {
    await t.cleanup();
  }
});

test("agent: an edit is 200, a confirmed in the body lands inferred, and editing a confirmed slot demotes it", async () => {
  const t = await setup();
  try {
    const created = await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc());
    const rev0 = created.json().rev;

    // Agent writes purpose and claims confirmed: lands inferred.
    const body1 = dbSchemaDoc().body;
    body1.purpose = { text: "목적", tier: "confirmed", evidence: ["x:1"] };
    const edit1 = await t.agent("PUT", "/api/docs/db-schema/x", body1, {
      "if-match": rev0,
      "x-akg-note": encodeURIComponent("cc 가 목적을 적음"),
    });
    assert.equal(edit1.statusCode, 200, edit1.body);
    assert.equal(edit1.json().json.body.purpose.tier, "inferred");
    assert.equal(t.lastCommit(), "bot-cc|edit db-schema/x · cc 가 목적을 적음");

    // Admin promotes it; the agent's next edit of that slot demotes it again.
    const promoted = await t.admin("POST", "/api/docs/db-schema/x/promote", { slots: ["purpose"] }, { "if-match": edit1.json().rev });
    assert.equal(promoted.statusCode, 200, promoted.body);
    const got = await t.agent("GET", "/api/docs/db-schema/x");
    assert.equal(got.json().json.body.purpose.tier, "confirmed");

    const body2 = structuredClone(got.json().json.body);
    body2.purpose = { ...body2.purpose, text: "고친 목적" };
    const edit2 = await t.agent("PUT", "/api/docs/db-schema/x", body2, { "if-match": got.json().rev });
    assert.equal(edit2.statusCode, 200, edit2.body);
    assert.equal(edit2.json().json.body.purpose.tier, "inferred");
    assert.equal(edit2.json().json.body.purpose.text, "고친 목적");
  } finally {
    await t.cleanup();
  }
});

test("agent: links is 200; a stale rev is 409 for links and for an overlapping edit", async () => {
  const t = await setup();
  try {
    await t.admin("POST", "/api/docs/voc", vocDoc("target", "# 대상\n\n글\n"));
    const created = await t.agent("POST", "/api/docs/voc", vocDoc("n", "# n\n\n글\n"));
    assert.equal(created.statusCode, 201, created.body);
    const rev0 = created.json().rev;

    const links = await t.agent("PUT", "/api/docs/voc/n/links", { links: [{ type: "voc", id: "target", rel: "related" }] }, { "if-match": rev0 });
    assert.equal(links.statusCode, 200, links.body);
    assert.deepEqual(links.json().json.links, [{ type: "voc", id: "target", rel: "related" }]);
    const rev1 = links.json().rev;

    const staleLinks = await t.agent("PUT", "/api/docs/voc/n/links", { links: [] }, { "if-match": rev0 });
    assert.equal(staleLinks.statusCode, 409);

    const edit = await t.agent("PUT", "/api/docs/voc/n", { name: "n", markdown: "# n\n\n고친 글\n" }, { "if-match": rev1 });
    assert.equal(edit.statusCode, 200, edit.body);
    // The edit keeps the links: PUT carries the body only.
    assert.deepEqual(edit.json().json.links, [{ type: "voc", id: "target", rel: "related" }]);

    const stale = await t.agent("PUT", "/api/docs/voc/n", { name: "n", markdown: "# n\n\n다른 글\n" }, { "if-match": rev1 });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "slot_conflict");
  } finally {
    await t.cleanup();
  }
});

test("agent: promote · deprecate · activate · delete · role · retype · origin · types stay 403", async () => {
  const t = await setup();
  try {
    const created = await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc());
    const rev = created.json().rev;
    const ifMatch = { "if-match": rev };
    const rows = [
      ["POST", "/api/docs/db-schema/x/promote", {}],
      ["POST", "/api/docs/db-schema/x/deprecate", {}],
      ["POST", "/api/docs/db-schema/x/activate", {}],
      ["DELETE", "/api/docs/db-schema/x", undefined],
      ["PUT", "/api/docs/domain-skill/x/role", { role: "sub" }],
      ["POST", "/api/docs/db-schema/x/retype", { to: "voc" }],
      ["PUT", "/api/docs/db-schema/x/origin", { origin: { url: "https://wiki.example/1" } }],
      ["PUT", "/api/types/notes", { label: "노트", color: "#7a4bd7" }],
      ["PUT", "/api/types/order", { order: [] }],
    ];
    for (const [method, url, payload] of rows) {
      const res = await t.agent(method, url, payload, ifMatch);
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
    }
  } finally {
    await t.cleanup();
  }
});

test("agent: an md type the admin registered takes the agent's new document and edit like voc", async () => {
  const t = await setup();
  try {
    const reg = await t.admin("PUT", "/api/types/meeting-notes", { label: "회의록", color: "#7a4bd7" });
    assert.ok(reg.statusCode === 200 || reg.statusCode === 201, reg.body);

    const created = await t.agent("POST", "/api/docs/meeting-notes", {
      schema: "meeting-notes/v1",
      id: "weekly",
      status: "inactive",
      body: { name: "weekly", markdown: "# 주간 회의\n\n안건\n" },
    });
    assert.equal(created.statusCode, 201, created.body);

    const edit = await t.agent("PUT", "/api/docs/meeting-notes/weekly", { name: "weekly", markdown: "# 주간 회의\n\n고친 안건\n" }, { "if-match": created.json().rev });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.json().json.body.markdown, "# 주간 회의\n\n고친 안건\n");
    assert.equal(t.lastCommit(), "bot-cc|edit meeting-notes/weekly");
  } finally {
    await t.cleanup();
  }
});
