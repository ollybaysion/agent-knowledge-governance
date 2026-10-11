import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { pngBytes } from "../fixtures/images.mjs";

function freshHome() {
  return mkdtempSync(join(tmpdir(), "akg-docs-route-test-"));
}

async function setup(users) {
  const home = freshHome();
  saveUsers(join(home, "users.json"), users);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    home,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function auth(token) {
  return { authorization: `Bearer ${token}` };
}

function newDbSchemaDoc(overrides = {}) {
  return {
    schema: "db-schema/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    body: {
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
      purpose: { text: null, tier: "scaffold" },
      columnDescs: {
        A: { text: null, tier: "scaffold" },
        B: { text: null, tier: "scaffold" },
      },
    },
    ...overrides,
  };
}

test("create -> read -> edit round trip, and a fresh POST can never smuggle confirmed", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "reader", role: "viewer", tokenHash: hashToken("vtok") },
  ]);

  const doc = newDbSchemaDoc();
  doc.body.purpose = {
    text: "몰래 confirmed",
    tier: "confirmed",
    evidence: ["sneaky:1"],
  };
  const create = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: doc,
  });
  assert.equal(create.statusCode, 201);
  // D4: no write path may create confirmed directly — even POST demotes it.
  assert.equal(create.json().json.body.purpose.tier, "inferred");

  const get = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x",
    headers: auth("vtok"),
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().json.body.purpose.text, "몰래 confirmed");
  assert.ok(get.json().rev);
  assert.ok(get.json().md.includes("# X\nowner: T"));

  await cleanup();
});

test("PUT without If-Match is rejected (428); with a stale but non-overlapping rev it auto-rebases (S6)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const noIfMatch = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: auth("edtok"),
    payload: newDbSchemaDoc().body,
  });
  assert.equal(noIfMatch.statusCode, 428);

  // First edit: touches column A.
  const bodyA = newDbSchemaDoc().body;
  bodyA.columnDescs.A = {
    text: "A 설명",
    tier: "confirmed",
    evidence: ["a:1"],
  };
  const editA = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: bodyA,
  });
  assert.equal(editA.statusCode, 200);
  assert.equal(editA.json().json.body.columnDescs.A.tier, "inferred"); // PUT never creates confirmed

  // Second edit, still against the STALE rev0, touches column B only -> should rebase cleanly.
  const bodyB = newDbSchemaDoc().body;
  bodyB.columnDescs.B = {
    text: "B 설명",
    tier: "confirmed",
    evidence: ["b:1"],
  };
  const editB = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 }, // still rev0, now stale
    payload: bodyB,
  });
  assert.equal(editB.statusCode, 200);
  assert.equal(editB.json().rebased, true);
  assert.equal(editB.json().json.body.columnDescs.A.text, "A 설명"); // alice's change survived the rebase
  assert.equal(editB.json().json.body.columnDescs.B.text, "B 설명");

  await cleanup();
});

// Regression: `git commit` fails on an empty index, so writing a document's
// existing bytes back surfaced as a 500. Re-pushing an unchanged doc is the
// most ordinary thing a producer does (a re-run factory, a retried `akg
// push`), and the returned rev has to stay usable as the next If-Match.
test("PUT with an unchanged body is idempotent — same rev, no empty commit, still editable", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  try {
    const doc = newDbSchemaDoc();
    const created = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: doc,
    });
    assert.equal(created.statusCode, 201, created.body);
    const rev0 = created.json().rev;

    // Another document commits in between, so HEAD no longer belongs to ours.
    const other = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: newDbSchemaDoc({ id: "y", body: { ...doc.body, table: "Y" } }),
    });
    assert.equal(other.statusCode, 201, other.body);

    const noop = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/x",
      headers: { ...auth("edtok"), "if-match": rev0 },
      payload: doc.body,
    });
    assert.equal(noop.statusCode, 200, noop.body);
    assert.equal(noop.json().rev, rev0, "unchanged content keeps its rev");

    // The rev it handed back must still be accepted as the base of a real edit.
    const real = await app.inject({
      method: "PUT",
      url: "/api/docs/db-schema/x",
      headers: { ...auth("edtok"), "if-match": noop.json().rev },
      payload: {
        ...doc.body,
        purpose: { text: "실제 편집.", tier: "inferred", evidence: ["t.x:1"] },
      },
    });
    assert.equal(real.statusCode, 200, real.body);
    assert.notEqual(real.json().rev, rev0);
  } finally {
    await cleanup();
  }
});

