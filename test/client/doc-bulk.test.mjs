import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTIVATE_CHUNK,
  DIALOG_NAMES,
  activateRequests,
  activateToast,
  bulkActions,
  dialogNames,
  headState,
  pickable,
  pickableKeys,
  picksFor,
  rowKey,
  toggleAll,
  togglePicked,
  typeCounts,
} from "../../public/lib/doc-bulk.mjs";

const row = (id, status = "inactive", extra = {}) => ({
  type: "voc",
  id,
  status,
  rev: `rev-${id}`,
  ...extra,
});
const ROWS = [
  row("a"),
  row("b", "active"),
  row("c"),
  row("d", "archived"),
  row("e"),
];
// A tag's list: documents of several types, an id shared across two of them.
const TAGGED = [
  row("a"),
  row("t1", "inactive", { type: "db-schema" }),
  row("a", "inactive", { type: "manual" }),
  row("t2", "active", { type: "db-schema" }),
  row("t3", "inactive", { type: "db-schema" }),
];

test("an active or inactive row gets a box, an archived one none; a pick is kept under type/id", () => {
  assert.deepEqual(
    ROWS.map((d) => pickable(d)),
    [true, true, true, false, true],
  );
  assert.deepEqual(pickableKeys(ROWS), ["voc/a", "voc/b", "voc/c", "voc/e"]);
  assert.equal(rowKey(TAGGED[2]), "manual/a");
  assert.deepEqual(pickableKeys(TAGGED), ["voc/a", "db-schema/t1", "manual/a", "db-schema/t2", "db-schema/t3"]);
});

test("the head box: none · some (indeterminate) · all over the visible active and inactive rows", () => {
  assert.equal(headState(ROWS, new Set()), "none");
  assert.equal(headState(ROWS, new Set(["voc/c"])), "some");
  assert.equal(headState(ROWS, new Set(["voc/a", "voc/c", "voc/e"])), "some");
  assert.equal(headState(ROWS, new Set(["voc/a", "voc/b", "voc/c", "voc/e"])), "all");
  assert.equal(headState([row("d", "archived")], new Set()), "none");
});

test("a press on the head box picks every visible active and inactive row, the next one drops them", () => {
  const all = toggleAll(ROWS, new Set(["voc/c"]));
  assert.deepEqual([...all], ["voc/a", "voc/b", "voc/c", "voc/e"]);
  assert.deepEqual([...toggleAll(ROWS, all)], []);
  // A tag or filter leaves fewer rows: the head box picks those only.
  assert.deepEqual([...toggleAll([row("c"), row("d", "archived")], new Set())], ["voc/c"]);
  // A tag's list: the rows of every type.
  assert.deepEqual([...toggleAll(TAGGED, new Set())], ["voc/a", "db-schema/t1", "manual/a", "db-schema/t2", "db-schema/t3"]);
});

test("the band shows 활성화 for a picked inactive row and 비활성화 for a picked active one", () => {
  assert.deepEqual(bulkActions(ROWS, new Set()), []);
  assert.deepEqual(bulkActions(ROWS, new Set(["voc/a", "voc/c"])), ["activate"]);
  assert.deepEqual(bulkActions(ROWS, new Set(["voc/b"])), ["deactivate"]);
  assert.deepEqual(bulkActions(ROWS, new Set(["voc/a", "voc/b"])), ["activate", "deactivate"]);
});

test("a row box toggles its key and leaves the old set alone", () => {
  const before = new Set(["voc/a"]);
  const after = togglePicked(before, "voc/c");
  assert.deepEqual([...after], ["voc/a", "voc/c"]);
  assert.deepEqual([...before], ["voc/a"]);
  assert.deepEqual([...togglePicked(after, "voc/a")], ["voc/c"]);
});

