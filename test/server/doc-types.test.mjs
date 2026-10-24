// The type list (GET /api/types and its admin writes), md types registered at
// run time, unclassified, retype and the envelope's origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

const DEFAULT_ORDER = [
  "db-schema",
  "msg-format",
  "domain-skill",
  "screen-map",
  "manual",
  "fab-line",
  "voc",
  "unclassified",
];

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-doc-types-test-"));
  const signedIn = await signIn(home, [
    { id: "renoir", group: "admin", token: "aptok" },
    { id: "kim", group: "user", token: "utok" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth: signedIn });
  const call = (token, method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  return {
    app,
    storeDir,
    call,
    admin: (method, url, payload, headers) => call("aptok", method, url, payload, headers),
    user: (method, url, payload, headers) => call("utok", method, url, payload, headers),
    commits: () => Number(execFileSync("git", ["-C", storeDir, "rev-list", "--count", "HEAD"], { encoding: "utf8" })),
    lastMessage: () => execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
    file: (rel) => join(storeDir, rel),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const mdDoc = (type, name, markdown = `# ${name}\n\n글\n`, extra = {}) => ({
  schema: `${type}/v1`,
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  ...extra,
  body: { name, markdown },
});

function dbSchemaDoc(extra = {}) {
  return {
    schema: "db-schema/v1",
    id: "x",
    keywords: [{ kw: "x", inject: "full" }],
    status: "active",
    ...extra,
    body: {
      owner: "T",
      table: "X",
      catalog: { columns: [{ name: "A", type: "NUMBER", nullable: false }], primaryKey: ["A"], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

const register = (t, id, fields = { label: "회의록", color: "#7a4bd7" }) => t.admin("PUT", `/api/types/${id}`, fields);

test("GET /api/types: a user reads the default list — code types, voc, unclassified last — with counts", async () => {
  const t = await setup();
  try {
    const empty = await t.user("GET", "/api/types");
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().rev, null);
    assert.deepEqual(empty.json().types.map((x) => x.id), DEFAULT_ORDER);
    const byId = Object.fromEntries(empty.json().types.map((x) => [x.id, x]));
    assert.deepEqual(byId["db-schema"], { id: "db-schema", label: "DB 스키마", color: "#3f7d8a", kind: "structured", builtin: true, status: "active", count: 0 });
    assert.deepEqual(byId.voc, { id: "voc", label: "VOC", color: "#4e9a5a", kind: "md", builtin: false, status: "active", count: 0 });
    assert.deepEqual(byId.unclassified, { id: "unclassified", label: "미분류", color: "#8a8f98", kind: "md", builtin: true, status: "active", count: 0 });

    assert.equal((await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc())).statusCode, 201);
    const counted = (await t.call("reader", "GET", "/api/types")).json().types;
    assert.equal(counted.find((x) => x.id === "db-schema").count, 1);
    assert.equal((await t.admin("DELETE", "/api/docs/db-schema/x")).statusCode, 200);
    const archived = (await t.user("GET", "/api/types")).json().types;
    assert.equal(archived.find((x) => x.id === "db-schema").count, 0, "an archived doc is not counted");
    assert.equal(existsSync(t.file("types.json")), false, "reading writes nothing");
  } finally {
    await t.cleanup();
  }
});

test("PUT /api/types/:id: admin registers an md type before unclassified in one commit; the rules on id · color · who", async () => {
  const t = await setup();
  try {
    const before = t.commits();
    const r = await register(t, "meeting-notes", { label: "회의록", color: "#7A4BD7", description: "주간 회의 기록" });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(t.commits(), before + 1);
    assert.equal(t.lastMessage(), "타입 등록 meeting-notes");
    const ids = r.json().types.map((x) => x.id);
    assert.deepEqual(ids, [...DEFAULT_ORDER.slice(0, -1), "meeting-notes", "unclassified"]);
    assert.deepEqual(r.json().types.at(-2), {
      id: "meeting-notes",
      label: "회의록",
      color: "#7a4bd7",
      description: "주간 회의 기록",
      kind: "md",
      builtin: false,
      status: "active",
      count: 0,
    });
    assert.match(r.json().rev, /^[0-9a-f]{40}$/);
    const rendered = JSON.parse(readFileSync(t.file("rendered/types.json"), "utf8"));
    assert.deepEqual(rendered.types.map((x) => x.id), ids);
    const audit = (await t.user("GET", "/api/audit")).json().entries;
    assert.equal(audit[0].message, "타입 등록 meeting-notes");
    assert.equal(audit[0].author, "renoir");

    const edited = await register(t, "meeting-notes", { label: "회의", color: "#7a4bd7" });
    assert.equal(edited.statusCode, 200);
    assert.equal(t.lastMessage(), "타입 고침 meeting-notes");
    assert.equal(edited.json().types.at(-2).label, "회의");
    assert.equal("description" in edited.json().types.at(-2), false);

    const stale = await t.admin("PUT", "/api/types/meeting-notes", { label: "x", color: "#000000" }, { "if-match": r.json().rev });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "unknown_base_rev");

    assert.equal((await t.user("PUT", "/api/types/other", { label: "x", color: "#000000" })).statusCode, 403);
    for (const id of ["db-schema", "domain-skill", "unclassified"]) {
      const b = await register(t, id);
      assert.equal(b.statusCode, 400, id);
      assert.equal(b.json().error, "builtin_type");
    }
    for (const id of ["types", "graph", "rendered", "md"]) {
      const b = await register(t, id);
      assert.equal(b.statusCode, 409, id);
      assert.equal(b.json().error, "reserved_type_id");
    }
    assert.equal((await register(t, "9notes")).json().error, "invalid_type_id");
    for (const color of ["red", "#12345g", "#fff", ""]) {
      const b = await register(t, "notes", { label: "노트", color });
      assert.equal(b.statusCode, 400, color);
      assert.equal(b.json().error, "invalid_body");
    }
    assert.equal((await register(t, "notes", { label: " ", color: "#000000" })).statusCode, 400);
    assert.equal((await register(t, "notes", { label: "노트", color: "#000000", status: "archived" })).statusCode, 400);
    assert.equal((await register(t, "notes2", { label: "노트", color: "#7a4bd7" })).statusCode, 201, "colors may repeat; digits in an id");
  } finally {
    await t.cleanup();
  }
});

test("a registered md type: create · list · get · rendered/<type>/<id>.md as written, no index.json", async () => {
  const t = await setup();
  try {
    await register(t, "meeting-notes");
    const markdown = "# w1\n\n회의 [[db-schema/x]] 이야기\n";
    assert.equal((await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc())).statusCode, 201);
    const created = await t.admin("POST", "/api/docs/meeting-notes", mdDoc("meeting-notes", "w1", markdown));
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().json.links, [{ type: "db-schema", id: "x", rel: "related" }]);
    assert.equal(readFileSync(t.file("rendered/meeting-notes/w1.md"), "utf8"), markdown);
    assert.equal(existsSync(t.file("rendered/meeting-notes/index.json")), false);

    const list = (await t.user("GET", "/api/docs?type=meeting-notes")).json().docs;
    assert.deepEqual(list.map((d) => [d.type, d.id, d.title, d.status]), [["meeting-notes", "w1", "w1", "active"]]);
    const all = (await t.user("GET", "/api/docs")).json().docs;
    assert.ok(all.some((d) => d.type === "meeting-notes" && d.id === "w1"), "the unfiltered list walks the type list");

    const got = await t.user("GET", "/api/docs/meeting-notes/w1");
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().md, markdown);
    assert.equal(got.json().json.schema, "meeting-notes/v1");
    const back = (await t.user("GET", "/api/docs/db-schema/x")).json().backlinks;
    assert.deepEqual(back, [{ type: "meeting-notes", id: "w1", rel: "related", status: "active" }]);
    assert.equal((await t.user("GET", "/api/types")).json().types.find((x) => x.id === "meeting-notes").count, 1);
    assert.equal((await t.user("GET", "/api/schemas/meeting-notes")).json().$id, "md/v1");

    const wrongShape = await t.admin("POST", "/api/docs/meeting-notes", { ...mdDoc("meeting-notes", "w2"), body: { name: "w2", markdown: "x", extra: 1 } });
    assert.equal(wrongShape.statusCode, 400);
    const unknown = await t.admin("POST", "/api/docs/never-registered", mdDoc("never-registered", "w3"));
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().error, "unknown_type");
    assert.equal((await t.user("GET", "/api/docs/md/w1")).statusCode, 404);
  } finally {
    await t.cleanup();
  }
});