test("PUT with an overlapping stale edit gets 409, not a silent overwrite (S6)", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const bodyA1 = newDbSchemaDoc().body;
  bodyA1.columnDescs.A = {
    text: "첫 편집",
    tier: "confirmed",
    evidence: ["a:1"],
  };
  await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: bodyA1,
  });

  const bodyA2 = newDbSchemaDoc().body;
  bodyA2.columnDescs.A = {
    text: "충돌하는 두번째 편집",
    tier: "confirmed",
    evidence: ["a:2"],
  };
  const conflict = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 }, // stale AND overlapping
    payload: bodyA2,
  });
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.json().overlap, ["columnDescs.A"]);
  assert.equal(conflict.json().current.body.columnDescs.A.text, "첫 편집");

  await cleanup();
});

test("DELETE archives a doc (approver only) — dropped from the index, JSON preserved; a nonexistent route is 404 not 500", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "approver", tokenHash: hashToken("aptok") },
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("aptok"),
    payload: newDbSchemaDoc(),
  });

  // editor cannot archive
  const forbidden = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/x",
    headers: auth("edtok"),
  });
  assert.equal(forbidden.statusCode, 403);

  const del = await app.inject({
    method: "DELETE",
    url: "/api/docs/db-schema/x",
    headers: auth("aptok"),
  });
  assert.equal(del.statusCode, 200);

  const after = await app.inject({
    method: "GET",
    url: "/api/docs/db-schema/x",
    headers: auth("aptok"),
  });
  assert.equal(after.json().json.status, "archived"); // JSON preserved, just archived

  // a genuinely unknown route returns a clean 404, never a 500 route_misconfigured
  const unknown = await app.inject({
    method: "DELETE",
    url: "/api/nope/x",
    headers: auth("aptok"),
  });
  assert.equal(unknown.statusCode, 404);

  await cleanup();
});

test("catalog-push replaces catalog and auto-deprecates an inferred slot whose column vanished", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const created = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: newDbSchemaDoc(),
  });
  const rev0 = created.json().rev;

  const editB = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x",
    headers: { ...auth("edtok"), "if-match": rev0 },
    payload: (() => {
      const b = newDbSchemaDoc().body;
      b.columnDescs.B = {
        text: "B 설명",
        tier: "confirmed",
        evidence: ["b:1"],
      };
      return b;
    })(),
  });
  assert.equal(editB.statusCode, 200);

  // Column B drops out of the live catalog — its non-scaffold slot must auto-deprecate, not vanish.
  const push = await app.inject({
    method: "PUT",
    url: "/api/docs/db-schema/x/catalog",
    headers: auth("edtok"),
    payload: {
      columns: [
        { name: "A", type: "NUMBER", nullable: false },
        { name: "C", type: "NUMBER", nullable: true },
      ],
      primaryKey: ["A"],
      fetchedAt: "2026-02-01T00:00:00Z",
    },
  });
  assert.equal(push.statusCode, 200);
  assert.equal(push.json().json.body.columnDescs.B.tier, "deprecated");
  assert.equal(push.json().json.body.columnDescs.B.text, "B 설명"); // preserved, not erased
  assert.deepEqual(push.json().json.body.columnDescs.C, {
    text: null,
    tier: "scaffold",
  }); // new column seeded
  assert.equal(push.json().json.body.columnDescs.A.tier, "scaffold"); // untouched column, untouched slot

  await cleanup();
});

