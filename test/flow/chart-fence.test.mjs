// BE ChartFenceTest's mds and expectations (fdc-agent-be-spring a1a2c8c):
// the same input gives the same code, line and reason. The fixture
// test/fixtures/flow/chart/sensor-trend.md is BE's src/test/resources/chart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFiles, readAgentMd } from "../../src/flow/agent-md.mjs";
import { chartLine } from "../../src/flow/chart-fence.mjs";
import { mdLine } from "../../src/flow/flow-error.mjs";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "flow",
);
const SENSOR_TREND = readFileSync(
  join(FIXTURES, "chart", "sensor-trend.md"),
  "utf8",
);

/** BE ChartFenceTest.md: one query item with one ```chart fence; the fence opens on line 11. */
const md = (chart) =>
  "# 그래프\n\n## 데이터\n\n### trend — 트렌드\n\n```sql\nselect ts, snsr_id, snsr_type_cd, value, value2 from fdc_trace\n```\n\n" +
  `\`\`\`chart\n${chart}\n\`\`\`\n`;

const query = (r, id) => r.queries.find((q) => q.id === id);
const chartOf = (chart) => {
  const r = readAgentMd("g", md(chart));
  assert.equal(r.rejection, null, r.rejection);
  return query(r, "trend").chart;
};
const errors = (chart) => {
  const r = readAgentMd("g", md(chart));
  assert.notEqual(r.rejection, null, "거부하지 않았다");
  return r.chartErrors;
};
const err = (line, code, message) => ({ line, code, message });
const SORTS =
  "line · step · area · bar · stacked-bar · scatter · histogram · heatmap · box";
const OUTPUTS = "TS · SNSR_ID · SNSR_TYPE_CD · VALUE · VALUE2";

test("fixture 의 line 펜스는 series 와 facet 을 읽고 제목이 없으면 항목 제목이다", () => {
  const r = readAgentMd("sensor-trend", SENSOR_TREND);
  assert.equal(r.rejection, null, r.rejection);
  const trace = query(r, "sensor_trace");
  assert.deepEqual(trace.chart, {
    kind: "line",
    x: "ts",
    y: ["value"],
    series: ["snsr_id"],
    facet: "snsr_type_cd",
    value: null,
    bins: null,
    title: "센서 트렌드",
  });
  assert.match(trace.sql, /^select ts, snsr_id/);
  assert.doesNotMatch(trace.sql, /kind/);
});

test("fixture 의 heatmap 펜스는 value 열과 적은 제목을 읽고, check-flow 를 통과한다", () => {
  const r = readAgentMd("sensor-trend", SENSOR_TREND);
  assert.deepEqual(query(r, "step_heatmap").chart, {
    kind: "heatmap",
    x: "step_id",
    y: ["snsr_id"],
    series: [],
    facet: null,
    value: "avg_value",
    bins: null,
    title: "스텝 × 센서 평균",
  });
  assert.deepEqual(
    checkFiles([{ path: "sensor-trend.md", text: SENSOR_TREND }]),
    { lines: ["OK sensor-trend.md"], ok: true },
  );
});

test("열 여럿은 쉼표로 적고 빈 조각은 뺀다", () => {
  const chart = chartOf(
    "kind = stacked-bar\nx = ts\ny = value, value2 ,\nseries = snsr_id, snsr_type_cd",
  );
  assert.equal(chart.kind, "stacked-bar");
  assert.deepEqual(chart.y, ["value", "value2"]);
  assert.deepEqual(chart.series, ["snsr_id", "snsr_type_cd"]);
});

test("histogram 은 bins 를 적지 않으면 20 이고 적으면 그 값이다, y 없이 받는다", () => {
  assert.equal(chartOf("kind = histogram\nx = value").bins, 20);
  assert.deepEqual(chartOf("kind = histogram\nx = value").y, []);
  assert.equal(chartOf("kind = histogram\nx = value\nbins = 50").bins, 50);
  assert.equal(chartOf("kind = histogram\nx = value\nbins = 200").bins, 200);
  assert.equal(chartOf("kind = line\nx = ts\ny = value").bins, null);
});

test("chart 펜스가 sql 펜스 앞에 와도 읽는다", () => {
  const r = readAgentMd(
    "g",
    "# 그래프\n\n## 데이터\n\n### trend — 트렌드\n\n```chart\nkind = scatter\nx = ts\ny = value\n```\n\n```sql\nselect ts, value from fdc_trace\n```\n",
  );
  assert.equal(query(r, "trend").sql, "select ts, value from fdc_trace");
  assert.equal(query(r, "trend").chart.kind, "scatter");
});