test("unclassified: a user files one, it renders to rendered/unclassified/<id>.md; the old sidecar shape is refused", async () => {
  const t = await setup();
  try {
    const markdown = "# note\n\n글\n";
    const r = await t.user("POST", "/api/docs/unclassified", mdDoc("unclassified", "note", markdown));
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(readFileSync(t.file("rendered/unclassified/note.md"), "utf8"), markdown);
    assert.equal(execFileSync("git", ["-C", t.storeDir, "log", "-1", "--format=%an"], { encoding: "utf8" }).trim(), "kim");

    const sidecar = await t.user("POST", "/api/docs/unclassified", {
      schema: "unclassified/v1",
      id: "old",
      keywords: [{ kw: "old", inject: "pointer" }],
      status: "active",
    });
    assert.equal(sidecar.statusCode, 400);
    assert.equal((await t.user("POST", "/api/docs/db-schema", dbSchemaDoc())).statusCode, 403, "other types stay admin's");
    assert.equal((await t.user("PUT", "/api/docs/unclassified/note", { name: "note", markdown: "y" }, { "if-match": r.json().rev })).statusCode, 403);
  } finally {
    await t.cleanup();
  }
});

test("PUT /api/types/order: every type once, unclassified pinned last, code types move too", async () => {
  const t = await setup();
  try {
    await register(t, "meeting-notes");
    const order = ["unclassified", "domain-skill", "meeting-notes", "voc", "db-schema", "msg-format", "screen-map", "manual", "fab-line"];
    const r = await t.admin("PUT", "/api/types/order", { order });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().types.map((x) => x.id), [...order.slice(1), "unclassified"]);
    assert.equal(t.lastMessage(), "타입 순서 변경");

    const missing = await t.admin("PUT", "/api/types/order", { order: order.filter((x) => x !== "voc") });
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(missing.json().missing, ["voc"]);
    const unknown = await t.admin("PUT", "/api/types/order", { order: [...order, "ghost"] });
    assert.deepEqual(unknown.json().unknown, ["ghost"]);
    const twice = await t.admin("PUT", "/api/types/order", { order: [...order, "voc"] });
    assert.deepEqual(twice.json().repeated, ["voc"]);
    assert.equal((await t.admin("PUT", "/api/types/order", { order: "voc" })).statusCode, 400);
    assert.equal((await t.user("PUT", "/api/types/order", { order })).statusCode, 403);
    assert.deepEqual((await t.user("GET", "/api/types")).json().types.map((x) => x.id), [...order.slice(1), "unclassified"]);
  } finally {
    await t.cleanup();
  }
});

