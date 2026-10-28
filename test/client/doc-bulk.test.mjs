import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIALOG_NAMES,
  activateBody,
  activateToast,
  dialogNames,
  headState,
  pickable,
  pickableIds,
  picksFor,
  toggleAll,
  togglePicked,
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

test("only an inactive row gets a box", () => {
  assert.deepEqual(
    ROWS.map((d) => pickable(d)),
    [true, false, true, false, true],
  );
  assert.deepEqual(pickableIds(ROWS), ["a", "c", "e"]);
});

test("the head box: none · some (indeterminate) · all over the visible inactive rows", () => {
  assert.equal(headState(ROWS, new Set()), "none");
  assert.equal(headState(ROWS, new Set(["c"])), "some");
  assert.equal(headState(ROWS, new Set(["a", "c", "e"])), "all");
  assert.equal(headState([row("b", "active")], new Set()), "none");
});

test("a press on the head box picks every visible inactive row, the next one drops them", () => {
  const all = toggleAll(ROWS, new Set(["c"]));
  assert.deepEqual([...all], ["a", "c", "e"]);
  assert.deepEqual([...toggleAll(ROWS, all)], []);
  // A tag or filter leaves fewer rows: the head box picks those only.
  assert.deepEqual(
    [...toggleAll([row("c"), row("b", "active")], new Set())],
    ["c"],
  );
});

test("a row box toggles its id and leaves the old set alone", () => {
  const before = new Set(["a"]);
  const after = togglePicked(before, "c");
  assert.deepEqual([...after], ["a", "c"]);
  assert.deepEqual([...before], ["a"]);
  assert.deepEqual([...togglePicked(after, "a")], ["c"]);
});

test("the picks drop when column 2 shows another type, and keep the still-inactive rows of the same type", () => {
  const prev = { type: "voc", ids: new Set(["a", "c"]) };
  assert.deepEqual([...picksFor(prev, "manual", ROWS).ids], []);
  assert.equal(picksFor(prev, "manual", ROWS).type, "manual");
  // c went active meanwhile: the same type keeps a only.
  const now = [row("a"), row("c", "active")];
  assert.deepEqual([...picksFor(prev, "voc", now).ids], ["a"]);
  assert.deepEqual([...picksFor(null, "voc", ROWS).ids], []);
});

test("the body is each picked row's id and its list rev, in the list's order", () => {
  assert.deepEqual(activateBody(ROWS, new Set(["e", "a", "b"])), {
    items: [
      { id: "a", rev: "rev-a" },
      { id: "e", rev: "rev-e" },
    ],
  });
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
  assert.deepEqual(
    activateToast(200, {
      results: [
        { id: "a", status: "active" },
        { id: "c", status: "active" },
      ],
      activated: 2,
    }),
    { text: "2 개 활성 — 다음 동기화부터 주입됩니다.", error: false },
  );
  assert.equal(
    activateToast(200, {
      results: [
        { id: "a", status: "active" },
        { id: "b", status: "skipped", error: "already_active" },
      ],
      activated: 1,
    }).text,
    "1 개 활성 · 1 개는 이미 활성 — 다음 동기화부터 주입됩니다.",
  );
  assert.deepEqual(
    activateToast(200, {
      results: [
        { id: "a", status: "active" },
        {
          id: "c",
          status: "error",
          error: "unknown_base_rev",
          currentRev: "x",
        },
        { id: "e", status: "error", error: "validation_failed" },
      ],
      activated: 1,
    }),
    {
      text: "1 개 활성 · 2 개 실패 — 다른 사람이 먼저 고쳤습니다. 목록을 다시 읽으세요",
      error: true,
    },
  );
  assert.equal(
    activateToast(200, {
      results: [{ id: "e", status: "error", error: "validation_failed" }],
      activated: 0,
    }).text,
    "0 개 활성 · 1 개 실패 — 목록을 다시 읽으세요",
  );
  assert.deepEqual(activateToast(403, { error: "forbidden" }), {
    text: "활성화 실패 (403) — forbidden",
    error: true,
  });
  assert.equal(activateToast(0, null).text, "활성화 실패 (0)");
});
