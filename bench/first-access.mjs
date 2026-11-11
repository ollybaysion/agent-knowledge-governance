#!/usr/bin/env node
// A person's first visit, timed in headless Chrome over CDP. One profile per
// run, five scenes in order: overview-cold → overview-settle → overview-warm →
// first-doc → docs-col2. bench/README.md has the steps and what each number means.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "redis";

import { SCENES, UsageError, cookiePairs, firstAccessOptions, pickChrome, sceneTable, summarize } from "./lib.mjs";

const USAGE = `node bench/first-access.mjs --url <AKG 주소> (--cookie 'SESSION=<값>' | --redis redis://… [--namespace spring:session]) [옵션]
  --chrome <경로>       Chrome 실행 파일 (기본: env CHROME → PATH → 설치 폴더)
  --label <이름>        결과 파일 이름 (기본 run)
  --runs <N>            판 수, 표에는 중앙값 (기본 3)
  --out <폴더>          결과 폴더 (기본 bench/out)
  --throttle slow       CPU 4 배 느리게 · 왕복 150 ms · 1.6 Mbps 다운 · 750 kbps 업
  --doc <type>/<id>     first-doc 장면에서 열 문서 (기본 개요 표 첫 줄)
  --type <type>         docs-col2 장면의 타입 (기본 개요 표 첫 줄의 타입)
  --user · --group      --redis 로 심는 세션의 사람 (기본 bench-user · user)
  --port <N>            Chrome 원격 디버깅 포트 (기본 0 = Chrome 이 고른다)`;

const OV_ROW = "#ov-table tbody tr";
const OV_DOC = "#ov-table tbody tr.nav-doc";
const CHIPS = "#ov-typechips button";
const DOC_BODY = ".doc-main .doc-body > *";
const COL2_ROW = ".mcol2 li.mrow";
const SCENE_TIMEOUT_MS = 180_000;
const QUIET_MS = 1000;
const SETTLE_MAX_MS = 10_000;
const MERMAID_MAX_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- page scripts ----------

// Every document: long tasks from its start, kept in window.__bench.lt as [start, duration].
const LONGTASKS = `(() => {
  const b = (window.__bench ??= { lt: [] });
  try {
    b.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) b.lt.push([e.startTime, e.duration]); });
    b.obs.observe({ type: "longtask", buffered: true });
  } catch {}
})();`;