function screenMapDoc(id, overrides = {}) {
  return {
    schema: "screen-map/v1",
    id,
    keywords: [{ kw: id, inject: "pointer" }],
    status: "active",
    body: { id, name: `화면 ${id}` },
    ...overrides,
  };
}

const link = (type, id, rel = "related") => ({ type, id, rel });

test("links: a write naming a target the store lacks is 400 unknown_link_target; pointing at itself is 400", async () => {
  const { app, home, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: newDbSchemaDoc({ links: [link("screen-map", "nope", "screen")] }),
    });
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.json().error, "unknown_link_target");
    assert.deepEqual(missing.json().missing, [{ type: "screen-map", id: "nope" }]);
    assert.equal(existsSync(join(home, "store", "db-schema", "x.json")), false);

    const self = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: newDbSchemaDoc({ links: [link("db-schema", "x")] }),
    });
    assert.equal(self.statusCode, 400);
    assert.ok(self.json().details.some((d) => d.includes("자기 자신")));

    const batch = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/batch",
      headers: auth("edtok"),
      payload: { docs: [newDbSchemaDoc({ links: [link("screen-map", "nope")] })] },
    });
    assert.equal(batch.statusCode, 400);
    assert.equal(batch.json().rejected[0].error, "unknown_link_target");
  } finally {
    await cleanup();
  }
});

test("links: forward edges land in the list, the index and the read; the target computes backlinks", async () => {
  const { app, home, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  try {
    for (const payload of [
      screenMapDoc("spc-chart-config"),
      newDbSchemaDoc({ links: [link("screen-map", "spc-chart-config")] }),
    ]) {
      const r = await app.inject({
        method: "POST",
        url: `/api/docs/${payload.schema.split("/")[0]}`,
        headers: auth("edtok"),
        payload,
      });
      assert.equal(r.statusCode, 201, r.body);
    }

    const list = await app.inject({ method: "GET", url: "/api/docs?type=db-schema" });
    assert.deepEqual(list.json().docs[0].links, [link("screen-map", "spc-chart-config")]);
    assert.equal(list.json().docs[0].title, "X");
    const screens = await app.inject({ method: "GET", url: "/api/docs?type=screen-map" });
    assert.equal(screens.json().docs[0].title, "화면 spc-chart-config");

    const index = JSON.parse(
      readFileSync(join(home, "store", "rendered", "db-schema", "index.json"), "utf8"),
    );
    assert.deepEqual(index[0].links, [link("screen-map", "spc-chart-config")]);

    const from = await app.inject({ method: "GET", url: "/api/docs/db-schema/x" });
    assert.deepEqual(from.json().links, [
      { ...link("screen-map", "spc-chart-config"), status: "active" },
    ]);
    assert.deepEqual(from.json().backlinks, []);

    const to = await app.inject({ method: "GET", url: "/api/docs/screen-map/spc-chart-config" });
    assert.deepEqual(to.json().backlinks, [
      { type: "db-schema", id: "x", rel: "related", status: "active" },
    ]);
    assert.deepEqual(to.json().links, []);
  } finally {
    await cleanup();
  }
});

test("links: archiving either end keeps the edge and reports the archived status", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  try {
    await app.inject({
      method: "POST",
      url: "/api/docs/screen-map",
      headers: auth("aptok"),
      payload: screenMapDoc("spc-chart-config"),
    });
    await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("aptok"),
      payload: newDbSchemaDoc({ links: [link("screen-map", "spc-chart-config")] }),
    });

    await app.inject({
      method: "DELETE",
      url: "/api/docs/screen-map/spc-chart-config",
      headers: auth("aptok"),
    });
    const from = await app.inject({ method: "GET", url: "/api/docs/db-schema/x" });
    assert.equal(from.json().links[0].status, "archived");
    assert.deepEqual(from.json().json.links, [link("screen-map", "spc-chart-config")]);

    // An archived target still exists, so a new edge to it is accepted.
    const again = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("aptok"),
      payload: newDbSchemaDoc({
        id: "y",
        body: { ...newDbSchemaDoc().body, table: "Y" },
        links: [link("screen-map", "spc-chart-config")],
      }),
    });
    assert.equal(again.statusCode, 201, again.body);

    await app.inject({ method: "DELETE", url: "/api/docs/db-schema/x", headers: auth("aptok") });
    const to = await app.inject({ method: "GET", url: "/api/docs/screen-map/spc-chart-config" });
    assert.deepEqual(
      to.json().backlinks.map((b) => `${b.id}:${b.status}`).sort(),
      ["x:archived", "y:active"],
    );
  } finally {
    await cleanup();
  }
});

