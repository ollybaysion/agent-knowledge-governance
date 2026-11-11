// The parts of the bench scripts that need no browser and no server: the
// arguments, which Chrome to start, the session cookie, medians and the
// console table. test/bench-lib.test.mjs checks them under `npm test`.
import { posix, win32 } from "node:path";
import { parseArgs } from "node:util";

/** --throttle slow: a slow PC on the in-house network (CDP Emulation · Network). */
export const SLOW = { cpuRate: 4, latencyMs: 150, downBps: 1_600_000, upBps: 750_000 };

export const SCENES = ["overview-cold", "overview-settle", "overview-warm", "first-doc", "docs-col2"];

/** Metric key → its name in the table, in table order. */
export const METRICS = [
  ["paintMs", "첫 그림 ms"],
  ["foundMs", "줄 찾음 ms"],
  ["quietMs", "조용해짐 ms"],
  ["longTasks", "긴 작업 수"],
  ["longTaskMs", "긴 작업 합 ms"],
  ["longestMs", "가장 긴 작업 ms"],
  ["clickMs", "클릭 반영 ms"],
  ["clickHandlerMs", "클릭 처리 ms"],
  ["chipType", "누른 칩"],
  ["chipRows", "칩 뒤 줄"],
  ["doc", "연 문서"],
  ["docMs", "첫 문서 ms"],
  ["mermaidFrameMs", "mermaid 틀 load ms"],
  ["mermaidSvgMs", "mermaid 첫 그림 ms"],
  ["ovRows", "개요 줄"],
  ["col2Rows", "2열 줄"],
  ["dom", "DOM 노드"],
  ["requests", "요청"],
  ["notModified", "304"],
  ["bytes", "받은 바이트"],
  ["docsList", "/api/docs 응답"],
  ["timeout", "시간 초과"],
  ["error", "오류"],
];

const COMMON = {
  url: { type: "string" },
  cookie: { type: "string" },
  label: { type: "string", default: "run" },
  out: { type: "string" },
  type: { type: "string" },
  help: { type: "boolean", short: "h" },
};

export class UsageError extends Error {}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(err.message);
  }
}

/** The AKG address with one trailing slash, so `new URL("api/docs", base)` keeps a path prefix. */
export function baseUrl(raw) {
  if (!raw) throw new UsageError("--url 이 필요하다 (AKG 주소, 예: http://akg.example:8790)");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`--url 을 읽지 못했다: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UsageError(`--url 은 http · https 주소다: ${raw}`);
  u.hash = "";
  u.search = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.href;
}

function count(raw, name, min) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} 은 ${min} 이상의 정수다: ${raw}`);
  return n;
}

function label(raw) {
  if (!/^[\w.-]+$/.test(raw)) throw new UsageError(`--label 은 영문 · 숫자 · _ . - 만 쓴다(파일 이름이 된다): ${raw}`);
  return raw;
}

/** node bench/first-access.mjs … → the options, or a UsageError. */
export function firstAccessOptions(argv) {
  const v = parse(argv, {
    ...COMMON,
    redis: { type: "string" },
    namespace: { type: "string", default: "spring:session" },
    user: { type: "string", default: "bench-user" },
    group: { type: "string", default: "user" },
    chrome: { type: "string" },
    runs: { type: "string", default: "3" },
    throttle: { type: "string" },
    doc: { type: "string" },
    port: { type: "string", default: "0" },
  });
  if (v.help) return { help: true };
  const url = baseUrl(v.url);
  if (!v.cookie === !v.redis) throw new UsageError("로그인은 --cookie 'SESSION=…' 또는 --redis redis://… 중 하나다");
  if (v.throttle !== undefined && v.throttle !== "slow") throw new UsageError(`--throttle 은 slow 만 받는다: ${v.throttle}`);
  if (v.group !== "user" && v.group !== "admin") throw new UsageError(`--group 은 user · admin 이다: ${v.group}`);
  let doc = null;
  if (v.doc !== undefined) {
    const at = v.doc.indexOf("/");
    if (at < 1 || at === v.doc.length - 1) throw new UsageError(`--doc 은 <type>/<id> 다: ${v.doc}`);
    doc = { type: v.doc.slice(0, at), id: v.doc.slice(at + 1) };
  }
  return {
    url,
    cookie: v.cookie ?? null,
    redis: v.redis ? { url: v.redis, namespace: v.namespace, identity: { id: v.user, group: v.group } } : null,
    chrome: v.chrome ?? null,
    label: label(v.label),
    runs: count(v.runs, "runs", 1),
    out: v.out ?? null,
    throttle: v.throttle === "slow" ? SLOW : null,
    doc,
    type: v.type ?? null,
    port: count(v.port, "port", 0),
  };
}

