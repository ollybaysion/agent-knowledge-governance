// 정리: the curator's 중복 후보 and 흡수 기록 (server/routes/curation.mjs),
// and what an admin decides about them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { pairKey, parseKey, sightPair } from "../../server/curation.mjs";
import { signIn, as } from "../sign-in.mjs";

const md = (type, id, markdown, status = "active") => ({
  schema: `${type}/v1`,
  id,
  keywords: [{ kw: id, inject: "pointer" }],
  status,
  body: { name: id, markdown },
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-curation-test-"));
  const auth = await signIn(home, [
    { id: "kim", group: "admin", token: "admin-pw" },
    { id: "lee", group: "user", token: "user-pw" },
    { id: "curator", group: "agent", token: "bot-pw" },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const call = (token) => (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as(token), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const admin = call("admin-pw");
  const create = async (type, id, markdown, status) => {
    const r = await admin("POST", `/api/docs/${type}`, md(type, id, markdown, status));
    assert.equal(r.statusCode, 201, r.body);
    return r.json().rev;
  };
  return {
    storeDir,
    admin,
    user: call("user-pw"),
    agent: call("bot-pw"),
    create,
    revOf: async (type, id) => (await admin("GET", `/api/docs/${type}/${id}`)).json().rev,
    lastCommit: () => execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%an|%s"], { encoding: "utf8" }).trim(),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const pairsBody = (pairs, runId = "curator:2026-11-11T03:30") => ({ runId, model: "bge-m3", pairs });

// Two documents and the curator's pair of them, posted once.
async function withPair(t) {
  const revU = await t.create("unclassified", "fdc-app--x-1a2b3c", "# 알람\n\n알람 설명\n", "inactive");
  const revV = await t.create("voc", "alarm-guide", "# 알람 안내\n\n## 원인\n\n센서\n");
  const pair = { a: { type: "voc", id: "alarm-guide", rev: revV }, b: { type: "unclassified", id: "fdc-app--x-1a2b3c", rev: revU }, score: 0.93 };
  const r = await t.agent("POST", "/api/curation/duplicates", pairsBody([pair]));
  assert.equal(r.statusCode, 200, r.body);
  return { revU, revV, pair, key: "unclassified~fdc-app--x-1a2b3c~voc~alarm-guide" };
}

// The curator's whole absorption: target PUT, source mark, record.
async function absorb(t) {
  const revU = await t.create("unclassified", "note-1", "# 메모\n\n센서 교체 주기는 3 개월\n", "inactive");
  const fromRev = await t.create("voc", "sensor-guide", "# 센서 안내\n\n## 교체\n\n주기 미정\n");
  const put = await t.agent(
    "PUT",
    "/api/docs/voc/sensor-guide",
    { name: "sensor-guide", markdown: "# 센서 안내\n\n## 교체\n\n주기 미정\n\n센서 교체 주기는 3 개월이다.\n" },
    { "if-match": fromRev, "x-akg-note": encodeURIComponent("흡수: unclassified/note-1") },
  );
  assert.equal(put.statusCode, 200, put.body);
  const toRev = put.json().rev;
  const mark = await t.agent("PUT", "/api/docs/unclassified/note-1/absorbed", { rev: revU });
  assert.equal(mark.statusCode, 200, mark.body);
  const body = {
    runId: "curator:2026-11-11T03:30",
    model: "gpt-x",
    source: { type: "unclassified", id: "note-1", rev: revU },
    target: { type: "voc", id: "sensor-guide", fromRev, toRev },
    summary: "센서 교체 주기 3 개월을 교체 절에 붙였다.",
    score: 0.88,
  };
  const rec = await t.agent("POST", "/api/curation/absorptions", body);
  assert.equal(rec.statusCode, 201, rec.body);
  return { revU, fromRev, toRev, body, id: rec.json().id };
}

test("pair key: the two addresses sorted, and parseKey reads them back", () => {
  const x = { type: "voc", id: "z" };
  const y = { type: "unclassified", id: "a" };
  assert.equal(pairKey(x, y), "unclassified~a~voc~z");
  assert.equal(pairKey(y, x), "unclassified~a~voc~z");
  assert.deepEqual(parseKey("unclassified~a~voc~z"), { a: y, b: x });
  assert.equal(parseKey("voc~z~unclassified~a"), null); // not sorted
  assert.equal(parseKey("voc~a~voc~a"), null);
  assert.equal(parseKey("voc~a"), null);
  assert.equal(parseKey("voc~..~voc~b"), null);
});

test("sightPair: a decided pair stays while both revs are the decided ones", () => {
  const seen = { key: "k", a: { type: "voc", id: "a", rev: "1" }, b: { type: "voc", id: "b", rev: "2" }, score: 0.9 };
  const ctx = { runId: "r", model: "m", at: "t2" };
  const stored = { key: "k", ...seen, status: "dismissed", firstSeenAt: "t1", decision: { status: "dismissed", revs: { a: "1", b: "2" } } };
  assert.equal(sightPair(stored, seen, ctx).outcome, "kept");
  const moved = sightPair(stored, { ...seen, b: { ...seen.b, rev: "3" } }, ctx);
  assert.equal(moved.outcome, "opened");
  assert.equal(moved.pair.status, "open");
  assert.equal(moved.pair.decision, undefined);
  assert.equal(moved.pair.firstSeenAt, "t1");
  assert.equal(sightPair(null, seen, ctx).pair.firstSeenAt, "t2");
  assert.equal(sightPair({ ...stored, status: "open", decision: undefined }, seen, ctx).outcome, "updated");
});

test("POST duplicates: the key sorts the pair, the same pair again is updated, the list carries both documents", async () => {
  const t = await setup();
  try {
    const { revU, revV, pair, key } = await withPair(t);
    assert.equal(t.lastCommit(), "curator|duplicates curator:2026-11-11T03:30: 열림 1 · 고침 0 · 그대로 0");
    // b and a the other way round: the same key.
    const again = await t.agent("POST", "/api/curation/duplicates", pairsBody([{ a: pair.b, b: pair.a, score: 0.95 }], "curator:2"));
    assert.deepEqual(again.json(), { opened: 0, updated: 1, kept: 0, skipped: [] });

    const list = await t.user("GET", "/api/curation/duplicates");
    assert.equal(list.statusCode, 200);
    const [p] = list.json().pairs;
    assert.equal(p.key, key);
    assert.equal(p.status, "open");
    assert.equal(p.score, 0.95);
    assert.equal(p.runId, "curator:2");
    assert.ok(p.firstSeenAt <= p.seenAt);
    assert.deepEqual(
      { type: p.a.type, id: p.a.id, rev: p.a.rev, status: p.a.status, exists: p.a.exists, currentRev: p.a.currentRev },
      { type: "unclassified", id: "fdc-app--x-1a2b3c", rev: revU, status: "inactive", exists: true, currentRev: revU },
    );
    assert.equal(p.b.title, "alarm-guide");
    assert.equal(p.b.status, "active");
    assert.equal(p.b.currentRev, revV);
    assert.ok(existsSync(join(t.storeDir, `curation/duplicates/${key}.json`)));
    assert.equal((await t.user("GET", "/api/curation/duplicates?status=dismissed")).json().pairs.length, 0);
    assert.equal((await t.user("GET", "/api/curation/duplicates?status=nope")).statusCode, 400);
  } finally {
    await t.cleanup();
  }
});

test("POST duplicates: a bad body is 400 with each pair's error; a pair naming a missing document is skipped", async () => {
  const t = await setup();
  try {
    const revV = await t.create("voc", "a", "# a\n");
    const a = { type: "voc", id: "a", rev: revV };
    const bad = await t.agent("POST", "/api/curation/duplicates", pairsBody([{ a, b: a, score: 0.9 }, { a, b: { type: "voc", id: "b", rev: "x" }, score: 0.9 }, { a, b: { ...a, id: "c" }, score: 2 }]));
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(bad.json().rejected.map((r) => r.error), ["same_doc", "invalid_doc", "invalid_score"]);
    assert.equal((await t.agent("POST", "/api/curation/duplicates", { model: "m", pairs: [] })).json().error, "invalid_run_id");
    assert.equal((await t.agent("POST", "/api/curation/duplicates", pairsBody([]))).json().error, "pairs_required");

    const gone = await t.agent("POST", "/api/curation/duplicates", pairsBody([{ a, b: { type: "voc", id: "gone", rev: revV }, score: 0.9 }]));
    assert.equal(gone.statusCode, 200);
    assert.deepEqual(gone.json(), { opened: 0, updated: 0, kept: 0, skipped: [{ index: 0, key: "voc~a~voc~gone", error: "not_found", doc: "voc/gone" }] });
  } finally {
    await t.cleanup();
  }
});

test("dismiss: the pair stays dismissed while both revs stand, and opens again once one changes", async () => {
  const t = await setup();
  try {
    const { pair, key } = await withPair(t);
    const d = await t.admin("POST", `/api/curation/duplicates/${key}/dismiss`);
    assert.equal(d.statusCode, 200, d.body);
    assert.equal(d.json().pair.status, "dismissed");
    assert.equal(d.json().pair.decision.by, "kim");
    assert.equal(t.lastCommit(), `kim|dismiss duplicate ${key}`);

    const same = await t.agent("POST", "/api/curation/duplicates", pairsBody([pair]));
    assert.deepEqual(same.json(), { opened: 0, updated: 0, kept: 1, skipped: [] });
    assert.equal((await t.user("GET", "/api/curation/duplicates?status=dismissed")).json().pairs.length, 1);

    const put = await t.admin("PUT", "/api/docs/voc/alarm-guide", { name: "alarm-guide", markdown: "# 알람 안내\n\n## 원인\n\n센서 고장\n" }, { "if-match": pair.a.rev });
    assert.equal(put.statusCode, 200);
    const moved = await t.agent("POST", "/api/curation/duplicates", pairsBody([{ ...pair, a: { ...pair.a, rev: put.json().rev } }]));
    assert.deepEqual(moved.json(), { opened: 1, updated: 0, kept: 0, skipped: [] });
    const [p] = (await t.user("GET", "/api/curation/duplicates?status=open")).json().pairs;
    assert.equal(p.key, key);
    assert.equal(p.decision, undefined);
  } finally {
    await t.cleanup();
  }
});

test("resolve: same rule as dismiss; an unknown key is 404, a malformed one 400", async () => {
  const t = await setup();
  try {
    const { pair, key } = await withPair(t);
    const r = await t.admin("POST", `/api/curation/duplicates/${key}/resolve`);
    assert.equal(r.json().pair.status, "resolved");
    assert.equal((await t.agent("POST", "/api/curation/duplicates", pairsBody([pair]))).json().kept, 1);
    assert.equal((await t.admin("POST", "/api/curation/duplicates/voc~a~voc~b/resolve")).statusCode, 404);
    assert.equal((await t.admin("POST", "/api/curation/duplicates/not-a-key/resolve")).statusCode, 400);
  } finally {
    await t.cleanup();
  }
});

test("a pair resolves when one of its documents is deleted or retyped", async () => {
  const t = await setup();
  try {
    const { key, revV } = await withPair(t);
    const revW = await t.create("voc", "other", "# 다른 안내\n");
    const k2 = pairKey({ type: "voc", id: "alarm-guide" }, { type: "voc", id: "other" });
    await t.agent("POST", "/api/curation/duplicates", pairsBody([{ a: { type: "voc", id: "alarm-guide", rev: revV }, b: { type: "voc", id: "other", rev: revW }, score: 0.9 }]));

    const re = await t.admin("POST", "/api/docs/unclassified/fdc-app--x-1a2b3c/retype", { type: "voc" }, { "if-match": await t.revOf("unclassified", "fdc-app--x-1a2b3c") });
    assert.equal(re.statusCode, 200, re.body);
    const del = await t.admin("DELETE", "/api/docs/voc/other", undefined, { "if-match": revW });
    assert.equal(del.statusCode, 200, del.body);

    const pairs = (await t.user("GET", "/api/curation/duplicates?status=resolved")).json().pairs;
    const by = Object.fromEntries(pairs.map((p) => [p.key, p]));
    assert.equal(by[key].decision.reason, "retyped");
    assert.equal(by[key].a.exists, false);
    assert.equal(by[k2].decision.reason, "deleted");
    assert.equal(by[k2].decision.by, "kim");
    assert.equal((await t.user("GET", "/api/curation/duplicates?status=open")).json().pairs.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("absorption: the curator's flow lands a record the list shows, newest first; a retried POST is the same record", async () => {
  const t = await setup();
  try {
    const { id, body, toRev, revU } = await absorb(t);
    assert.match(t.lastCommit(), /^curator\|absorption unclassified\/note-1 → voc\/sensor-guide/);
    const again = await t.agent("POST", "/api/curation/absorptions", body);
    assert.equal(again.statusCode, 200);
    assert.deepEqual(again.json(), { id, deduped: true });

    const [rec] = (await t.user("GET", "/api/curation/absorptions")).json().absorptions;
    assert.equal(rec.id, id);
    assert.equal(rec.status, "applied");
    assert.equal(rec.by, "curator");
    assert.equal(rec.summary, body.summary);
    assert.equal(rec.model, "gpt-x");
    assert.equal(rec.source.marked, true);
    assert.equal(rec.source.rev, revU);
    assert.equal(rec.target.currentRev, toRev);
    assert.equal(rec.revertable, true);

    const one = await t.user("GET", `/api/curation/absorptions/${id}`);
    assert.equal(one.statusCode, 200);
    assert.equal(one.json().before.markdown, "# 센서 안내\n\n## 교체\n\n주기 미정\n");
    assert.match(one.json().after.markdown, /3 개월이다/);
    assert.equal((await t.user("GET", "/api/curation/absorptions/nope")).statusCode, 404);
  } finally {
    await t.cleanup();
  }
});

test("absorption: a rev the document never had is 400, so is a bad body", async () => {
  const t = await setup();
  try {
    const { body } = await absorb(t);
    const wrong = await t.agent("POST", "/api/curation/absorptions", { ...body, target: { ...body.target, fromRev: "0".repeat(40) } });
    assert.equal(wrong.statusCode, 400);
    assert.deepEqual(wrong.json(), { error: "unknown_rev", param: "target.fromRev" });
    assert.equal((await t.agent("POST", "/api/curation/absorptions", { ...body, summary: "" })).json().error, "invalid_summary");
    assert.equal((await t.agent("POST", "/api/curation/absorptions", { ...body, target: { ...body.target, type: "nosuch" } })).json().error, "unknown_type");
    assert.equal((await t.agent("POST", "/api/curation/absorptions", { ...body, source: { ...body.target, rev: body.source.rev } })).json().error, "same_doc");
  } finally {
    await t.cleanup();
  }
});

test("revert: the target goes back to its fromRev body in a new commit, the source's mark goes, the record is reverted", async () => {
  const t = await setup();
  try {
    const { id, revU } = await absorb(t);
    const r = await t.admin("POST", `/api/curation/absorptions/${id}/revert`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().unmarked, true);
    assert.equal(r.json().absorption.status, "reverted");
    assert.equal(r.json().absorption.revert.by, "kim");
    assert.match(t.lastCommit(), new RegExp(`^kim\\|revert absorption ${id}: voc/sensor-guide → `));

    const doc = (await t.user("GET", "/api/docs/voc/sensor-guide")).json();
    assert.equal(doc.json.body.markdown, "# 센서 안내\n\n## 교체\n\n주기 미정\n");
    assert.equal(doc.rev, r.json().rev);
    const src = (await t.user("GET", "/api/docs/unclassified/note-1")).json();
    assert.equal(src.json.absorbed, undefined);
    assert.equal(src.rev, revU);
    const stale = (await t.agent("GET", "/api/docs?type=unclassified&absorbed=stale")).json().docs.map((d) => d.id);
    assert.deepEqual(stale, ["note-1"]);

    const twice = await t.admin("POST", `/api/curation/absorptions/${id}/revert`);
    assert.equal(twice.statusCode, 409);
    assert.equal(twice.json().error, "already_reverted");
    assert.equal((await t.user("GET", "/api/curation/absorptions?status=reverted")).json().absorptions.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("revert: a target someone edited after the absorption is 409, and nothing changes", async () => {
  const t = await setup();
  try {
    const { id, toRev } = await absorb(t);
    const edit = await t.admin("PUT", "/api/docs/voc/sensor-guide", { name: "sensor-guide", markdown: "# 센서 안내\n\n## 교체\n\n사람이 고침\n" }, { "if-match": toRev });
    assert.equal(edit.statusCode, 200);
    const r = await t.admin("POST", `/api/curation/absorptions/${id}/revert`);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, "target_changed");
    assert.equal(r.json().currentRev, edit.json().rev);
    const [rec] = (await t.user("GET", "/api/curation/absorptions")).json().absorptions;
    assert.equal(rec.status, "applied");
    assert.equal(rec.revertable, false);
    assert.equal(rec.source.marked, true);
  } finally {
    await t.cleanup();
  }
});

test("revert: a source absorbed again since keeps its newer mark", async () => {
  const t = await setup();
  try {
    const { id } = await absorb(t);
    // The source changes and is marked again, for a later absorption.
    const cur = await t.revOf("unclassified", "note-1");
    const ed = await t.admin("PUT", "/api/docs/unclassified/note-1", { name: "note-1", markdown: "# 메모\n\n고친 메모\n" }, { "if-match": cur });
    await t.agent("PUT", "/api/docs/unclassified/note-1/absorbed", { rev: ed.json().rev });
    const r = await t.admin("POST", `/api/curation/absorptions/${id}/revert`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().unmarked, false);
    assert.equal((await t.user("GET", "/api/docs/unclassified/note-1")).json().json.absorbed.rev, ed.json().rev);
  } finally {
    await t.cleanup();
  }
});

test("revert: a deleted target is 409 target_missing", async () => {
  const t = await setup();
  try {
    const { id, toRev } = await absorb(t);
    assert.equal((await t.admin("DELETE", "/api/docs/voc/sensor-guide", undefined, { "if-match": toRev })).statusCode, 200);
    const r = await t.admin("POST", `/api/curation/absorptions/${id}/revert`);
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, "target_missing");
    const [rec] = (await t.user("GET", "/api/curation/absorptions")).json().absorptions;
    assert.equal(rec.target.exists, false);
    assert.equal(rec.revertable, false);
  } finally {
    await t.cleanup();
  }
});

test("who may: agent writes the records, user and agent read them, admin alone decides", async () => {
  const t = await setup();
  try {
    const { pair, key } = await withPair(t);
    const { body, id } = await absorb(t);
    // write: agent and admin; user 403
    assert.equal((await t.user("POST", "/api/curation/duplicates", pairsBody([pair]))).statusCode, 403);
    assert.equal((await t.admin("POST", "/api/curation/duplicates", pairsBody([pair]))).statusCode, 200);
    assert.equal((await t.user("POST", "/api/curation/absorptions", body)).statusCode, 403);
    // read: user · agent · admin
    for (const who of [t.user, t.agent, t.admin]) {
      assert.equal((await who("GET", "/api/curation/duplicates")).statusCode, 200);
      assert.equal((await who("GET", "/api/curation/absorptions")).statusCode, 200);
      assert.equal((await who("GET", `/api/curation/absorptions/${id}`)).statusCode, 200);
    }
    // decide: admin only
    for (const who of [t.user, t.agent]) {
      assert.equal((await who("POST", `/api/curation/duplicates/${key}/dismiss`)).statusCode, 403);
      assert.equal((await who("POST", `/api/curation/duplicates/${key}/resolve`)).statusCode, 403);
      assert.equal((await who("POST", `/api/curation/absorptions/${id}/revert`)).statusCode, 403);
    }
    // the source mark: agent and admin, as before
    assert.equal((await t.user("PUT", "/api/docs/unclassified/note-1/absorbed", { rev: body.source.rev })).statusCode, 403);
    // a wrong token: 401
    assert.equal((await t.agent("GET", "/api/curation/duplicates", undefined, { authorization: "Bearer wrong" })).statusCode, 401);
  } finally {
    await t.cleanup();
  }
});

test("curation is a reserved type id: no type takes the store folder", async () => {
  const t = await setup();
  try {
    const r = await t.admin("PUT", "/api/types/curation", { label: "정리", color: "#336699" });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, "reserved_type_id");
  } finally {
    await t.cleanup();
  }
});