test("PUT links: If-Match required and checked; sets, checks targets, and an empty list drops the key", async () => {
  const { app, cleanup } = await setup([
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "reader", role: "viewer", tokenHash: hashToken("vtok") },
  ]);
  try {
    await app.inject({
      method: "POST",
      url: "/api/docs/screen-map",
      headers: auth("edtok"),
      payload: screenMapDoc("spc-chart-config"),
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: newDbSchemaDoc(),
    });
    const rev0 = created.json().rev;
    const url = "/api/docs/db-schema/x/links";
    const links = [link("screen-map", "spc-chart-config")];

    const viewer = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth("vtok"), "if-match": rev0 },
      payload: { links },
    });
    assert.equal(viewer.statusCode, 403);

    const noIfMatch = await app.inject({ method: "PUT", url, headers: auth("edtok"), payload: { links } });
    assert.equal(noIfMatch.statusCode, 428);

    const unknown = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth("edtok"), "if-match": rev0 },
      payload: { links: [link("screen-map", "nope")] },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, "unknown_link_target");

    const set = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth("edtok"), "if-match": rev0 },
      payload: { links },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(Object.keys(set.json().json), ["schema", "id", "keywords", "status", "links", "body"]);

    const stale = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth("edtok"), "if-match": rev0 },
      payload: { links: [] },
    });
    assert.equal(stale.statusCode, 409);

    const cleared = await app.inject({
      method: "PUT",
      url,
      headers: { ...auth("edtok"), "if-match": set.json().rev },
      payload: { links: [] },
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal("links" in cleared.json().json, false);
  } finally {
    await cleanup();
  }
});

