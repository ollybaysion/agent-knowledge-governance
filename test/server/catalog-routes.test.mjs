// The routes that read the catalog (server/catalog.mjs) answer what the old
// routes answered by reading every document file. The old answers are
// rebuilt here from the files, after a run of every kind of write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseWikilinks, wikiTexts } from "../../src/wikilinks.mjs";
import { buildApp } from "../../server/app.mjs";
import { activeTableUses, tableClassOf } from "../../server/data-ids.mjs";
import { archiveDoc, withAbsorbed } from "../../server/render-store.mjs";
import { tierSummary } from "../../server/slots.mjs";
import { changedAtOfPath, listIds, readJson, revOfPath } from "../../server/store.mjs";
import { tagQuery } from "../../server/routes/docs.mjs";
import { signIn, as } from "../sign-in.mjs";

const EXAMPLES = new URL("../../examples/", import.meta.url);
const example = (p) => JSON.parse(readFileSync(new URL(p, EXAMPLES), "utf8"));

// ---- the old routes, reading the files ----

const exists = (storeDir, type, id) => !!readJson(storeDir, `${type}/${id}.json`);

function oldWikilinks(storeDir, typeIds, type, doc) {
  return parseWikilinks(wikiTexts(type, doc.body)).map(({ text, type: t, id }) => {
    if (id === null) return { text, type: null, id: null, found: false };
    if (t !== null) return { text, type: t, id, found: typeIds.includes(t) && exists(storeDir, t, id) };
    const hits = typeIds.filter((tt) => exists(storeDir, tt, id));
    if (hits.length === 1) return { text, type: hits[0], id, found: true };
    return hits.length > 1 ? { text, type: null, id, found: false, types: hits } : { text, type: null, id, found: false };
  });
}

function oldList(storeDir, types, { type, tier, q, absorbed, tag } = {}) {
  const wanted = tagQuery(tag);
  const docs = [];
  const typeIds = types.ids();
  let uses = null;
  for (const t of type ? [type] : typeIds) {
    const bodySchema = types.bodySchema(t);
    if (!bodySchema) continue;
    for (const id of listIds(storeDir, t)) {
      const doc = readJson(storeDir, `${t}/${id}.json`);
      if (!doc) continue;
      if (q && !id.includes(q)) continue;
      if (!wanted.tags.every((x) => (doc.tags ?? []).includes(x))) continue;
      const tiers = tierSummary(bodySchema, doc.body);
      if (tier && !tiers[tier]) continue;
      const rev = revOfPath(storeDir, `${t}/${id}.json`);
      const mark = withAbsorbed(storeDir, t, doc).absorbed;
      if (absorbed === "stale" && mark?.rev === rev) continue;
      const b = doc.body ?? {};
      const wikilinks = oldWikilinks(storeDir, typeIds, t, doc).map(({ text, type: tt, id: ii, found }) => ({ text, type: tt, id: ii, found }));
      docs.push({
        type: t,
        id,
        status: doc.status,
        tiers,
        keywords: doc.keywords ?? [],
        tags: doc.tags ?? [],
        assetCount: (doc.assets ?? []).length,
        links: doc.links ?? [],
        title: b.title ?? b.name ?? b.table ?? b.command ?? null,
        ...(doc.origin ? { origin: doc.origin } : {}),
        ...(t === "domain-skill" ? { role: doc.role ?? "main" } : {}),
        ...(t === "db-schema"
          ? {
              ...(doc.body?.kind ? { kind: doc.body.kind } : {}),
              ...(doc.body?.unusedColumns ? { unusedColumns: doc.body.unusedColumns } : {}),
              ...tableClassOf(doc, (uses ??= activeTableUses(storeDir))),
              columns: (doc.body?.catalog?.columns ?? []).map((c) => c.name),
            }
          : {}),
        rev,
        updatedAt: changedAtOfPath(storeDir, `${t}/${id}.json`),
        ...(mark ? { absorbed: mark } : {}),
        ...(wikilinks.length ? { wikilinks } : {}),
      });
    }
  }
  return { docs };
}

function oldTags(storeDir, types) {
  const tags = {};
  for (const t of types.ids())
    for (const id of listIds(storeDir, t)) {
      const doc = readJson(storeDir, `${t}/${id}.json`);
      if (!doc || doc.status === "archived") continue;
      for (const x of doc.tags ?? []) tags[x] = (tags[x] ?? 0) + 1;
    }
  return { tags };
}

const oldCount = (storeDir, type) =>
  listIds(storeDir, type).filter((id) => {
    const d = readJson(storeDir, `${type}/${id}.json`);
    return d && d.status !== "archived";
  }).length;

function oldBacklinks(storeDir, typeIds, type, id) {
  const out = [];
  for (const t of typeIds)
    for (const sid of listIds(storeDir, t)) {
      const doc = readJson(storeDir, `${t}/${sid}.json`);
      for (const l of doc?.links ?? []) if (l.type === type && l.id === id) out.push({ type: t, id: sid, rel: l.rel, status: doc.status });
    }
  return out;
}

// ---- the store ----

function table(name, extra = {}, purpose = { text: null, tier: "scaffold" }) {
  return {
    schema: "db-schema/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    ...extra,
    body: {
      owner: "T",
      table: name.toUpperCase(),
      catalog: {
        columns: [
          { name: "A", type: "NUMBER", nullable: false },
          { name: "B_COL", type: "VARCHAR2(10)", nullable: true },
        ],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose,
      columnDescs: { A: { text: "열 A", tier: "inferred", evidence: ["src/a.ts:1"] }, B_COL: { text: null, tier: "scaffold" } },
    },
  };
}

const mdDoc = (type, name, markdown) => ({
  schema: `${type}/v1`,
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown },
});

