import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBlocks } from "../../public/lib/md-parse.mjs";
import {
  INERT_ATTR,
  INERT_STYLE,
  ZOOM,
  codeLines,
  codeToggle,
  debounce,
  dragScroll,
  errorLine,
  figRowText,
  fitZoom,
  flowNodeCount,
  inertSvg,
  isMermaid,
  mermaidError,
  mermaidFences,
  mermaidTheme,
  zoomKey,
  zoomStep,
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

test("the 코드 보기 button: 코드 접기 and aria-expanded true while the code box is open", () => {
  assert.deepEqual(codeToggle(false), { label: "코드 보기", expanded: "false" });
  assert.deepEqual(codeToggle(true), { label: "코드 접기", expanded: "true" });
});

const SENSOR_FLOW = [
  "flowchart TD",
  "  flow_sensor_row[센서 행]",
  "  flow_message_row[메시지 매핑]",
  "  flow_formula_row[수식]",
  "  flow_formula_input_rows[수식 입력 센서]",
  "  eqpsetupdemo[[설비 셋업 데모]]",
  "",
  "  flow_sensor_row -->|snsr_type_cd = 'FLOW'| flow_message_row",
  "  flow_sensor_row -->|else| flow_formula_row",
  "  flow_formula_row --> flow_formula_input_rows",
  "  flow_sensor_row -->|snsr_type_cd in ('FLOW', 'TEMP')| eqpsetupdemo",
  "  snsr_id([센서 ID])",
  "  snsr_id --> flow_sensor_row",
  "  snsr_id --> flow_message_row",
  "  snsr_id --> flow_formula_row",
  "  snsr_id --> flow_formula_input_rows",
].join("\n");

test("flowNodeCount counts each id declared with a shape once, past edge labels and shape text", () => {
  assert.equal(flowNodeCount(SENSOR_FLOW), 6);
  assert.equal(flowNodeCount("flowchart LR\n  A[가(나)] --> B{고르기}\n  B -->|예 (x)| C((끝))\n  A[다시] --> C"), 3);
  assert.equal(flowNodeCount("graph TD\n  A --> B"), 0);
  assert.equal(flowNodeCount("%% 주석\nflowchart TD\n  subgraph s1[묶음]\n  A[a]\n  end\n  classDef k fill:#fff\n  style A stroke:#000"), 1);
  assert.equal(flowNodeCount("sequenceDiagram\n  A->>B: hi"), null);
  assert.equal(flowNodeCount(""), null);
});

test("figRowText: 플로우 차트 · 노드 n · mermaid m 줄, the node count left out when it is unknown", () => {
  assert.equal(figRowText(`${SENSOR_FLOW}\n`), "플로우 차트 · 노드 6 · mermaid 16 줄");
  assert.equal(figRowText("graph TD\n  A --> B"), "플로우 차트 · mermaid 2 줄");
  assert.equal(figRowText("sequenceDiagram\n  A->>B: hi"), "플로우 차트 · mermaid 2 줄");
});

test("fitZoom fills the stage inside its margin 24: the smaller ratio, held to 25%–300%", () => {
  // 1440 × 900: the view 1392 × 852 less the bar 48 = stage 1392 × 804.
  assert.equal(Math.round(fitZoom({ w: 1392, h: 804 }, { w: 580, h: 380 }) * 100), 199);
  assert.equal(Math.round(fitZoom({ w: 1392, h: 804 }, { w: 543, h: 370 }) * 100), 204);
  // The code box 220 open under the stage.
  assert.equal(Math.round(fitZoom({ w: 1392, h: 804 - 220 }, { w: 580, h: 380 }) * 100), 141);
  // 1024 × 768: the view 976 × 720.
  assert.equal(Math.round(fitZoom({ w: 976, h: 672 }, { w: 580, h: 380 }) * 100), 160);
  assert.equal(fitZoom({ w: 1392, h: 804 }, { w: 60, h: 40 }), ZOOM.max);
  assert.equal(fitZoom({ w: 300, h: 300 }, { w: 5000, h: 5000 }), ZOOM.min);
  assert.equal(fitZoom({ w: 300, h: 300 }, null), 1);
});

test("zoomStep moves by 1.15 and stops at 25% and 300%", () => {
  assert.equal(zoomStep(1, 1), 1.15);
  assert.equal(Math.round(zoomStep(zoomStep(1, 1), 1) * 10000), 13225);
  assert.equal(zoomStep(1.15, -1), 1);
  assert.equal(zoomStep(2.9, 1), 3);
  assert.equal(zoomStep(0.26, -1), 0.25);
});

test("zoomKey: + − 0 f and the arrows (32px); a key with ⌘ · Ctrl · Alt is the browser's", () => {
  assert.equal(zoomKey({ key: "+" }), "in");
  assert.equal(zoomKey({ key: "=" }), "in");
  assert.equal(zoomKey({ key: "-" }), "out");
  assert.equal(zoomKey({ key: "0" }), "one");
  assert.equal(zoomKey({ key: "f" }), "fit");
  assert.deepEqual(zoomKey({ key: "ArrowLeft" }), { dx: -32, dy: 0 });
  assert.deepEqual(zoomKey({ key: "ArrowDown" }), { dx: 0, dy: 32 });
  assert.equal(zoomKey({ key: "+", metaKey: true }), null);
  assert.equal(zoomKey({ key: "-", ctrlKey: true }), null);
  assert.equal(zoomKey({ key: "a" }), null);
});

test("dragScroll: the picture follows the pointer, so the scroll moves the other way", () => {
  assert.deepEqual(dragScroll({ left: 200, top: 100 }, { x: 500, y: 400 }, { x: 440, y: 430 }), { left: 260, top: 70 });
});

test("the code box lines are the fence text, its last newline dropped", () => {
  assert.deepEqual(codeLines("flowchart TD\n  A --> B"), ["flowchart TD", "  A --> B"]);
  assert.deepEqual(codeLines("graph LR\n"), ["graph LR"]);
  assert.deepEqual(codeLines(mermaidFences(MD)[0].text).length, 2);
});
