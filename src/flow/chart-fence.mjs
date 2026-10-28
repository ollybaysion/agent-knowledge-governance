// The ```chart fence of a query item — BE ChartFence.java: one `키 = 값` a
// line, several columns comma-separated. Every error's line is the md's.
// Whether an item has two is agent-md's (CHART_DUPLICATE). No node imports:
// the dashboard runs this file as it is.
import { Code, flowError } from "./flow-error.mjs";
import { assign } from "./flow-maps.mjs";

/** The fence language. */
export const LANG = "chart";
/** The keys it takes, in the order the reasons name them. */
export const KEYS = [
  "kind",
  "x",
  "y",
  "series",
  "facet",
  "value",
  "bins",
  "title",
];
/** BE Chart.Kind's wire names, in its order. */
export const KINDS = [
  "line",
  "step",
  "area",
  "bar",
  "stacked-bar",
  "scatter",
  "histogram",
  "heatmap",
  "box",
];
/** A histogram's bins when the fence names none. */
export const DEFAULT_BINS = 20;
const MIN_BINS = 1;
const MAX_BINS = 200;
const COLUMN_KEYS = ["x", "y", "series", "facet", "value"];

/** null for a blank value. */
const single = (text) =>
  text != null && text.trim() !== "" ? text.trim() : null;

/** The comma-separated columns, blank pieces left out. */
const list = (text) =>
  text == null
    ? []
    : text
        .split(",")
        .filter((p) => p.trim() !== "")
        .map((p) => p.trim());

const kindOf = (text) =>
  text == null
    ? null
    : (KINDS.find((k) => k.toLowerCase() === text.trim().toLowerCase()) ??
      null);

/** An integer 1~200, else null. */
function bins(text) {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= MIN_BINS && n <= MAX_BINS ? n : null;
}

const sameName = (a, b) =>
  a.toUpperCase() === b.toUpperCase() || a.toLowerCase() === b.toLowerCase();

/** The written `키 = 값` lines: key → {value, line}, the first of a key, lower-case keys. */
function keyLines(rows) {
  const out = new Map();
  for (const r of rows) {
    const text = r.text.trim();
    const eq = assign(text);
    if (eq <= 0) continue;
    const key = text.slice(0, eq).trim().toLowerCase();
    if (KEYS.includes(key) && !out.has(key))
      out.set(key, { value: text.slice(eq + 1).trim(), line: r.line });
  }
  return out;
}

/**
 * One chart fence read and checked — BE ChartFence.read. A column is matched
 * to the statement's output columns, any case. With no output columns read
 * (`select *`) the columns go unchecked and a warning says so.
 * @param {{id: string, title: string}} query the query item
 * @param {{line: number, rows: {line: number, text: string}[]}} fence line = its opening md line, rows = its md lines
 * @param {string[]|null} outputs the statement's output columns (sql-bind columnsOf); null when unread
 * @returns {{chart: object|null, errors: object[], warning: object|null}} chart null on an error;
 *   errors CHART_KEY · CHART_KIND · CHART_REQUIRED · CHART_BINS · CHART_COLUMN, md line order
 */
export function readChart(query, fence, outputs) {
  const errors = [];
  const values = new Map();
  const lines = new Map();
  for (const r of fence.rows) {
    const text = r.text.trim();
    if (text === "") continue;
    const eq = assign(text);
    if (eq <= 0) {
      errors.push(
        flowError(
          r.line,
          Code.CHART_KEY,
          `chart 줄은 '키 = 값' 꼴이다: ${text}`,
        ),
      );
      continue;
    }
    const key = text.slice(0, eq).trim().toLowerCase();
    if (!KEYS.includes(key)) {
      errors.push(
        flowError(
          r.line,
          Code.CHART_KEY,
          `모르는 키 ${key} — 받는 키는 ${KEYS.join(" · ")}`,
        ),
      );
      continue;
    }
    if (values.has(key)) {
      errors.push(
        flowError(r.line, Code.CHART_KEY, `키 ${key} 가 두 번 나온다`),
      );
      continue;
    }
    values.set(key, text.slice(eq + 1).trim());
    lines.set(key, r.line);
  }
  const lineOf = (key) => lines.get(key) ?? fence.line;

  const kind = kindOf(values.get("kind"));
  const x = single(values.get("x"));
  const y = list(values.get("y"));
  const value = single(values.get("value"));
  if (single(values.get("kind")) === null)
    errors.push(flowError(lineOf("kind"), Code.CHART_REQUIRED, "kind 가 없다"));
  else if (kind === null)
    errors.push(
      flowError(
        lines.get("kind"),
        Code.CHART_KIND,
        `모르는 종류 ${values.get("kind")} — 받는 종류는 ${KINDS.join(" · ")}`,
      ),
    );
  if (x === null)
    errors.push(flowError(lineOf("x"), Code.CHART_REQUIRED, "x 가 없다"));
  if (!y.length && kind !== null && kind !== "heatmap" && kind !== "histogram")
    errors.push(
      flowError(
        lineOf("y"),
        Code.CHART_REQUIRED,
        `y 가 없다 — ${kind} 는 y 열을 적는다`,
      ),
    );
  if (value === null && kind === "heatmap")
    errors.push(
      flowError(
        lineOf("value"),
        Code.CHART_REQUIRED,
        "value 가 없다 — heatmap 은 색 값 열을 적는다",
      ),
    );
  let binCount = kind === "histogram" ? DEFAULT_BINS : null;
  if (values.has("bins")) {
    binCount = bins(values.get("bins"));
    if (binCount === null)
      errors.push(
        flowError(
          lines.get("bins"),
          Code.CHART_BINS,
          `bins 는 ${MIN_BINS}~${MAX_BINS} 의 정수다: ${values.get("bins")}`,
        ),
      );
  }

  const warning =
    outputs == null
      ? flowError(
          fence.line,
          Code.CHART_COLUMN,
          `조회 ${query.id} 의 chart 열을 검사하지 않는다 — 문장의 출력 열을 읽지 못했다(select * 등)`,
        )
      : null;
  if (outputs != null)
    for (const key of COLUMN_KEYS)
      for (const column of list(values.get(key)))
        if (!outputs.some((o) => sameName(o.trim(), column)))
          errors.push(
            flowError(
              lines.get(key),
              Code.CHART_COLUMN,
              `${key} 열 ${column} 이 조회 ${query.id} 의 출력 열에 없다 — 출력 열은 ${outputs.join(" · ")}`,
            ),
          );
  if (errors.length)
    return {
      chart: null,
      errors: errors.sort((a, b) => a.line - b.line),
      warning,
    };
  const chart = {
    kind,
    x,
    y,
    series: list(values.get("series")),
    facet: single(values.get("facet")),
    value,
    bins: binCount,
    title: single(values.get("title")) ?? query.title,
  };
  return { chart, errors, warning };
}

/**
 * The reading view's one line for a chart fence's text: `그래프 line · x ts · y value`,
 * the written keys in {@link KEYS} order, the kind without its key.
 */
export function chartLine(text) {
  const rows = String(text ?? "")
    .split("\n")
    .map((t, i) => ({ text: t, line: i + 1 }));
  const written = keyLines(rows);
  const parts = KEYS.filter((k) => single(written.get(k)?.value) !== null).map(
    (k) =>
      k === "kind" ? written.get(k).value : `${k} ${written.get(k).value}`,
  );
  return parts.length ? `그래프 ${parts.join(" · ")}` : "그래프";
}