test("POST /api/types/:id/archive: a closed type keeps its docs readable, listed archived, and takes no new content", async () => {
  const t = await setup();
  try {
    await register(t, "meeting-notes");
    const w1 = await t.admin("POST", "/api/docs/meeting-notes", mdDoc("meeting-notes", "w1"));
    const r = await t.admin("POST", "/api/types/meeting-notes/archive");
    assert.equal(r.statusCode, 200);
    assert.equal(t.lastMessage(), "타입 닫음 meeting-notes");
    assert.deepEqual(
      (({ status, count }) => ({ status, count }))(r.json().types.find((x) => x.id === "meeting-notes")),
      { status: "archived", count: 1 },
    );

    const create = await t.admin("POST", "/api/docs/meeting-notes", mdDoc("meeting-notes", "w2"));
    assert.equal(create.statusCode, 409);
    assert.equal(create.json().error, "type_archived");
    const edit = await t.admin("PUT", "/api/docs/meeting-notes/w1", { name: "w1", markdown: "바뀜" }, { "if-match": w1.json().rev });
    assert.equal(edit.json().error, "type_archived");
    assert.equal((await t.user("GET", "/api/docs/meeting-notes/w1")).statusCode, 200);
    assert.equal((await t.user("GET", "/api/docs?type=meeting-notes")).json().docs.length, 1);

    const reregister = await register(t, "meeting-notes", { label: "회의록2", color: "#000000" });
    assert.equal(reregister.json().types.find((x) => x.id === "meeting-notes").status, "archived", "editing does not reopen");
    assert.equal((await t.admin("POST", "/api/types/db-schema/archive")).json().error, "builtin_type");
    assert.equal((await t.admin("POST", "/api/types/unclassified/archive")).json().error, "builtin_type");
    assert.equal((await t.admin("POST", "/api/types/ghost/archive")).statusCode, 404);
    assert.equal((await t.user("POST", "/api/types/voc/archive")).statusCode, 403);
  } finally {
    await t.cleanup();
  }
});