test("manual: a draft saves without screen or captures; activation needs one rel:screen link to a screen-map and every capture in the store", async () => {
  const { app, home, cleanup } = await setup([
    { id: "renoir", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  const h = auth("aptok");
  try {
    const png = pngBytes(1280, 720);
    const sha = createHash("sha256").update(png).digest("hex");
    await app.inject({ method: "POST", url: "/api/docs/screen-map", headers: h, payload: screenMapDoc("spc-chart-config") });
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: h, payload: newDbSchemaDoc() });

    const draft = await app.inject({
      method: "POST",
      url: "/api/docs/manual",
      headers: h,
      payload: {
        schema: "manual/v1",
        id: "spc-chart-limit-setup",
        keywords: [{ kw: "spc limit", inject: "pointer" }],
        status: "inactive",
        body: { title: "SPC 관리 한계 설정", steps: [{ text: "[설정]을 누른다.", asset: sha, width: 1280, height: 720 }] },
      },
    });
    assert.equal(draft.statusCode, 201, draft.body);

    const url = "/api/docs/manual/spc-chart-limit-setup";
    const activate = async () => {
      const { rev } = (await app.inject({ method: "GET", url })).json();
      return app.inject({ method: "POST", url: `${url}/activate`, headers: { ...h, "if-match": rev } });
    };
    const setLinks = async (links) => {
      const { rev } = (await app.inject({ method: "GET", url })).json();
      const r = await app.inject({ method: "PUT", url: `${url}/links`, headers: { ...h, "if-match": rev }, payload: { links } });
      assert.equal(r.statusCode, 200, r.body);
    };

    const noScreen = await activate();
    assert.equal(noScreen.statusCode, 400);
    assert.ok(noScreen.json().details.some((d) => d.includes('rel "screen"')));

    await setLinks([link("db-schema", "x", "screen")]);
    const wrongType = await activate();
    assert.equal(wrongType.statusCode, 400);
    assert.ok(wrongType.json().details.some((d) => d.includes("screen-map")));

    await setLinks([link("screen-map", "spc-chart-config", "screen")]);
    const noCapture = await activate();
    assert.equal(noCapture.statusCode, 400);
    assert.ok(noCapture.json().details.some((d) => d.includes("캡처가 저장소에 없습니다")));

    const up = await app.inject({
      method: "POST",
      url: "/api/assets",
      headers: { ...h, "content-type": "image/png" },
      payload: png,
    });
    assert.equal(up.statusCode, 201, up.body);
    const ok = await activate();
    assert.equal(ok.statusCode, 200, ok.body);

    const md = readFileSync(join(home, "store", "rendered", "manual", "docs", "spc-chart-limit-setup.md"), "utf8");
    assert.equal(md, `# SPC 관리 한계 설정\n\n화면: spc-chart-config\n\n1. [설정]을 누른다. (${sha.slice(0, 8)})\n`);
    const index = JSON.parse(readFileSync(join(home, "store", "rendered", "manual", "index.json"), "utf8"));
    assert.deepEqual(index, [
      { keywords: ["spc limit"], path: "docs/spc-chart-limit-setup.md", precision: 0.5, links: [link("screen-map", "spc-chart-config", "screen")] },
    ]);

    // An active manual keeps its screen: dropping the link is refused.
    const { rev } = (await app.inject({ method: "GET", url })).json();
    const drop = await app.inject({ method: "PUT", url: `${url}/links`, headers: { ...h, "if-match": rev }, payload: { links: [] } });
    assert.equal(drop.statusCode, 400);
  } finally {
    await cleanup();
  }
});

function skillDoc(name, markdown, overrides = {}) {
  return {
    schema: "domain-skill/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    body: { name, markdown },
    ...overrides,
  };
}

test("[[ ]]: the body's targets join links[] as related, a missing one is kept out but reported found:false", async () => {
  const { app, cleanup } = await setup([{ id: "renoir", role: "editor", tokenHash: hashToken("edtok") }]);
  const h = auth("edtok");
  try {
    await app.inject({ method: "POST", url: "/api/docs/screen-map", headers: h, payload: screenMapDoc("spc-chart-config") });
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: h, payload: newDbSchemaDoc() });
    const md = "# s\n\n## 도메인 지식\n\n화면 [[spc-chart-config]] 과 표 [[db-schema/x]], 아직 없는 [[nope]].\n\n```\n[[in-fence]]\n```\n";
    const created = await app.inject({
      method: "POST",
      url: "/api/docs/domain-skill",
      headers: h,
      payload: skillDoc("s", md, { links: [link("db-schema", "x", "screen")] }),
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().json.links, [
      link("db-schema", "x", "screen"),
      link("screen-map", "spc-chart-config"),
      link("db-schema", "x"),
    ]);

    const got = (await app.inject({ method: "GET", url: "/api/docs/domain-skill/s" })).json();
    assert.deepEqual(got.wikilinks, [
      { text: "spc-chart-config", type: "screen-map", id: "spc-chart-config", found: true },
      { text: "db-schema/x", type: "db-schema", id: "x", found: true },
      { text: "nope", type: null, id: "nope", found: false },
    ]);
    const back = (await app.inject({ method: "GET", url: "/api/docs/screen-map/spc-chart-config" })).json();
    assert.deepEqual(back.backlinks, [{ type: "domain-skill", id: "s", rel: "related", status: "active" }]);
  } finally {
    await cleanup();
  }
});