test("the picks drop when column 2 shows another list, and keep the still-pickable rows of the same one", () => {
  const prev = { scope: "voc", keys: new Set(["voc/a", "voc/c"]) };
  assert.deepEqual([...picksFor(prev, "manual", ROWS).keys], []);
  assert.equal(picksFor(prev, "manual", ROWS).scope, "manual");
  // c was archived meanwhile: the same type keeps a only.
  const now = [row("a"), row("c", "archived")];
  assert.deepEqual([...picksFor(prev, "voc", now).keys], ["voc/a"]);
  assert.deepEqual([...picksFor(null, "voc", ROWS).keys], []);
  // A tag's list is its own scope: leaving it for a type starts empty, coming back keeps.
  const tagged = { scope: "#l1", keys: new Set(["voc/a", "db-schema/t1"]) };
  assert.deepEqual([...picksFor(tagged, "voc", ROWS).keys], []);
  assert.deepEqual([...picksFor(tagged, "#l1", TAGGED).keys], ["voc/a", "db-schema/t1"]);
});

test("the requests: one per type in the list's order, each row's id and list rev", () => {
  assert.deepEqual(activateRequests(ROWS, new Set(["voc/e", "voc/a", "voc/b"])), [
    {
      type: "voc",
      items: [
        { id: "a", rev: "rev-a" },
        { id: "e", rev: "rev-e" },
      ],
    },
  ]);
  assert.deepEqual(activateRequests(TAGGED, new Set(["db-schema/t3", "manual/a", "voc/a", "db-schema/t1", "db-schema/t2"])), [
    { type: "voc", items: [{ id: "a", rev: "rev-a" }] },
    {
      type: "db-schema",
      items: [
        { id: "t1", rev: "rev-t1" },
        { id: "t3", rev: "rev-t3" },
      ],
    },
    { type: "manual", items: [{ id: "a", rev: "rev-a" }] },
  ]);
  assert.deepEqual(activateRequests(ROWS, new Set()), []);
});

test("비활성화 sends the picked active rows only, to …/deactivate one per type", () => {
  assert.deepEqual(activateRequests(ROWS, new Set(["voc/a", "voc/b"]), "deactivate"), [
    { type: "voc", items: [{ id: "b", rev: "rev-b" }] },
  ]);
  assert.deepEqual(activateRequests(TAGGED, new Set(pickableKeys(TAGGED)), "deactivate"), [
    { type: "db-schema", items: [{ id: "t2", rev: "rev-t2" }] },
  ]);
  assert.deepEqual(activateRequests(ROWS, new Set(["voc/a"]), "deactivate"), []);
});

test("more rows of a type than one request carries go in turns of the chunk", () => {
  const many = Array.from({ length: 2 * ACTIVATE_CHUNK + 3 }, (_, i) => row(`d${i}`));
  const reqs = activateRequests(many, new Set(pickableKeys(many)), "activate");
  assert.deepEqual(
    reqs.map((r) => [r.type, r.items.length]),
    [
      ["voc", ACTIVATE_CHUNK],
      ["voc", ACTIVATE_CHUNK],
      ["voc", 3],
    ],
  );
  assert.equal(reqs[1].items[0].id, `d${ACTIVATE_CHUNK}`);
  // A small chunk, to see the order kept across the turns.
  const few = activateRequests(many.slice(0, 5), new Set(pickableKeys(many.slice(0, 5))), "activate", 2);
  assert.deepEqual(
    few.map((r) => r.items.map((it) => it.id)),
    [["d0", "d1"], ["d2", "d3"], ["d4"]],
  );
});

test("the dialog counts the picked rows by type, in the list's order", () => {
  assert.deepEqual(typeCounts(TAGGED), [
    { type: "voc", n: 1 },
    { type: "db-schema", n: 3 },
    { type: "manual", n: 1 },
  ]);
  assert.deepEqual(typeCounts([]), []);
});

