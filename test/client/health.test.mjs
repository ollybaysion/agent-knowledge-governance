import { test } from "node:test";
import assert from "node:assert/strict";

import { CHECKS, LONG_CHARS, goneCount, ageHistogram, checkCounts, checkRows, docFacts, dupGroups, firstLines, median, sizeHistogram, titleKey, typeStatusMatrix } from "../../public/lib/health.mjs";

const NOW = Date.parse("2026-11-24T00:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();
const doc = (type, id, extra = {}) => ({ type, id, status: "active", title: id, links: [], updatedAt: ago(10), size: 1000, ...extra });
const link = (key, rel = "related") => ({ type: key.split("/")[0], id: key.split("/")[1], rel });

// agent → table · manual, manual → table(본문 [[ ]]), voc-a → 없는 문서 · 폐기 문서 · 비활성 문서,
// voc-b 는 혼자, old-table 은 폐기.
const DOCS = [
  doc("domain-skill", "agent", { links: [link("db-schema/table"), link("manual/guide")] }),
  doc("db-schema", "table", { title: "TABLE", updatedAt: ago(400), size: 20000 }),
  doc("manual", "guide", { title: "가이드", wikilinks: [{ text: "table", type: "db-schema", id: "table", found: true }, { text: "nowhere", type: null, id: "nowhere", found: false }] }),
  doc("voc", "voc-a", { title: "알람 문의", links: [link("voc/gone"), link("db-schema/old-table"), link("voc/voc-off")], updatedAt: ago(2), size: 50 }),
  doc("voc", "voc-b", { title: " 알람  문의 ", updatedAt: ago(200) }),
  doc("voc", "voc-off", { status: "inactive", title: null, updatedAt: null, size: undefined }),
  doc("db-schema", "old-table", { status: "archived" }),
];
const rows = docFacts(DOCS, NOW);
const row = (key) => rows.find((r) => r.key === key);
const keys = (id) => checkRows(rows, id).map((r) => r.key);

test("docFacts: 폐기 문서는 줄에서 빠지고, 연결은 links[] 와 본문 [[ ]] 를 합쳐 대상마다 한 번 센다", () => {
  assert.equal(rows.length, 6);
  assert.deepEqual([row("domain-skill/agent").out, row("domain-skill/agent").in], [2, 0]);
  assert.deepEqual([row("db-schema/table").out, row("db-schema/table").in], [0, 2]);
  assert.deepEqual([row("manual/guide").out, row("manual/guide").in], [1, 1]);
  const twice = docFacts([doc("manual", "m", { links: [link("voc/v"), link("voc/v", "screen")], wikilinks: [{ text: "v", type: "voc", id: "v", found: true }] }), doc("voc", "v")], NOW);
  assert.deepEqual([twice[0].out, twice[1].in], [1, 1]);
});

test("docFacts: 끊긴 연결 넷 — 없는 문서 · 폐기된 문서 · 활성이 가리키는 비활성 문서 · 없는 이름", () => {
  assert.deepEqual(row("voc/voc-a").broken, [
    { kind: "missing", target: "voc/gone" },
    { kind: "archived", target: "db-schema/old-table" },
    { kind: "inactive", target: "voc/voc-off" },
  ]);
  assert.deepEqual(row("manual/guide").broken, [{ kind: "name", target: "nowhere" }]);
  // 비활성 문서는 연결로 센다: 가리킨 쪽의 out, 가리켜진 쪽의 in.
  assert.equal(row("voc/voc-a").out, 1);
  assert.equal(row("voc/voc-off").in, 1);
  // 비활성 문서가 비활성 문서를 가리키면 끊긴 연결이 아니다.
  const off = docFacts([doc("voc", "a", { status: "inactive", links: [link("voc/b")] }), doc("voc", "b", { status: "inactive" })], NOW);
  assert.deepEqual(off[0].broken, []);
});

test("docFacts: 자기를 가리키는 연결은 세지 않는다", () => {
  const [self] = docFacts([doc("voc", "a", { links: [link("voc/a")] })], NOW);
  assert.deepEqual([self.in, self.out, self.broken], [0, 0, []]);
});

test("검사 여덟이 걸리는 문서", () => {
  assert.deepEqual(keys("orphans"), ["voc/voc-b"]);
  assert.deepEqual(keys("broken"), ["voc/voc-a", "manual/guide"]);
  assert.deepEqual([goneCount(row("voc/voc-a")), goneCount(row("manual/guide")), goneCount(row("voc/voc-b"))], [2, 1, 0]);
  assert.deepEqual(keys("stale"), ["db-schema/table", "voc/voc-b"]);
  assert.deepEqual(keys("short"), ["voc/voc-a"]);
  assert.deepEqual(keys("long"), ["db-schema/table"]);
  assert.deepEqual(keys("untitled"), ["voc/voc-off"]);
  assert.deepEqual(keys("dup"), ["voc/voc-a", "voc/voc-b"]);
  assert.deepEqual(keys("recent"), ["voc/voc-a"]);
  assert.deepEqual(checkCounts(rows), { orphans: 1, broken: 2, stale: 2, short: 1, long: 1, untitled: 1, dup: 2, recent: 1 });
  assert.equal(CHECKS.length, 8);
});

test("경계 값: 180일은 오래됨이 아니고 181일부터, 200자는 짧지 않고, 12,000자는 길지 않다", () => {
  const edge = docFacts([
    doc("voc", "d180", { updatedAt: ago(180), size: 200 }),
    doc("voc", "d181", { updatedAt: ago(181), size: 199 }),
    doc("voc", "l0", { size: LONG_CHARS }),
    doc("voc", "l1", { size: LONG_CHARS + 1 }),
    doc("voc", "d7", { updatedAt: ago(7) }),
    doc("voc", "d8", { updatedAt: ago(8) }),
  ], NOW);
  const ids = (id) => checkRows(edge, id).map((r) => r.doc.id);
  assert.deepEqual(ids("stale"), ["d181"]);
  assert.deepEqual(ids("short"), ["d181"]);
  assert.deepEqual(ids("long"), ["l1"]);
  assert.deepEqual(ids("recent"), ["d7"]);
});

test("겹친 제목: 공백 · 대소문자를 고르게 한 제목으로 묶고, 빈 제목은 묶지 않는다", () => {
  assert.equal(titleKey("  FDC   Alarm "), "fdc alarm");
  assert.deepEqual(dupGroups(rows).map((g) => [g.title, g.rows.map((r) => r.key)]), [["알람 문의", ["voc/voc-a", "voc/voc-b"]]]);
  const blank = docFacts([doc("voc", "a", { title: null }), doc("voc", "b", { title: "" }), doc("voc", "c", { title: "  " })], NOW);
  assert.deepEqual(blank.map((r) => r.dup), [0, 0, 0]);
  assert.equal(checkRows(blank, "untitled").length, 3);
});

test("제목 없음: md 타입은 제목이 id 와 같아도 걸린다 — 그 밖의 타입은 id 와 같은 제목이 제 이름이다", () => {
  const list = [doc("voc", "voc-1"), doc("unclassified", "voc-1"), doc("voc", "voc-2", { title: "알람 문의" }), doc("domain-skill", "fdc-agent"), doc("db-schema", "t", { title: null })];
  const facts = docFacts(list, NOW, { mdTypes: ["voc", "unclassified"] });
  assert.deepEqual(checkRows(facts, "untitled").map((r) => r.key), ["db-schema/t", "unclassified/voc-1", "voc/voc-1"]);
  // id 와 같은 제목끼리는 겹친 제목으로 세지 않는다.
  assert.deepEqual(checkRows(facts, "dup"), []);
  assert.deepEqual(checkRows(docFacts(list, NOW), "untitled").map((r) => r.key), ["db-schema/t"]);
});

test("나이 분포: 칸 여섯의 합 + 시각 없음 = 문서 수", () => {
  const { bins, unknown } = ageHistogram(rows);
  assert.deepEqual(bins.map((b) => b.count), [1, 2, 0, 0, 1, 1]);
  assert.equal(unknown, 1);
  assert.equal(bins.reduce((n, b) => n + b.count, 0) + unknown, rows.length);
  assert.deepEqual(bins.map((b) => b.tone), ["plain", "plain", "plain", "plain", "warn", "warn"]);
});

test("크기 분포: 처음 칸이 짧은 문서, 마지막 칸이 긴 문서와 같은 수다", () => {
  const { bins, unknown } = sizeHistogram(rows);
  assert.deepEqual(bins.map((b) => b.count), [1, 0, 0, 3, 0, 0, 0, 1]);
  assert.equal(unknown, 1);
  assert.equal(bins[0].count, checkRows(rows, "short").length);
  assert.equal(bins.at(-1).count, checkRows(rows, "long").length);
  const edge = sizeHistogram(docFacts([doc("voc", "a", { size: LONG_CHARS }), doc("voc", "b", { size: LONG_CHARS + 1 }), doc("voc", "c", { size: 0 })], NOW));
  assert.deepEqual(edge.bins.map((b) => b.count), [1, 0, 0, 0, 0, 0, 1, 1]);
});

test("median: 짝수 개면 아래쪽 가운데 값, 빈 목록은 null", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(median([]), null);
});