test("chart 펜스가 없는 옛 문서는 그대로 읽는다 — chart 키가 없고 sql 펜스 둘은 예전처럼 거부한다", () => {
  const r = readAgentMd(
    "g",
    "# 그래프\n\n## 데이터\n\n### trend — 트렌드\n\n```sql\nselect ts, value from fdc_trace\n```\n",
  );
  assert.equal(r.rejection, null);
  assert.deepEqual(query(r, "trend"), {
    id: "trend",
    title: "트렌드",
    sql: "select ts, value from fdc_trace",
    vars: [],
  });
  assert.deepEqual(r.warnings, []);
  const two = readAgentMd(
    "g",
    "# 그래프\n\n## 데이터\n\n### trend — 트렌드\n\n```sql\nselect 1 from dual\n```\n\n```sql\nselect 2 from dual\n```\n",
  );
  assert.match(two.rejection, /펜스가 둘입니다/);
  assert.deepEqual(two.chartErrors, []);
});

test("CHART_DUPLICATE: chart 펜스가 둘이면 둘째 펜스 줄에 거부한다", () => {
  const r = readAgentMd(
    "g",
    `${md("kind = line\nx = ts\ny = value")}\n\`\`\`chart\nkind = bar\nx = ts\ny = value\n\`\`\`\n`,
  );
  assert.deepEqual(r.chartErrors, [
    err(
      17,
      "CHART_DUPLICATE",
      "항목 trend 에 chart 펜스가 2 개다 — 하나만 둔다",
    ),
  ]);
  assert.match(
    r.rejection,
    /^g: 그래프 펜스 오류로 거부 — 17 번째 줄 CHART_DUPLICATE/,
  );
});

test("CHART_KIND: 모르는 종류는 kind 줄이다", () => {
  assert.deepEqual(errors("kind = pie\nx = ts\ny = value"), [
    err(12, "CHART_KIND", `모르는 종류 pie — 받는 종류는 ${SORTS}`),
  ]);
});

test("CHART_KEY: 모르는 키 · 두 번 적은 키 · 꼴이 아닌 줄", () => {
  assert.deepEqual(
    errors("kind = line\nx = ts\ny = value\ncolor = red\nx = snsr_id\nlegend"),
    [
      err(
        15,
        "CHART_KEY",
        "모르는 키 color — 받는 키는 kind · x · y · series · facet · value · bins · title",
      ),
      err(16, "CHART_KEY", "키 x 가 두 번 나온다"),
      err(17, "CHART_KEY", "chart 줄은 '키 = 값' 꼴이다: legend"),
    ],
  );
});

test("CHART_REQUIRED: 필수 키가 없으면 어떤 키인지 알린다", () => {
  assert.deepEqual(errors("x = ts\ny = value"), [
    err(11, "CHART_REQUIRED", "kind 가 없다"),
  ]);
  assert.deepEqual(errors("kind = line\ny = value"), [
    err(11, "CHART_REQUIRED", "x 가 없다"),
  ]);
  assert.deepEqual(errors("kind = bar\nx = ts"), [
    err(11, "CHART_REQUIRED", "y 가 없다 — bar 는 y 열을 적는다"),
  ]);
  assert.deepEqual(errors("kind = heatmap\nx = ts\ny = snsr_id"), [
    err(11, "CHART_REQUIRED", "value 가 없다 — heatmap 은 색 값 열을 적는다"),
  ]);
  assert.deepEqual(errors("kind = line\nx =\ny = value"), [
    err(13, "CHART_REQUIRED", "x 가 없다"),
  ]);
});

test("CHART_BINS: bins 가 1~200 의 정수가 아니다", () => {
  for (const bins of ["0", "201", "abc", "2.5"])
    assert.deepEqual(errors(`kind = histogram\nx = value\nbins = ${bins}`), [
      err(14, "CHART_BINS", `bins 는 1~200 의 정수다: ${bins}`),
    ]);
});

test("CHART_COLUMN: 출력 열에 없는 열은 그 키 줄이고 대소문자는 가리지 않는다", () => {
  assert.deepEqual(
    errors(
      "kind = line\nx = TS\ny = value, nope\nseries = SNSR_ID\nfacet = eqp_id",
    ),
    [
      err(
        14,
        "CHART_COLUMN",
        `y 열 nope 이 조회 trend 의 출력 열에 없다 — 출력 열은 ${OUTPUTS}`,
      ),
      err(
        16,
        "CHART_COLUMN",
        `facet 열 eqp_id 이 조회 trend 의 출력 열에 없다 — 출력 열은 ${OUTPUTS}`,
      ),
    ],
  );
  assert.equal(chartOf("kind = line\nx = TS\ny = VALUE").x, "TS");
});