test("retype: unclassified → meeting-notes moves the file, the schema, the render and the links pointing at it, in one commit", async () => {
  const t = await setup();
  try {
    await register(t, "meeting-notes");
    const origin = { url: "https://wiki.example/page/1", title: "원래 위키" };
    const u1 = await t.user("POST", "/api/docs/unclassified", mdDoc("unclassified", "u1", "# u1\n\n본문\n", { origin }));
    assert.equal(u1.statusCode, 201, u1.body);
    const voc = await t.admin("POST", "/api/docs/voc", mdDoc("voc", "v", "# v\n\n[[unclassified/u1]] 참고\n"));
    assert.deepEqual(voc.json().json.links, [{ type: "unclassified", id: "u1", rel: "related" }]);
    const x = await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc());
    const xl = await t.admin("PUT", "/api/docs/db-schema/x/links", { links: [{ type: "unclassified", id: "u1", rel: "related" }] }, { "if-match": x.json().rev });
    assert.equal(xl.statusCode, 200, xl.body);

    assert.equal((await t.user("POST", "/api/docs/unclassified/u1/retype", { type: "meeting-notes" }, { "if-match": u1.json().rev })).statusCode, 403);
    const stale = await t.admin("POST", "/api/docs/unclassified/u1/retype", { type: "meeting-notes" }, { "if-match": x.json().rev });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "unknown_base_rev");
    assert.equal((await t.admin("POST", "/api/docs/unclassified/u1/retype", { type: "meeting-notes" })).statusCode, 428);
    for (const [url, type] of [
      ["/api/docs/unclassified/u1/retype", "db-schema"],
      ["/api/docs/db-schema/x/retype", "meeting-notes"],
    ]) {
      const b = await t.admin("POST", url, { type }, { "if-match": u1.json().rev });
      assert.equal(b.statusCode, 400, url);
      assert.equal(b.json().error, "structured_type");
    }
    assert.equal((await t.admin("POST", "/api/docs/unclassified/u1/retype", { type: "ghost" }, { "if-match": u1.json().rev })).json().error, "unknown_type");

    const before = t.commits();
    const r = await t.admin("POST", "/api/docs/unclassified/u1/retype", { type: "meeting-notes" }, { "if-match": u1.json().rev });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(t.commits(), before + 1);
    assert.equal(t.lastMessage(), "retype unclassified/u1 → meeting-notes");
    assert.equal(r.json().json.schema, "meeting-notes/v1");
    assert.deepEqual(r.json().json.origin, origin);
    assert.equal(r.json().md, "# u1\n\n본문\n");
    assert.deepEqual(
      r.json().relinked.sort((a, b) => a.type.localeCompare(b.type)),
      [{ type: "db-schema", id: "x" }, { type: "voc", id: "v" }],
    );
    assert.deepEqual(r.json().backlinks.map((b) => `${b.type}/${b.id}`).sort(), ["db-schema/x", "voc/v"]);

    assert.equal(existsSync(t.file("unclassified/u1.json")), false);
    assert.equal(existsSync(t.file("rendered/unclassified/u1.md")), false);
    assert.equal(readFileSync(t.file("rendered/meeting-notes/u1.md"), "utf8"), "# u1\n\n본문\n");
    assert.equal(JSON.parse(readFileSync(t.file("meeting-notes/u1.json"), "utf8")).schema, "meeting-notes/v1");
    const vocNow = (await t.user("GET", "/api/docs/voc/v")).json();
    assert.deepEqual(vocNow.json.links, [{ type: "meeting-notes", id: "u1", rel: "related" }]);
    const index = JSON.parse(readFileSync(t.file("rendered/db-schema/index.json"), "utf8"));
    assert.deepEqual(index[0].links, [{ type: "meeting-notes", id: "u1", rel: "related" }]);
    assert.equal((await t.user("GET", "/api/docs/unclassified/u1")).statusCode, 404);
    assert.equal(execFileSync("git", ["-C", t.storeDir, "status", "--porcelain"], { encoding: "utf8" }), "");

    const back = await t.admin("POST", "/api/docs/meeting-notes/u1/retype", { type: "meeting-notes" }, { "if-match": r.json().rev });
    assert.equal(back.json().error, "same_type");
    await t.admin("POST", "/api/docs/unclassified", mdDoc("unclassified", "u1"));
    const clash = await t.admin("POST", "/api/docs/meeting-notes/u1/retype", { type: "unclassified" }, { "if-match": r.json().rev });
    assert.equal(clash.statusCode, 409);
    assert.equal(clash.json().error, "already_exists");
  } finally {
    await t.cleanup();
  }
});

