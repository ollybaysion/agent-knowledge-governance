import { test } from "node:test";
import assert from "node:assert/strict";

import { ACTIVATE_CHUNK } from "../../public/lib/doc-bulk.mjs";
import { TAGS_MAX } from "../../public/lib/tags.mjs";
import { UNDO, cleanTag, headOf, keepVisible, outcome, plan, requests, runToast } from "../../public/lib/table-bulk.mjs";

const doc = (type, id, status = "active", extra = {}) => ({ type, id, status, rev: `rev-${id}`, tags: [], ...extra });
const rowOf = (d) => ({ key: `${d.type}/${d.id}`, doc: d });
const DOCS = [
  doc("voc", "a", "inactive"),
  doc("voc", "b", "active", { tags: ["rf"] }),
  doc("db-schema", "t1", "inactive"),
  doc("voc", "gone", "archived"),
  doc("manual", "m", "active", { tags: Array.from({ length: TAGS_MAX }, (_, i) => `t${i}`) }),
];

test("a pick the filter hid drops; the head box reads none · some · all over the rows shown", () => {
  const rows = DOCS.slice(0, 3).map(rowOf);
  const picked = new Set(["voc/a", "manual/m"]);
  assert.deepEqual([...keepVisible(rows, picked)], ["voc/a"]);
  assert.equal(headOf(rows, new Set()), "none");
  assert.equal(headOf(rows, new Set(["voc/a"])), "some");
  assert.equal(headOf(rows, new Set(["voc/a", "voc/b", "db-schema/t1"])), "all");
});

test("plan: each action changes the docs it applies to and says why it skips the rest", () => {
  const why = (p) => p.skip.map((s) => `${s.doc.id}:${s.why}`);
  const on = plan(DOCS, "activate");
  assert.deepEqual(on.change.map((d) => d.id), ["a", "t1"]);
  assert.deepEqual(why(on), ["b:이미 활성", "gone:폐기된 문서", "m:이미 활성"]);
  assert.deepEqual(plan(DOCS, "deactivate").change.map((d) => d.id), ["b", "m"]);
  const tag = plan(DOCS, "tag", { tag: "rf" });
  assert.deepEqual(tag.change.map((d) => d.id), ["a", "t1"]);
  assert.deepEqual(why(tag), ["b:이미 붙음", "gone:폐기된 문서", `m:태그가 이미 ${TAGS_MAX} 개`]);
  assert.deepEqual(plan(DOCS, "untag", { tag: "rf" }).change.map((d) => d.id), ["b"]);
});

test("cleanTag: trims, drops a leading #, lower-cases; null when the rule fails", () => {
  assert.equal(cleanTag("  #RF-Power "), "rf-power");
  assert.equal(cleanTag("한글"), null);
  assert.equal(cleanTag(""), null);
  assert.equal(cleanTag("x".repeat(33)), null);
});

test("requests: activate goes per type in chunks; deactivate and tags go per doc with If-Match", () => {
  const many = Array.from({ length: 5 }, (_, i) => doc("voc", `v${i}`, "inactive"));
  const on = requests("activate", [...many, doc("db-schema", "t1", "inactive")], { max: 2 });
  assert.deepEqual(on.map((r) => `${r.path} ${r.body.items.length}`), ["/api/docs/voc/activate 2", "/api/docs/voc/activate 2", "/api/docs/voc/activate 1", "/api/docs/db-schema/activate 1"]);
  assert.deepEqual(on[0].body.items[0], { id: "v0", rev: "rev-v0" });
  assert.deepEqual(on[0].keys, ["voc/v0", "voc/v1"]);
  assert.equal(requests("activate", many).length, Math.ceil(many.length / ACTIVATE_CHUNK));
  const off = requests("deactivate", [doc("voc", "x y")]);
  assert.deepEqual(off, [{ method: "POST", path: "/api/docs/voc/x%20y/deactivate", body: undefined, ifMatch: "rev-x y", keys: ["voc/x y"] }]);
  const add = requests("tag", [doc("voc", "b", "active", { tags: ["old"] })], { tag: "rf" });
  assert.deepEqual(add[0].body, { tags: ["old", "rf"] });
  assert.equal(add[0].method, "PUT");
  assert.deepEqual(requests("untag", [doc("voc", "b", "active", { tags: ["old", "rf"] })], { tag: "rf" })[0].body, { tags: ["old"] });
  assert.equal(UNDO.tag, "untag");
  assert.equal(UNDO.activate, "deactivate");
});

test("outcome: per doc — done, already so, failed with the reason, from bulk and single answers", () => {
  const [bulk] = requests("activate", [doc("voc", "a", "inactive"), doc("voc", "b", "inactive"), doc("voc", "c", "inactive")]);
  const [one, two, three] = requests("deactivate", [doc("voc", "x"), doc("voc", "y"), doc("voc", "z")]);
  const res = outcome([
    { req: bulk, status: 200, data: { results: [{ id: "a", status: "active" }, { id: "b", status: "skipped", error: "already_active" }, { id: "c", status: "error", error: "unknown_base_rev" }], activated: 1 } },
    { req: one, status: 200, data: { rev: "r2" } },
    { req: two, status: 200, data: { rev: "r", unchanged: true } },
    { req: three, status: 409, data: { error: "unknown_base_rev" } },
  ]);
  assert.deepEqual(res.done, ["voc/a", "voc/x"]);
  assert.deepEqual(res.same, ["voc/b", "voc/y"]);
  assert.deepEqual(res.failed, [{ key: "voc/c", why: "다른 사람이 먼저 고쳤습니다" }, { key: "voc/z", why: "다른 사람이 먼저 고쳤습니다" }]);
  // a whole bulk request refused, or never sent: every doc in it failed
  const down = outcome([{ req: bulk, status: 0, data: null }]);
  assert.deepEqual(down.failed.map((f) => f.why), ["서버에 닿지 않았습니다", "서버에 닿지 않았습니다", "서버에 닿지 않았습니다"]);
});

test("the toast counts what changed, what was so already and what failed; an undo says so", () => {
  assert.deepEqual(runToast("activate", { done: ["a", "b"], same: [], failed: [] }), { text: "2 개 활성 — 다음 동기화부터 주입됩니다.", error: false });
  assert.deepEqual(runToast("tag", { done: ["a"], same: ["b"], failed: [{ key: "c", why: "다른 사람이 먼저 고쳤습니다" }] }, { tag: "rf" }), { text: "1 개 #rf 붙임 · 1 개는 이미 그 상태 · 1 개 실패 — 다른 사람이 먼저 고쳤습니다", error: true });
  assert.equal(runToast("deactivate", { done: ["a"], same: [], failed: [] }, { undo: true }).text, "되돌림: 1 개 비활성");
});
