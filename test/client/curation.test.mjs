// 정리 탭의 줄과 바뀐 절 (public/lib/curation.mjs), and the tab the page loads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { absorptionRow, changedSections, lineDiff, pairRow, PAIR_FILTERS, revertState, sideView } from "../../public/lib/curation.mjs";
import { buildApp } from "../../server/app.mjs";
import { signIn } from "../sign-in.mjs";

const side = (over = {}) => ({ type: "voc", id: "alarm-guide", rev: "r1", title: "알람 안내", status: "active", exists: true, currentRev: "r1", ...over });

test("sideView: the title or the id, the status, and a note when the document moved or left", () => {
  assert.deepEqual(sideView(side()), { type: "voc", id: "alarm-guide", label: "알람 안내", exists: true, status: "active", note: null });
  assert.equal(sideView(side({ title: null })).label, "alarm-guide");
  assert.equal(sideView(side({ currentRev: "r2" })).note, "본 뒤 바뀜");
  const gone = sideView(side({ exists: false, status: null, currentRev: null }));
  assert.equal(gone.status, null);
  assert.equal(gone.note, "지워졌거나 타입이 바뀌었습니다");
});

test("pairRow: both sides, score to two places, the status with who decided", () => {
  const pair = { key: "k", a: side({ type: "unclassified", id: "x" }), b: side(), score: 0.9312, seenAt: "2026-11-10T13:40:00.000Z", status: "open" };
  const row = pairRow(pair);
  assert.equal(row.score, "0.93");
  assert.equal(row.open, true);
  assert.deepEqual(row.state, { label: "열림", detail: null });
  const dismissed = pairRow({ ...pair, status: "dismissed", decision: { status: "dismissed", by: "kim", at: "2026-11-10T13:41:00.000Z" } });
  assert.equal(dismissed.open, false);
  assert.equal(dismissed.state.label, "그대로 둠");
  assert.match(dismissed.state.detail, /^kim · 2026-11-1\d \d\d:41$/);
  assert.match(pairRow({ ...pair, status: "resolved", decision: { status: "resolved", reason: "deleted", at: "x" } }).state.detail, /^문서 삭제/);
  assert.deepEqual(PAIR_FILTERS.map(([v]) => v), ["open", "dismissed", "resolved", ""]);
});

test("revertState: only an applied record whose target still stands at toRev", () => {
  const rec = { id: "1", status: "applied", source: side({ type: "unclassified", id: "n" }), target: { ...side(), fromRev: "r0", toRev: "r1" }, summary: "s", model: "m", at: "2026-11-10T13:40:00.000Z" };
  assert.deepEqual(revertState(rec), { can: true, reason: null });
  assert.equal(revertState({ ...rec, target: { ...rec.target, currentRev: "r2" } }).can, false);
  assert.match(revertState({ ...rec, target: { ...rec.target, currentRev: "r2" } }).reason, /바뀌었습니다/);
  assert.match(revertState({ ...rec, target: { ...rec.target, exists: false } }).reason, /그 자리에 없습니다/);
  assert.match(revertState({ ...rec, status: "reverted", revert: { by: "kim", at: "2026-11-10T13:50:00.000Z" } }).reason, /^kim 가 /);
  const row = absorptionRow(rec);
  assert.equal(row.status, "반영됨");
  assert.equal(row.score, null);
  assert.equal(row.target.note, null);
  assert.equal(absorptionRow({ ...rec, score: 0.881 }).score, "0.88");
});

test("changedSections: the ## sections that differ, added and removed ones too, the text above the first ## as one", () => {
  const before = { name: "g", markdown: "# 안내\n\n## 원인\n\n센서\n\n## 조치\n\n교체\n\n## 옛 절\n\n지울 글\n" };
  const after = { name: "g", markdown: "# 안내\n\n머리말\n\n## 원인\n\n센서\n\n## 조치\n\n교체, 3 개월마다\n\n## 새 절\n\n새 글\n" };
  assert.deepEqual(changedSections(before, after), [
    { heading: "(첫 절 앞)", before: "# 안내", after: "# 안내\n\n머리말" },
    { heading: "조치", before: "교체", after: "교체, 3 개월마다" },
    { heading: "새 절", before: "", after: "새 글" },
    { heading: "옛 절", before: "지울 글", after: "" },
  ]);
  assert.deepEqual(changedSections(before, before), []);
  assert.deepEqual(changedSections(null, { markdown: "## a\n\nb\n" }), [{ heading: "a", before: "", after: "b" }]);
});

test("lineDiff: kept lines stay, the rest are del and add in order", () => {
  assert.deepEqual(lineDiff("- 펌프\n- 밸브", "- 펌프\n- 밸브\n- O-ring"), [
    { t: "eq", line: "- 펌프" },
    { t: "eq", line: "- 밸브" },
    { t: "add", line: "- O-ring" },
  ]);
  assert.deepEqual(lineDiff("a\nb", "a\nc"), [
    { t: "eq", line: "a" },
    { t: "del", line: "b" },
    { t: "add", line: "c" },
  ]);
  assert.deepEqual(lineDiff("", "x"), [{ t: "add", line: "x" }]);
  assert.deepEqual(lineDiff("x", ""), [{ t: "del", line: "x" }]);
});

test("the page loads the 정리 tab: the shell names it, the router opens it, the tab draws both sections", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-curation-tab-test-"));
  const auth = await signIn(home, [{ id: "kim", group: "admin", token: "a" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  try {
    const get = async (url) => {
      const r = await app.inject({ method: "GET", url });
      assert.equal(r.statusCode, 200, url);
      return r.body;
    };
    assert.match(await get("/js/shell.mjs"), /\{ id: "curation", label: "정리", hash: "#\/curation" \}/);
    assert.match(await get("/js/router.mjs"), /head === "curation"[\s\S]*renderCuration\(\)/);
    const tab = await get("/js/tabs/curation.mjs");
    for (const text of ["중복 후보 ", "흡수 기록 ", "그대로 두기", "처리함", "되돌리기", "바뀐 부분", "/api/curation/duplicates", "/api/curation/absorptions"])
      assert.ok(tab.includes(text), text);
    await get("/lib/curation.mjs");
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
