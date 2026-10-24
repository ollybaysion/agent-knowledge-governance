import { test } from "node:test";
import assert from "node:assert/strict";

import { FAVORITE_CAP, RECENT_CAP, isFavorite, liveShelf, readShelf, toggleFavorite, touchRecent, writeShelf } from "../../public/lib/shelf.mjs";
import { docRows, move, rowTier, typeRows } from "../../public/lib/miller.mjs";

function memory() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test("최근 keeps the last opened first, each doc once, at most RECENT_CAP", () => {
  let shelf = { fav: [], recent: [] };
  for (let i = 0; i < RECENT_CAP + 3; i++) shelf = touchRecent(shelf, { type: "voc", id: `v${i}` }, `t${i}`);
  assert.equal(shelf.recent.length, RECENT_CAP);
  assert.equal(shelf.recent[0].id, `v${RECENT_CAP + 2}`);
  shelf = touchRecent(shelf, { type: "voc", id: "v5" }, "later");
  assert.deepEqual(shelf.recent.slice(0, 2).map((x) => x.id), ["v5", `v${RECENT_CAP + 2}`]);
  assert.equal(shelf.recent.filter((x) => x.id === "v5").length, 1);
});

test("즐겨찾기 toggles in and out and holds at most FAVORITE_CAP", () => {
  let shelf = { fav: [], recent: [] };
  const a = { type: "db-schema", id: "fdc_alarm_hist" };
  shelf = toggleFavorite(shelf, a);
  assert.ok(isFavorite(shelf, a));
  shelf = toggleFavorite(shelf, a);
  assert.ok(!isFavorite(shelf, a));
  for (let i = 0; i < FAVORITE_CAP + 5; i++) shelf = toggleFavorite(shelf, { type: "voc", id: `v${i}` });
  assert.equal(shelf.fav.length, FAVORITE_CAP);
});

test("the shelf is per user, survives junk, and drops docs that are gone", () => {
  const storage = memory();
  writeShelf(storage, "renoir", toggleFavorite({ fav: [], recent: [] }, { type: "voc", id: "a" }));
  assert.equal(readShelf(storage, "renoir").fav.length, 1);
  assert.deepEqual(readShelf(storage, "kim"), { fav: [], recent: [] });
  storage.setItem("akg_shelf:bad", "{not json");
  assert.deepEqual(readShelf(storage, "bad"), { fav: [], recent: [] });
  assert.deepEqual(readShelf(null, "x"), { fav: [], recent: [] });
  const live = liveShelf({ fav: [{ type: "voc", id: "a" }, { type: "voc", id: "gone" }], recent: [] }, [{ type: "voc", id: "a", title: "A" }]);
  assert.deepEqual(live.fav.map((x) => x.id), ["a"]);
});

const TYPES = [
  { id: "db-schema", label: "DB 스키마", color: "#111111", kind: "structured", builtin: true, status: "active" },
  { id: "domain-skill", label: "에이전트", color: "#222222", kind: "structured", builtin: true, status: "active" },
  { id: "voc", label: "VOC", color: "#333333", kind: "md", builtin: false, status: "active" },
  { id: "old", label: "옛 타입", color: "#444444", kind: "md", builtin: false, status: "archived" },
  { id: "unclassified", label: "미분류", color: "#555555", kind: "md", builtin: true, status: "active" },
];
const DOCS = [
  { type: "db-schema", id: "b", updatedAt: "2026-10-01T00:00:00Z" },
  { type: "db-schema", id: "a", updatedAt: "2026-10-03T00:00:00Z" },
  { type: "db-schema", id: "c", updatedAt: "2026-10-01T00:00:00Z" },
  { type: "domain-skill", id: "main1", role: "main" },
  { type: "domain-skill", id: "sub1", role: "sub" },
  { type: "voc", id: "v" },
];

test("column 1: types in order, 도메인 지식 counts subs only, closed empty types out, tags", () => {
  const rows = typeRows(TYPES, DOCS);
  assert.deepEqual(rows.map((r) => [r.id, r.label, r.count, r.tag]), [
    ["db-schema", "DB 스키마", 3, null],
    ["domain-skill", "도메인 지식", 1, null],
    ["voc", "VOC", 1, "등록"],
    ["unclassified", "미분류", 0, "내장"],
  ]);
});

test("column 2: the last changed first, then by id; main skills stay out", () => {
  assert.deepEqual(docRows(DOCS, "db-schema").map((d) => d.id), ["a", "b", "c"]);
  assert.deepEqual(docRows(DOCS, "domain-skill").map((d) => d.id), ["sub1"]);
  assert.equal(rowTier({ inferred: 1, confirmed: 3 }), "inferred");
  assert.equal(rowTier({ confirmed: 3 }), "confirmed");
  assert.equal(rowTier({}), null);
});

test("arrow keys: ↑↓ inside a column, → into the documents, ← back, ↩ opens", () => {
  const sizes = { n1: 4, n2: (i) => [3, 1, 0, 2][i], isDocRow: (i) => i === 3 && false };
  let s = { col: 1, i1: 0, i2: 0 };
  s = move(s, "ArrowDown", sizes).state;
  assert.deepEqual(s, { col: 1, i1: 1, i2: 0 });
  s = move(s, "ArrowDown", sizes).state;
  assert.equal(move(s, "ArrowRight", sizes).state.col, 1, "an empty type has no column 2 to go to");
  s = move(move(s, "ArrowUp", sizes).state, "ArrowUp", sizes).state;
  s = move(s, "ArrowRight", sizes).state;
  assert.equal(s.col, 2);
  s = move(move(move(s, "ArrowDown", sizes).state, "ArrowDown", sizes).state, "ArrowDown", sizes).state;
  assert.equal(s.i2, 2, "stops at the last row");
  assert.equal(move(s, "Enter", sizes).action, "open");
  s = move(s, "ArrowLeft", sizes).state;
  assert.equal(s.col, 1);
  assert.equal(move({ col: 1, i1: 0, i2: 0 }, "Enter", sizes).state.col, 2, "↩ on a type steps into it");
});

test("↩ on a 즐겨찾기 · 최근 row picks that document", () => {
  const sizes = { n1: 3, n2: () => 0, isDocRow: (i) => i < 2 };
  assert.equal(move({ col: 1, i1: 1, i2: 0 }, "Enter", sizes).action, "pick");
  assert.equal(move({ col: 1, i1: 1, i2: 0 }, "ArrowRight", sizes).state.col, 1);
});