// From the document start, each frame looks for sel; the frame after the first match is the first paint with it.
const paintProbe = (sel) => `(() => {
  const b = (window.__bench ??= { lt: [] });
  const tick = () => {
    if (b.found !== undefined) { b.painted = performance.now(); return; }
    if (document.querySelector(${JSON.stringify(sel)})) b.found = performance.now();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

const SNAPSHOT = `({
  dom: document.getElementsByTagName("*").length,
  ovRows: document.querySelectorAll(${JSON.stringify(OV_DOC)}).length,
  col2Rows: document.querySelectorAll(${JSON.stringify(COL2_ROW)}).length,
  hash: location.hash,
})`;

// After the first paint: wait until no long task for QUIET_MS (at most SETTLE_MAX_MS),
// then click the second type chip and time it to the second frame after.
const SETTLE = `new Promise((done) => {
  const b = window.__bench;
  const p = b.painted;
  const quiet = () => {
    if (b.obs) for (const e of b.obs.takeRecords()) b.lt.push([e.startTime, e.duration]);
    const now = performance.now();
    const last = Math.max(p, ...b.lt.map(([s, d]) => s + d));
    if (now - last >= ${QUIET_MS}) return click(last);
    if (now - p >= ${SETTLE_MAX_MS}) return click(null);
    setTimeout(quiet, 50);
  };
  const click = (quietAt) => {
    const until = quietAt ?? performance.now();
    const lt = b.lt.filter(([s]) => s <= until);
    const out = {
      quietMs: quietAt,
      longTasks: lt.length,
      longTaskMs: lt.reduce((n, [, d]) => n + d, 0),
      longestMs: lt.reduce((n, [, d]) => Math.max(n, d), 0),
    };
    const chip = document.querySelectorAll(${JSON.stringify(CHIPS)})[1];
    if (!chip) return done(out);
    const t0 = performance.now();
    chip.click();
    out.clickHandlerMs = performance.now() - t0;
    out.chipType = chip.dataset.type ?? chip.textContent;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      out.clickMs = performance.now() - t0;
      out.chipRows = document.querySelectorAll(${JSON.stringify(OV_DOC)}).length;
      done(out);
    }));
  };
  quiet();
})`;

// On the overview: open a doc (the first row, or the hash given) and time it to the first paint of its body;
// a mermaid figure on it also gets the frame's load and its first picture.
const firstDoc = (hash) => `new Promise((done) => {
  const out = {};
  const t0 = performance.now();
  const frames = new MutationObserver(() => {
    const f = document.querySelector("iframe.mmd-frame");
    if (!f || out.frameSeen) return;
    out.frameSeen = true;
    f.addEventListener("load", () => { out.mermaidFrameMs = performance.now() - t0; }, { once: true });
  });
  frames.observe(document.body, { childList: true });
  const finish = (extra = {}) => {
    frames.disconnect();
    delete out.frameSeen;
    done({ ...out, ...extra, hash: location.hash });
  };
  const hash = ${JSON.stringify(hash)};
  if (hash) location.hash = hash;
  else {
    const row = document.querySelector(${JSON.stringify(OV_DOC)});
    if (!row) return finish({ error: "개요 표에 줄이 없다" });
    row.click();
  }
  let found;
  const tick = () => {
    const now = performance.now();
    if (found !== undefined) {
      out.docMs = now - t0;
      return mermaid();
    }
    const err = document.querySelector("main .error");
    if (err) return finish({ error: err.textContent });
    if (document.querySelector(${JSON.stringify(DOC_BODY)})) found = now;
    if (now - t0 > ${SCENE_TIMEOUT_MS}) return finish({ timeout: true });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const mermaid = () => {
    if (!document.querySelector(".mermaid-fig")) return finish();
    const wait = () => {
      const now = performance.now();
      if (out.mermaidSvgMs === undefined && document.querySelector(".mermaid-fig svg, .mermaid-fig.failed")) out.mermaidSvgMs = now - t0;
      if ((out.mermaidSvgMs !== undefined && out.mermaidFrameMs !== undefined) || now - t0 > ${MERMAID_MAX_MS}) return finish();
      requestAnimationFrame(wait);
    };
    requestAnimationFrame(wait);
  };
})`;

// ---------- CDP ----------

async function devtoolsPort(profile, port, chrome) {
  for (let i = 0; i < 200; i++) {
    if (chrome.exitCode !== null) throw new Error(`Chrome 이 바로 끝났다 (종료 코드 ${chrome.exitCode})`);
    if (port) return port;
    const file = join(profile, "DevToolsActivePort");
    if (existsSync(file)) {
      const n = Number(readFileSync(file, "utf8").split("\n")[0]);
      if (n) return n;
    }
    await sleep(100);
  }
  throw new Error("Chrome 원격 디버깅 포트를 찾지 못했다");
}

async function pageTarget(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error(`Chrome 이 ${port} 에서 답하지 않는다`);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP 에 붙지 못했다")), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) for (const fn of listeners) fn(msg);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { ws, send, evaluate, on: (fn) => listeners.push(fn) };
}

// ---------- one run ----------

async function oneRun(opts, ctx, n) {
  const profile = mkdtempSync(join(tmpdir(), "akg-bench-"));
  const chrome = spawn(
    ctx.chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${opts.port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise((r) => chrome.once("exit", r));
  let cdp = null;
  try {
    const port = await devtoolsPort(profile, opts.port, chrome);
    cdp = await connect((await pageTarget(port)).webSocketDebuggerUrl);
    const { send, evaluate } = cdp;
    ctx.browser ??= (await send("Browser.getVersion")).product;

    // requestId → {url, status, bytes}, one map per scene. A revalidated file
    // reaches responseReceived as the cached 200; its 304 is in the ExtraInfo.
    let net = new Map();
    cdp.on((m) => {
      const p = m.params;
      if (m.method === "Network.requestWillBeSent") {
        if (!net.has(p.requestId)) net.set(p.requestId, { url: p.request.url, status: null, bytes: 0 });
        return;
      }
      const r = net.get(p?.requestId);
      if (!r) return;
      if (m.method === "Network.responseReceivedExtraInfo") r.wire = p.statusCode;
      else if (m.method === "Network.responseReceived") r.status = p.response.status;
      else if (m.method === "Network.loadingFinished") r.bytes = p.encodedDataLength;
      else if (m.method === "Network.loadingFailed") r.failed = p.errorText;
    });

    await send("Network.enable");
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const c of ctx.cookies) await send("Network.setCookie", { name: c.name, value: c.value, url: opts.url });
    if (opts.throttle) {
      await send("Emulation.setCPUThrottlingRate", { rate: opts.throttle.cpuRate });
      await send("Network.emulateNetworkConditions", {
        offline: false,
        latency: opts.throttle.latencyMs,
        downloadThroughput: opts.throttle.downBps / 8,
        uploadThroughput: opts.throttle.upBps / 8,
      });
    }
    await send("Page.addScriptToEvaluateOnNewDocument", { source: LONGTASKS });

    const scenes = {};
    const finishScene = async (name, metrics) => {
      const snap = await evaluate(SNAPSHOT);
      const requests = [...net.values()];
      const docs = requests.filter((r) => /\/api\/docs(\?|$)/.test(r.url));
      const shot = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(ctx.out, `${opts.label}-${name}.png`), Buffer.from(shot.data, "base64"));
      scenes[name] = {
        ...metrics,
        dom: snap.dom,
        ...(name.startsWith("overview") ? { ovRows: snap.ovRows } : {}),
        ...(name === "docs-col2" ? { col2Rows: snap.col2Rows } : {}),
        requests: requests.length,
        notModified: requests.filter((r) => (r.wire ?? r.status) === 304).length,
        bytes: requests.reduce((s, r) => s + r.bytes, 0),
        docsList: docs.map((d) => `${d.wire ?? d.status ?? d.failed ?? "?"} ${d.bytes}B`).join(", ") || "-",
        hash: snap.hash,
        requestList: requests,
      };
      net = new Map();
      return snap;
    };

    // A new document at hash (or a reload), timed to the first paint with sel.
    const load = async (name, hash, sel, { reload = false } = {}) => {
      const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", { source: paintProbe(sel) });
      if (reload) {
        net = new Map();
        await send("Page.reload", { ignoreCache: false });
      } else {
        await send("Page.navigate", { url: "about:blank" });
        await sleep(200);
        net = new Map();
        await send("Page.navigate", { url: `${opts.url}${hash}` });
      }
      let r = null;
      const t = Date.now();
      while (Date.now() - t < SCENE_TIMEOUT_MS) {
        await sleep(50);
        try {
          r = await evaluate(`window.__bench?.painted === undefined ? null : { found: window.__bench.found, painted: window.__bench.painted }`);
          if (r) break;
        } catch {
          /* navigation in progress */
        }
      }
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      if (!r) console.error(`  ${name}: ${SCENE_TIMEOUT_MS / 1000} s 안에 ${sel} 을 그리지 못했다`);
      return r ? { paintMs: r.painted, foundMs: r.found } : { timeout: true };
    };

    const cold = await load("overview-cold", "#/overview", OV_ROW);
    await sleep(300);
    await finishScene("overview-cold", cold);

    if (!cold.timeout) await finishScene("overview-settle", await evaluate(SETTLE));

    const warm = await load("overview-warm", "#/overview", OV_ROW, { reload: true });
    await sleep(300);
    await finishScene("overview-warm", warm);
    // The overview table's first row: the page's own cached list, so no request.
    const firstType = await evaluate(`import(${JSON.stringify(new URL("js/api.mjs", opts.url).href)}).then((m) => m.allDocs()).then((d) => d[0]?.type ?? null)`).catch(() => null);

    const docHash = opts.doc ? `#/doc/${opts.doc.type}/${encodeURIComponent(opts.doc.id)}` : null;
    const doc = warm.timeout && !docHash ? { error: "개요가 그려지지 않았다" } : await evaluate(firstDoc(docHash));
    const [, , docType, docId] = (doc.hash ?? "").split("/").map((p) => decodeURIComponent(p));
    delete doc.hash;
    await sleep(300);
    await finishScene("first-doc", { doc: docType && docId ? `${docType}/${docId}` : null, ...doc });

    const type = opts.type ?? firstType ?? docType;
    if (type) {
      const col2 = await load("docs-col2", `#/docs/${encodeURIComponent(type)}`, COL2_ROW);
      await sleep(300);
      await finishScene("docs-col2", col2);
    } else console.error("  docs-col2: 타입을 정하지 못했다 (--type 으로 준다)");

    console.error(`판 ${n} 끝`);
    return { run: n, scenes };
  } finally {
    // Chrome may exit before it answers, so the answer is not waited for long.
    if (cdp) await Promise.race([cdp.send("Browser.close").catch(() => {}), sleep(2000)]);
    cdp?.ws.close();
    await Promise.race([exited, sleep(3000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill();
  }
}

// ---------- session ----------

/** A session in BE's shape (test/sign-in.mjs writeSession), under the namespace given. @returns {{cookie, drop}} */
async function plantSession({ url, namespace, identity }) {
  const client = createClient({ url });
  await client.connect();
  const id = randomUUID();
  const key = `${namespace}:sessions:${id}`;
  const now = String(Date.now());
  await client.hSet(key, {
    creationTime: now,
    lastAccessedTime: now,
    maxInactiveInterval: "1800",
    "sessionAttr:fdc.identity": JSON.stringify({ "@class": "java.util.LinkedHashMap", ...identity }),
    "sessionAttr:fdc.csrf": JSON.stringify({
      "@class": "org.springframework.security.web.csrf.DefaultCsrfToken",
      headerName: "X-CSRF-TOKEN",
      parameterName: "_csrf",
      token: randomUUID(),
    }),
  });
  await client.pExpire(key, 30 * 60 * 1000);
  return {
    cookie: `SESSION=${Buffer.from(id).toString("base64")}`,
    drop: async () => {
      await client.del(key);
      await client.quit();
    },
  };
}

// ---------- main ----------

async function main() {
  let opts;
  try {
    opts = firstAccessOptions(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) return console.log(USAGE);

  const chromePath = pickChrome({ flag: opts.chrome, env: process.env, platform: process.platform, exists: existsSync });
  if (!chromePath) {
    console.error("Chrome 을 찾지 못했다. --chrome <경로> 또는 env CHROME 으로 준다.");
    process.exitCode = 2;
    return;
  }
  const out = opts.out ?? fileURLToPath(new URL("out", import.meta.url));
  mkdirSync(out, { recursive: true });

  const session = opts.redis ? await plantSession(opts.redis) : null;
  try {
    const cookieText = session?.cookie ?? opts.cookie;
    const check = await fetch(new URL("api/types", opts.url), { headers: { cookie: cookiePairs(cookieText).map((c) => `${c.name}=${c.value}`).join("; ") } });
    if (!check.ok) throw new Error(`로그인 확인 실패: GET /api/types ${check.status} (쿠키 · 네임스페이스를 본다)`);

    const ctx = { chromePath, out, cookies: cookiePairs(cookieText), browser: null };
    const runs = [];
    for (let n = 1; n <= opts.runs; n++) runs.push(await oneRun(opts, ctx, n));

    const summary = summarize(runs, SCENES);
    const head = [
      `# first-access ${opts.label} · ${opts.url} · ${new Date().toISOString()}`,
      `# ${ctx.browser} · ${chromePath} · 1440×900 · 판 ${opts.runs} 중앙값` +
        (opts.throttle ? ` · throttle slow (CPU ×${opts.throttle.cpuRate} · 왕복 ${opts.throttle.latencyMs} ms · ${opts.throttle.downBps / 1e6} Mbps 다운 · ${opts.throttle.upBps / 1e3} kbps 업)` : ""),
      `# 로그인 ${session ? `--redis (${opts.redis.namespace})` : "--cookie"}`,
    ].join("\n");
    const text = `${head}\n\n${sceneTable(summary, opts.runs)}\n`;
    console.log(text);
    writeFileSync(join(out, `${opts.label}.txt`), text);
    writeFileSync(
      join(out, `${opts.label}.json`),
      `${JSON.stringify({ label: opts.label, url: opts.url, at: new Date().toISOString(), browser: ctx.browser, chrome: chromePath, throttle: opts.throttle, login: session ? "redis" : "cookie", summary, runs }, null, 2)}\n`,
    );
    console.error(`결과: ${join(out, `${opts.label}.txt`)} · ${opts.label}.json · ${opts.label}-<장면>.png`);
  } finally {
    await session?.drop();
  }
}

await main();