test("origin: kept as written by every write, listed on the docs list, and refused unless http(s)", async () => {
  const t = await setup();
  try {
    const origin = { url: "https://confluence.example/x/1", title: "원본 페이지" };
    const r = await t.admin("POST", "/api/docs/db-schema", dbSchemaDoc({ origin }));
    assert.equal(r.statusCode, 201, r.body);
    assert.deepEqual((await t.user("GET", "/api/docs/db-schema/x")).json().json.origin, origin);
    assert.deepEqual((await t.user("GET", "/api/docs?type=db-schema")).json().docs[0].origin, origin);

    const edited = await t.admin("PUT", "/api/docs/db-schema/x", { ...dbSchemaDoc().body, purpose: { text: "용도", tier: "inferred", evidence: ["review:1"] } }, { "if-match": r.json().rev });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.deepEqual(edited.json().json.origin, origin);

    const moved = await t.admin("PUT", "/api/docs/db-schema/x/origin", { origin: { url: "http://other.example" } }, { "if-match": edited.json().rev });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.deepEqual(moved.json().json.origin, { url: "http://other.example" });
    const dropped = await t.admin("PUT", "/api/docs/db-schema/x/origin", { origin: null }, { "if-match": moved.json().rev });
    assert.equal("origin" in dropped.json().json, false);
    assert.equal("origin" in (await t.user("GET", "/api/docs?type=db-schema")).json().docs[0], false);
    assert.equal((await t.admin("PUT", "/api/docs/db-schema/x/origin", { origin: { url: "ftp://x" } }, { "if-match": dropped.json().rev })).statusCode, 400);
    assert.equal((await t.user("PUT", "/api/docs/db-schema/x/origin", { origin: null }, { "if-match": dropped.json().rev })).statusCode, 403);

    for (const bad of [{ url: "ftp://files.example/a" }, { url: "" }, { url: "https://h", title: "" }]) {
      const b = await t.user("POST", "/api/docs/unclassified", mdDoc("unclassified", "n", "글", { origin: bad }));
      assert.equal(b.statusCode, 400, JSON.stringify(bad));
      assert.ok(b.json().details.some((d) => d.startsWith("$.origin")), b.body);
    }
    const md = await t.user("POST", "/api/docs/unclassified", mdDoc("unclassified", "n", "글", { origin: { url: "https://a.example" } }));
    assert.equal(md.statusCode, 201);
    const batch = await t.admin("POST", "/api/docs/voc/batch", { docs: [mdDoc("voc", "b1", "글", { origin })] });
    assert.equal(batch.statusCode, 201, batch.body);
    assert.deepEqual((await t.user("GET", "/api/docs/voc/b1")).json().json.origin, origin);
  } finally {
    await t.cleanup();
  }
});
