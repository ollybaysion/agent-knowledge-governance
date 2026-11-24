import { test } from "node:test";
import assert from "node:assert/strict";

import { ageDays, ageLabel, ageTitle, ageTone } from "../../public/lib/freshness.mjs";

const NOW = Date.parse("2026-11-24T12:00:00Z");

test("ageDays 는 지난 날 수를 내림으로 센다 — 빈 시각 · 읽히지 않는 시각은 null, 앞날은 0", () => {
  assert.equal(ageDays("2026-11-24T11:00:00Z", NOW), 0);
  assert.equal(ageDays("2026-11-23T12:00:00Z", NOW), 1);
  assert.equal(ageDays("2026-11-23T12:00:01Z", NOW), 0);
  assert.equal(ageDays("2026-05-01T00:00:00Z", NOW), 207);
  assert.equal(ageDays("2026-12-01T00:00:00Z", NOW), 0);
  assert.equal(ageDays(null, NOW), null);
  assert.equal(ageDays("", NOW), null);
  assert.equal(ageDays("어제", NOW), null);
});

test("ageLabel: 오늘 · n일 전 · n개월 전 · n년 전", () => {
  assert.deepEqual([0, 1, 59, 60, 364, 365, 800, null].map(ageLabel), ["오늘", "1일 전", "59일 전", "2개월 전", "12개월 전", "1년 전", "2년 전", "시각 없음"]);
});

test("ageTone 의 경계: 7 · 90 · 180 일", () => {
  assert.deepEqual([0, 7, 8, 90, 91, 180, 181, null].map(ageTone), ["fresh", "fresh", "ok", "ok", "aging", "aging", "stale", "none"]);
});

test("ageTitle 은 고친 시각과 날 수를 같이 적는다", () => {
  assert.equal(ageTitle("2026-05-01T14:20:00+09:00", 207), "2026-05-01 14:20 수정 · 207일 전");
  assert.equal(ageTitle("2026-11-24T09:00:00Z", 0), "2026-11-24 09:00 수정 · 오늘");
  assert.equal(ageTitle(null, null), "수정 시각이 없습니다");
});