test("CHART_COLUMN: x · facet · value 에 쉼표가 들면 그 키 줄이다", () => {
  assert.deepEqual(
    errors(
      "kind = heatmap\nx = ts, value\ny = snsr_id\nfacet = snsr_type_cd,snsr_id\nvalue = value, value2",
    ),
    [
      err(13, "CHART_COLUMN", "x 는 열 하나다: ts, value"),
      err(15, "CHART_COLUMN", "facet 는 열 하나다: snsr_type_cd,snsr_id"),
      err(16, "CHART_COLUMN", "value 는 열 하나다: value, value2"),
    ],
  );
  assert.deepEqual(errors("kind = line\nx = ts, value\ny = value"), [
    err(13, "CHART_COLUMN", "x 는 열 하나다: ts, value"),
  ]);
});

test("select * 는 열을 검사하지 않고 통과하며, 펜스 줄에 경고를 남긴다", () => {
  const text =
    "# 그래프\n\n## 데이터\n\n### trend — 트렌드\n\n```sql\nselect * from fdc_trace\n```\n\n```chart\nkind = line\nx = anything\ny = whatever\n```\n";
  const r = readAgentMd("g", text);
  assert.equal(r.rejection, null);
  assert.equal(query(r, "trend").chart.x, "anything");
  assert.deepEqual(r.warnings, [
    err(
      11,
      "CHART_COLUMN",
      "조회 trend 의 chart 열을 검사하지 않는다 — 문장의 출력 열을 읽지 못했다(select * 등)",
    ),
  ]);
  assert.deepEqual(checkFiles([{ path: "g.md", text }]), {
    lines: [
      "g.md:11 경고 CHART_COLUMN 조회 trend 의 chart 열을 검사하지 않는다 — 문장의 출력 열을 읽지 못했다(select * 등)",
      "OK g.md",
    ],
    ok: true,
  });
});

test("check-flow 는 그래프 펜스 오류를 md 줄로 낸다", () => {
  const r = checkFiles([
    { path: "g.md", text: md("kind = pie\nx = ts\ny = nope") },
  ]);
  assert.equal(r.ok, false);
  assert.ok(
    r.lines.some((l) => l.startsWith("g.md:12 CHART_KIND 모르는 종류 pie")),
    r.lines.join("\n"),
  );
  assert.ok(
    r.lines.some((l) => l.startsWith("g.md:14 CHART_COLUMN y 열 nope")),
    r.lines.join("\n"),
  );
});

test("오류가 여럿이면 줄 순서로 모두 싣고 사유에 코드가 든다", () => {
  assert.equal(
    readAgentMd("g", md("kind = line\ncolor = red\nbins = 0")).rejection,
    "g: 그래프 펜스 오류로 거부 — 11 번째 줄 CHART_REQUIRED x 가 없다; 11 번째 줄 CHART_REQUIRED y 가 없다 — line 는 y 열을 적는다; " +
      "13 번째 줄 CHART_KEY 모르는 키 color — 받는 키는 kind · x · y · series · facet · value · bins · title; " +
      "14 번째 줄 CHART_BINS bins 는 1~200 의 정수다: 0",
  );
});

test("CHART_* 의 줄은 md 줄이다 — mdLine 이 그대로 둔다", () => {
  assert.equal(mdLine(err(14, "CHART_KIND", ""), 3), 14);
});

test("읽기 화면 한 줄: 적은 키를 순서대로, 종류는 키 없이", () => {
  assert.equal(
    chartLine("kind = line\nx = ts\ny = value"),
    "그래프 line · x ts · y value",
  );
  assert.equal(
    chartLine(
      "y=value, value2\nkind   = stacked-bar\nx = ts\nseries = snsr_id",
    ),
    "그래프 stacked-bar · x ts · y value, value2 · series snsr_id",
  );
  assert.equal(
    chartLine(
      "kind = heatmap\nx = step_id\ny = snsr_id\nvalue = avg_value\ntitle = 스텝 × 센서 평균",
    ),
    "그래프 heatmap · x step_id · y snsr_id · value avg_value · title 스텝 × 센서 평균",
  );
  assert.equal(chartLine(""), "그래프");
});
