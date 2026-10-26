import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBlocks } from "../../public/lib/md-parse.mjs";
import {
  INERT_ATTR,
  INERT_STYLE,
  debounce,
  errorLine,
  inertSvg,
  isMermaid,
  mermaidError,
  mermaidFences,
  mermaidTheme,
} from "../../public/lib/mermaid-src.mjs";

const MD = ["# 문서", "", "## 흐름", "", "```mermaid", "flowchart TD", "  A --> B", "```", "", "```sql", "SELECT 1", "```", "", "~~~Mermaid", "graph LR", "~~~"].join("\n");

test("md-parse gives a ```mermaid fence as a code block with lang mermaid", () => {
  const code = parseBlocks(MD).filter((b) => b.type === "code");
  assert.deepEqual(code.map((b) => b.lang), ["mermaid", "sql", "Mermaid"]);
  assert.equal(code[0].text, "flowchart TD\n  A --> B");
});

test("isMermaid picks the mermaid fences, any case, and nothing else", () => {
  const blocks = parseBlocks(MD);
  assert.deepEqual(blocks.filter(isMermaid).map((b) => b.line), [4, 13]);
  assert.equal(isMermaid({ type: "p", text: "mermaid" }), false);
  assert.deepEqual(mermaidFences(MD), [
    { text: "flowchart TD\n  A --> B", line: 4 },
    { text: "graph LR", line: 13 },
  ]);
});

test("errorLine reads mermaid's parse and lexical messages", () => {
  assert.equal(errorLine("Parse error on line 4:\n...\nExpecting 'SQE'"), 4);
  assert.equal(errorLine("Lexical error on line 3. Unrecognized text."), 3);
  assert.equal(errorLine("No diagram type detected matching given configuration for text: x"), null);
});

test("mermaidError puts the line first: the document line with a fence line, the diagram line without", () => {
  const msg = "Parse error on line 2:\n...A --> \n------^\nExpecting 'SQE', got 'EOF'";
  assert.deepEqual(mermaidError(msg, 20), { line: 22, title: "22 줄: Parse error", detail: "...A --> \n------^\nExpecting 'SQE', got 'EOF'" });
  assert.equal(mermaidError(msg).title, "도식 2 줄: Parse error");
  assert.equal(mermaidError("Lexical error on line 3. Unrecognized text.", 10).title, "13 줄: Lexical error. Unrecognized text.");
  assert.deepEqual(mermaidError("UnknownDiagramError"), { line: null, title: "UnknownDiagramError", detail: "" });
  assert.equal(mermaidError("").title, "그리지 못했습니다");
});

test("an error past the last line (mermaid adds a newline) points at the last line", () => {
  const text = "flowchart TD\n  A --> B\n  G --> ";
  assert.equal(mermaidError("Parse error on line 4:\n...", 7, text).line, 10);
  assert.equal(mermaidError("Parse error on line 2:\n...", 7, text).line, 9);
});

test("mermaidTheme maps the page tokens onto mermaid's base theme", () => {
  const tokens = { "--field": "#fff", "--surface-soft": "#eee", "--ink": "#111", "--primary": "#4f6d8a", "--muted": "#6b7280", "--sans": "Pretendard, sans-serif" };
  const t = mermaidTheme((n) => tokens[n] ?? "", true);
  assert.equal(t.darkMode, true);
  assert.equal(t.primaryColor, "#eee");
  assert.equal(t.primaryBorderColor, "#4f6d8a");
  assert.equal(t.primaryTextColor, "#111");
  assert.equal(t.lineColor, "#6b7280");
  assert.equal(t.fontFamily, "Pretendard, sans-serif");
  assert.equal(mermaidTheme(() => "", false).darkMode, false);
});

test("inertSvg renames <style> and style= inside tags only", () => {
  const svg = '<svg id="m" style="max-width: 10px;"><style>#m .node>rect{fill:red}</style><g><text style=\'x\'>a style="b"</text></g></svg>';
  assert.equal(
    inertSvg(svg),
    `<svg id="m" ${INERT_ATTR}="max-width: 10px;"><${INERT_STYLE}>#m .node>rect{fill:red}</${INERT_STYLE}><g><text ${INERT_ATTR}='x'>a style="b"</text></g></svg>`,
  );
  assert.equal(inertSvg('<g class="style"><stylesheet/></g>'), '<g class="style"><stylesheet/></g>');
});

test("debounce runs once, 300ms after the last call, with the last arguments", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const run = debounce((x) => calls.push(x), 300);
  run(1);
  t.mock.timers.tick(200);
  run(2);
  t.mock.timers.tick(299);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [2]);
  run(3);
  run.cancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [2]);
});