test("[[ ]]: a bare id in two types is 400 ambiguous_link_target; [[type/id]] resolves it", async () => {
  const { app, cleanup } = await setup([{ id: "renoir", role: "editor", tokenHash: hashToken("edtok") }]);
  const h = auth("edtok");
  try {
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: h, payload: newDbSchemaDoc() });
    await app.inject({ method: "POST", url: "/api/docs/screen-map", headers: h, payload: screenMapDoc("x") });
    const bare = await app.inject({
      method: "POST",
      url: "/api/docs/domain-skill",
      headers: h,
      payload: skillDoc("s", "# s\n\n## 도메인 지식\n\n[[x]]\n"),
    });
    assert.equal(bare.statusCode, 400);
    assert.equal(bare.json().error, "ambiguous_link_target");
    assert.match(bare.json().message, /타입\/id/);
    assert.deepEqual(bare.json().targets, [{ text: "x", types: ["db-schema", "screen-map"] }]);

    const typed = await app.inject({
      method: "POST",
      url: "/api/docs/domain-skill",
      headers: h,
      payload: skillDoc("s", "# s\n\n## 도메인 지식\n\n[[screen-map/x]]\n"),
    });
    assert.equal(typed.statusCode, 201, typed.body);
    assert.deepEqual(typed.json().json.links, [link("screen-map", "x")]);
  } finally {
    await cleanup();
  }
});

test("[[ ]]: PUT links cannot drop a body link; editing the [[ ]] out of the body drops it and keeps hand links", async () => {
  const { app, cleanup } = await setup([{ id: "renoir", role: "editor", tokenHash: hashToken("edtok") }]);
  const h = auth("edtok");
  try {
    await app.inject({ method: "POST", url: "/api/docs/screen-map", headers: h, payload: screenMapDoc("spc-chart-config") });
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: h, payload: newDbSchemaDoc() });
    const url = "/api/docs/domain-skill/s";
    const created = await app.inject({
      method: "POST",
      url: "/api/docs/domain-skill",
      headers: h,
      payload: skillDoc("s", "# s\n\n## 도메인 지식\n\n[[spc-chart-config]]\n"),
    });
    assert.equal(created.statusCode, 201, created.body);

    const put = await app.inject({
      method: "PUT",
      url: `${url}/links`,
      headers: { ...h, "if-match": created.json().rev },
      payload: { links: [link("db-schema", "x")] },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json().json.links, [link("db-schema", "x"), link("screen-map", "spc-chart-config")]);

    const edit = await app.inject({
      method: "PUT",
      url,
      headers: { ...h, "if-match": put.json().rev },
      payload: { name: "s", markdown: "# s\n\n## 도메인 지식\n\n이제 화면 이야기는 없다.\n" },
    });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual(edit.json().json.links, [link("db-schema", "x")]);
  } finally {
    await cleanup();
  }
});

test("[[ ]]: a manual's step texts are read too", async () => {
  const { app, cleanup } = await setup([{ id: "renoir", role: "editor", tokenHash: hashToken("edtok") }]);
  const h = auth("edtok");
  try {
    await app.inject({ method: "POST", url: "/api/docs/db-schema", headers: h, payload: newDbSchemaDoc() });
    const r = await app.inject({
      method: "POST",
      url: "/api/docs/manual",
      headers: h,
      payload: {
        schema: "manual/v1",
        id: "m",
        keywords: [{ kw: "m", inject: "pointer" }],
        status: "inactive",
        body: { title: "M", steps: [{ text: "표 [[x]] 를 연다." }] },
      },
    });
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual(r.json().json.links, [link("db-schema", "x")]);
  } finally {
    await cleanup();
  }
});
