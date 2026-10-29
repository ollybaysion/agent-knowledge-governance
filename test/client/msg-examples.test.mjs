import { test } from "node:test";
import assert from "node:assert/strict";

import { examplesSection, msgFormatSections } from "../../public/lib/msg-examples.mjs";
import { renderMsgFormatMd } from "../../src/render/msg-format.mjs";

const EXAMPLES = [
  { label: "정상 보고", payload: "S6F11\n  <L [2]\n    <U4 1001>\n  >" },
  { label: "태그 글자", payload: "<b>&amp;</b> 그대로" },
];

test("examples 둘: 목차는 설명 · 필드 · 예시 페이로드, 절은 예시를 저장된 순서 · 글자 그대로 — md 렌더와 같다", () => {
  const body = { command: "S6F11", direction: "equipment->host", purpose: { tier: "empty" }, fields: [], examples: EXAMPLES };
  assert.deepEqual(msgFormatSections(body).map((s) => s.key), ["설명", "필드", "예시 페이로드"]);
  const s = examplesSection(body.examples);
  assert.equal(s.key, "예시 페이로드");
  assert.equal(s.title, "예시 페이로드");
  assert.deepEqual(s.items, EXAMPLES);
  assert.equal(s.items[1].payload, "<b>&amp;</b> 그대로");
  const md = renderMsgFormatMd({ body });
  const shown = s.items.map((ex) => `**${ex.label}**\n\n\`\`\`\n${ex.payload}\n\`\`\``).join("\n\n");
  assert.ok(md.includes(`## 예시 페이로드\n\n${shown}`));
});

test("examples 없음: 절이 없고 목차는 설명 · 필드 둘", () => {
  assert.equal(examplesSection(undefined), null);
  assert.equal(examplesSection([]), null);
  assert.deepEqual(msgFormatSections({ fields: [] }).map((s) => s.key), ["설명", "필드"]);
  assert.deepEqual(msgFormatSections({ fields: [], examples: [] }).map((s) => s.key), ["설명", "필드"]);
});