test("the dialog names id · title, the first DIALOG_NAMES, then … 외 m", () => {
  assert.deepEqual(
    dialogNames([row("a", "inactive", { title: "RF 드리프트" }), row("b")]),
    { names: ["a · RF 드리프트", "b"], more: 0 },
  );
  const many = Array.from({ length: DIALOG_NAMES + 3 }, (_, i) => row(`d${i}`));
  const { names, more } = dialogNames(many);
  assert.equal(names.length, DIALOG_NAMES);
  assert.equal(names[0], "d0");
  assert.equal(more, 3);
  assert.equal(dialogNames(many.slice(0, DIALOG_NAMES)).more, 0);
});

test("the toast: all on · some failed (a stale rev says someone fixed it first) · the request refused", () => {
  const ok = (results, activated) => ({ status: 200, data: { results, activated } });
  assert.deepEqual(
    activateToast([
      ok(
        [
          { id: "a", status: "active" },
          { id: "c", status: "active" },
        ],
        2,
      ),
    ]),
    { text: "2 개 활성 — 다음 동기화부터 주입됩니다.", error: false },
  );
  assert.equal(
    activateToast([
      ok(
        [
          { id: "a", status: "active" },
          { id: "b", status: "skipped", error: "already_active" },
        ],
        1,
      ),
    ]).text,
    "1 개 활성 · 1 개는 이미 활성 — 다음 동기화부터 주입됩니다.",
  );
  assert.deepEqual(
    activateToast([
      ok(
        [
          { id: "a", status: "active" },
          { id: "c", status: "error", error: "unknown_base_rev", currentRev: "x" },
          { id: "e", status: "error", error: "validation_failed" },
        ],
        1,
      ),
    ]),
    {
      text: "1 개 활성 · 2 개 실패 — 다른 사람이 먼저 고쳤습니다. 목록을 다시 읽으세요",
      error: true,
    },
  );
  assert.equal(
    activateToast([ok([{ id: "e", status: "error", error: "validation_failed" }], 0)]).text,
    "0 개 활성 · 1 개 실패 — 목록을 다시 읽으세요",
  );
  assert.deepEqual(activateToast([{ status: 403, data: { error: "forbidden" } }]), {
    text: "활성화 실패 (403) — forbidden",
    error: true,
  });
  assert.equal(activateToast([{ status: 0, data: null }]).text, "활성화 실패 (0)");
});

test("the toast adds the answers of several requests up; one refused says so and keeps the count that went on", () => {
  const ok = (results, activated) => ({ status: 200, data: { results, activated } });
  assert.deepEqual(
    activateToast([
      ok([{ id: "a", status: "active" }], 1),
      ok(
        [
          { id: "t1", status: "active" },
          { id: "t3", status: "skipped", error: "already_active" },
        ],
        1,
      ),
    ]),
    { text: "2 개 활성 · 1 개는 이미 활성 — 다음 동기화부터 주입됩니다.", error: false },
  );
  assert.deepEqual(
    activateToast([
      ok([{ id: "a", status: "active" }], 1),
      { status: 500, data: { error: "store_error" } },
    ]),
    { text: "활성화 실패 (500) — store_error · 1 개는 활성", error: true },
  );
  assert.equal(
    activateToast([
      ok([{ id: "a", status: "active" }], 1),
      ok([{ id: "t1", status: "error", error: "validation_failed" }], 0),
    ]).text,
    "1 개 활성 · 1 개 실패 — 목록을 다시 읽으세요",
  );
});

test("the 비활성화 toast counts `deactivated` and names the state the rows end in", () => {
  const ok = (results, deactivated) => ({ status: 200, data: { results, deactivated } });
  assert.deepEqual(
    activateToast(
      [
        ok(
          [
            { id: "b", status: "inactive" },
            { id: "c", status: "skipped", error: "already_inactive" },
          ],
          1,
        ),
      ],
      "deactivate",
    ),
    { text: "1 개 비활성 · 1 개는 이미 비활성 — 다음 동기화부터 빠집니다.", error: false },
  );
  assert.deepEqual(activateToast([{ status: 403, data: { error: "forbidden" } }], "deactivate"), {
    text: "비활성화 실패 (403) — forbidden",
    error: true,
  });
});