test("after create · edit · archive · delete · retype · tags · origin · links · promote · absorbed, the routes answer as the files say", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-catalog-routes-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const { types } = app.akg;
  const call = async (method, url, payload, headers = {}) => {
    const res = await app.inject({ method, url, headers: { ...as("a"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
    assert.ok(res.statusCode < 300, `${method} ${url}: ${res.statusCode} ${res.body}`);
    return res.json();
  };
  const revOf = async (type, id) => (await call("GET", `/api/docs/${type}/${id}`)).rev;
  const ifMatch = async (type, id) => ({ "if-match": await revOf(type, id) });

  // Every list query, the tags, the counts and each doc's links against the files.
  async function assertSameAsFiles(step) {
    const queries = [{}, { type: "db-schema" }, { tier: "inferred" }, { q: "fdc" }, { absorbed: "stale" }, { tag: "etch" }, { type: "meeting-notes" }];
    for (const query of queries) {
      const url = `/api/docs?${new URLSearchParams(query)}`;
      assert.deepEqual(await call("GET", url), oldList(storeDir, types, query), `${step}: ${url}`);
    }
    assert.deepEqual(await call("GET", "/api/tags"), oldTags(storeDir, types), `${step}: tags`);
    const listed = await call("GET", "/api/types");
    for (const t of listed.types) assert.equal(t.count, oldCount(storeDir, t.id), `${step}: count ${t.id}`);
    const typeIds = types.ids();
    for (const t of typeIds)
      for (const id of listIds(storeDir, t)) {
        const view = await call("GET", `/api/docs/${t}/${id}`);
        const doc = readJson(storeDir, `${t}/${id}.json`);
        assert.deepEqual(view.backlinks, oldBacklinks(storeDir, typeIds, t, id), `${step}: backlinks ${t}/${id}`);
        assert.deepEqual(view.wikilinks, oldWikilinks(storeDir, typeIds, t, doc), `${step}: wikilinks ${t}/${id}`);
        assert.deepEqual(
          view.links,
          (doc.links ?? []).map((l) => ({ ...l, status: readJson(storeDir, `${l.type}/${l.id}.json`)?.status ?? "missing" })),
          `${step}: links ${t}/${id}`,
        );
      }
  }

  try {
    await call("POST", "/api/docs/db-schema", table("fdc_sensor", { tags: ["etch"] }));
    await call("POST", "/api/docs/db-schema", table("fdc_chamber", { links: [{ type: "db-schema", id: "fdc_sensor", rel: "related" }] }));
    await call("POST", "/api/docs/db-schema", table("t_b"));
    await call("POST", "/api/docs/domain-skill", example("domain-skill/fdc-explain-sensor-origin.json"));
    await call("POST", "/api/docs/msg-format", example("msg-format/cmd-start-lot.json"));
    await call("POST", "/api/docs/voc", mdDoc("voc", "v1", "# v1\n\n[[fdc_sensor]] 와 [[db-schema/nope]] 참고\n"));
    await call("PUT", "/api/types/meeting-notes", { label: "회의록", color: "#7a4bd7" });
    await assertSameAsFiles("seed");

    // 생성
    await call("POST", "/api/docs/db-schema", table("t_new", {}, { text: "[[t_b]] 와 조인", tier: "inferred", evidence: ["src/x.ts:1"] }));
    await assertSameAsFiles("create");
    // 수정
    await call("PUT", "/api/docs/db-schema/t_b", { ...table("t_b").body, purpose: { text: "[[fdc_chamber]] 의 짝", tier: "inferred", evidence: ["review:1"] } }, await ifMatch("db-schema", "t_b"));
    await assertSameAsFiles("edit");
    // 보관
    await archiveDoc(storeDir, "db-schema", readJson(storeDir, "db-schema/fdc_chamber.json"), { author: "renoir", message: "archive" });
    await assertSameAsFiles("archive");
    // tags PUT
    await call("PUT", "/api/docs/db-schema/t_b/tags", { tags: ["etch", "hot"] }, await ifMatch("db-schema", "t_b"));
    await assertSameAsFiles("tags");
    // origin PUT
    await call("PUT", "/api/docs/msg-format/cmd-start-lot/origin", { origin: { url: "https://wiki.example/1" } }, await ifMatch("msg-format", "cmd-start-lot"));
    await assertSameAsFiles("origin");
    // links PUT
    await call("PUT", "/api/docs/msg-format/cmd-start-lot/links", { links: [{ type: "voc", id: "v1", rel: "related" }] }, await ifMatch("msg-format", "cmd-start-lot"));
    await assertSameAsFiles("links");
    // promote
    await call("POST", "/api/docs/db-schema/t_new/promote", {}, await ifMatch("db-schema", "t_new"));
    await assertSameAsFiles("promote");
    // absorbed 사이드카
    await call("PUT", "/api/docs/db-schema/t_new/absorbed", { rev: await revOf("db-schema", "t_new") });
    await assertSameAsFiles("absorbed");
    // 타입 옮기기: the links pointing at it follow
    await call("POST", "/api/docs/voc/v1/retype", { type: "meeting-notes" }, await ifMatch("voc", "v1"));
    assert.deepEqual(readJson(storeDir, "msg-format/cmd-start-lot.json").links, [{ type: "meeting-notes", id: "v1", rel: "related" }]);
    await assertSameAsFiles("retype");
    // 삭제: the links pointing at it go
    await call("DELETE", "/api/docs/db-schema/fdc_sensor", undefined, await ifMatch("db-schema", "fdc_sensor"));
    assert.equal(readJson(storeDir, "db-schema/fdc_chamber.json").links, undefined);
    await assertSameAsFiles("delete");
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