test("타입 × 상태 표: 타입 목록의 순서, 문서 없는 타입도 한 줄, 목록 밖 타입은 뒤에", () => {
  const m = typeStatusMatrix(rows, ["db-schema", "domain-skill", "manual", "starter"]);
  assert.deepEqual(m, [
    { type: "db-schema", active: 1, inactive: 0, total: 1 },
    { type: "domain-skill", active: 1, inactive: 0, total: 1 },
    { type: "manual", active: 1, inactive: 0, total: 1 },
    { type: "starter", active: 0, inactive: 0, total: 0 },
    { type: "voc", active: 2, inactive: 1, total: 3 },
  ]);
  assert.equal(m.reduce((n, r) => n + r.total, 0), rows.length);
});

test("firstLines: frontmatter · 제목 줄 · 코드 울타리 · 표를 건너뛰고 글 줄 셋", () => {
  const md = "---\nname: x\n---\n# 제목\n\n## 개요\n\n- **알람**이 뜨면 `RESET` 을 누른다\n\n```sql\nSELECT 1\n```\n\n| a | b |\n| - | - |\n\n> [[fdc_alarm]] 표를 본다\n넷째 줄\n다섯째 줄\n";
  assert.deepEqual(firstLines(md), ["개요", "알람이 뜨면 RESET 을 누른다", "fdc_alarm 표를 본다"]);
  assert.deepEqual(firstLines("# 제목만\n"), []);
  assert.deepEqual(firstLines("# T\n\n<!-- dbdoc:manual:purpose -->\n센서 목록 <!-- 추정 -->\n<!--\n여러 줄\n-->\n둘째\n"), ["센서 목록", "둘째"]);
  assert.deepEqual(firstLines(null), []);
  assert.deepEqual(firstLines("가".repeat(100), { width: 10 }), [`${"가".repeat(9)}…`]);
  assert.deepEqual(firstLines("a\nb\nc", { lines: 2 }), ["a", "b"]);
});