/** node bench/api.mjs … → the options, or a UsageError. */
export function apiOptions(argv) {
  const v = parse(argv, { ...COMMON, token: { type: "string" }, n: { type: "string", default: "300" } });
  if (v.help) return { help: true };
  const url = baseUrl(v.url);
  if (!v.cookie === !v.token) throw new UsageError("로그인은 --token <에이전트 Bearer> 또는 --cookie 'SESSION=…' 중 하나다");
  return {
    url,
    auth: v.token ? { authorization: `Bearer ${v.token}` } : { cookie: cookieHeader(v.cookie) },
    label: label(v.label),
    out: v.out ?? null,
    type: v.type ?? null,
    n: count(v.n, "n", 1),
  };
}

/** What a person pasted (`SESSION=abc`, `abc`, or several `a=1; b=2`) → name/value pairs. A bare value is the SESSION cookie. */
export function cookiePairs(raw) {
  const pairs = [];
  for (const part of String(raw).split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq < 0) pairs.push({ name: "SESSION", value: s });
    else pairs.push({ name: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() });
  }
  if (!pairs.length) throw new UsageError("--cookie 가 비었다");
  return pairs;
}

export const cookieHeader = (raw) => cookiePairs(raw).map((p) => `${p.name}=${p.value}`).join("; ");

const WINDOWS_CHROME = [
  ["ProgramFiles", "C:\\Program Files"],
  ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
  ["LOCALAPPDATA", null],
];
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * The Chrome to start: --chrome, then env CHROME, then google-chrome · chrome ·
 * chromium on PATH, then the Windows install folders, then the macOS app.
 * @param {{flag?: string|null, env: Record<string,string|undefined>, platform: string, exists: (p: string) => boolean}} at
 * @returns {string|null}
 */
export function pickChrome({ flag = null, env, platform, exists }) {
  if (flag) return flag;
  if (env.CHROME) return env.CHROME;
  const win = platform === "win32";
  const path = win ? win32 : posix;
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  for (const name of ["google-chrome", "chrome", "chromium"])
    for (const dir of dirs)
      for (const file of win ? [`${name}.exe`] : [name]) {
        const p = path.join(dir, file);
        if (exists(p)) return p;
      }
  if (win)
    for (const [key, fallback] of WINDOWS_CHROME) {
      const root = env[key] ?? fallback;
      if (!root) continue;
      const p = win32.join(root, "Google", "Chrome", "Application", "chrome.exe");
      if (exists(p)) return p;
    }
  if (platform === "darwin" && exists(MAC_CHROME)) return MAC_CHROME;
  return null;
}

/** The middle value; the mean of the two middle ones for an even count; null for none. */
export function median(xs) {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Runs → one row per scene and metric: the median of the numbers, or the
 * distinct texts joined. A metric no run measured is left out.
 * @param {{scenes: Record<string, Record<string, unknown>>}[]} runs
 */
export function summarize(runs, scenes = SCENES) {
  const rows = [];
  for (const scene of scenes)
    for (const [key, name] of METRICS) {
      const values = runs.map((r) => r.scenes?.[scene]?.[key]);
      if (values.every((x) => x === undefined)) continue;
      const numeric = values.some((x) => typeof x === "number");
      const mid = numeric ? median(values) : [...new Set(values.filter((x) => x != null))].join(" | ") || null;
      rows.push({ scene, key, name, median: mid, values: values.map((x) => x ?? null) });
    }
  return rows;
}

/** A number for the table: thousands commas; 2 decimals under 10, 1 under 100, none above. */
export function fmt(x) {
  if (x === null || x === undefined) return "-";
  if (typeof x !== "number") return String(x);
  const digits = Number.isInteger(x) || Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2;
  return x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Columns a terminal gives the text: Hangul and other wide letters take two. */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * Text table. Cells are strings or numbers; numbers go through fmt() and
 * stand to the right.
 * @param {string[]} headers
 * @param {(string|number|null)[][]} rows
 */
export function formatTable(headers, rows) {
  const cells = rows.map((r) => r.map((c) => ({ text: typeof c === "number" || c === null ? fmt(c) : String(c), right: typeof c === "number" || c === null })));
  const widths = headers.map((h, i) => Math.max(displayWidth(h), ...cells.map((r) => displayWidth(r[i]?.text ?? ""))));
  const pad = (text, i, right) => {
    const gap = " ".repeat(widths[i] - displayWidth(text));
    return right ? gap + text : text + gap;
  };
  const line = (r) => r.map((c, i) => pad(c.text, i, c.right)).join("  ").trimEnd();
  return [line(headers.map((h) => ({ text: h }))), widths.map((w) => "-".repeat(w)).join("  "), ...cells.map(line)].join("\n");
}

/** summarize() rows → the console table: scene · metric · median · each run. */
export function sceneTable(summary, runCount) {
  const runs = Array.from({ length: runCount }, (_, i) => `판 ${i + 1}`);
  let last = null;
  const rows = summary.map((r) => {
    const scene = r.scene === last ? "" : r.scene;
    last = r.scene;
    return [scene, r.name, r.median, ...r.values];
  });
  return formatTable(["장면", "수치", "중앙값", ...runs], rows);
}
