#!/usr/bin/env node
// AKG's API answers timed from Node: the list (plain · gzip · etag), the
// bodies of one type, one doc GET, BE's N+1 path and two static files.
// Bytes are what came over the wire, so the gzip rows show the packed size.
import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { UsageError, apiOptions, formatTable, median } from "./lib.mjs";

const USAGE = `node bench/api.mjs --url <AKG 주소> (--token <에이전트 Bearer> | --cookie 'SESSION=<값>') [옵션]
  --type <type>   본문 · 문서 GET 을 잴 타입 (기본 /api/docs 첫 문서의 타입)
  --n <N>         N+1 길에서 차례로 GET 할 문서 수 (기본 300)
  --label <이름>  결과 파일 이름 <이름>-api.json · .txt (기본 run)
  --out <폴더>    결과 폴더 (기본 bench/out)`;

const DOC_SAMPLES = 30;
// One kept-alive connection, as fetch and BE's client hold it.
const agents = { "http:": new http.Agent({ keepAlive: true, maxSockets: 1 }), "https:": new https.Agent({ keepAlive: true, maxSockets: 1 }) };

/** GET as raw bytes: no decoding, so `bytes` is the size on the wire. */
function get(url, headers) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const req = lib.get(u, { headers: { "accept-encoding": "identity", ...headers }, agent: agents[u.protocol] }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, ms: performance.now() - t, bytes: body.length, headers: res.headers, body });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function main() {
  let opts;
  try {
    opts = apiOptions(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) return console.log(USAGE);
  const out = opts.out ?? fileURLToPath(new URL("out", import.meta.url));
  mkdirSync(out, { recursive: true });

  const at = (path) => new URL(path, opts.url).href;
  const rows = [];
  const add = (name, r) => {
    rows.push({ name, status: r.status ?? null, ms: r.ms ?? null, bytes: r.bytes ?? null });
    return r;
  };
  const gzip = { "accept-encoding": "gzip" };

  const list = add("/api/docs 평문", await get(at("api/docs"), opts.auth));
  if (list.status !== 200) throw new Error(`GET /api/docs ${list.status} (로그인 · 주소를 본다)`);
  add("/api/docs gzip", await get(at("api/docs"), { ...opts.auth, ...gzip }));
  const etag = list.headers.etag;
  if (etag) add("/api/docs if-none-match", await get(at("api/docs"), { ...opts.auth, "if-none-match": etag }));
  else rows.push({ name: "/api/docs if-none-match", status: "etag 없음", ms: null, bytes: null });

  const docs = JSON.parse(list.body.toString("utf8")).docs.filter((d) => d.status !== "archived");
  const type = opts.type ?? docs[0]?.type;
  if (!type) throw new Error("문서가 없다");
  const ids = docs.filter((d) => d.type === type).map((d) => d.id);
  if (!ids.length) throw new Error(`${type} 문서가 없다`);

  const bodies = `api/docs?type=${encodeURIComponent(type)}&fields=body`;
  for (let i = 1; i <= 3; i++) add(`/api/docs?type=${type}&fields=body #${i}`, await get(at(bodies), opts.auth));
  add(`/api/docs?type=${type}&fields=body gzip`, await get(at(bodies), { ...opts.auth, ...gzip }));

  const docUrl = (id) => at(`api/docs/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
  const one = [];
  for (let i = 0; i < DOC_SAMPLES; i++) one.push(await get(docUrl(ids[(i * 97) % ids.length]), opts.auth));
  const statuses = [...new Set(one.map((r) => r.status))].join(",");
  add(`문서 GET ${type} ×${DOC_SAMPLES} 중앙값`, { status: statuses, ms: median(one.map((r) => r.ms)), bytes: median(one.map((r) => r.bytes)) });
  add(`문서 GET ${type} ×${DOC_SAMPLES} 최대`, { status: statuses, ms: Math.max(...one.map((r) => r.ms)), bytes: Math.max(...one.map((r) => r.bytes)) });

  const n = Math.min(opts.n, ids.length);
  const t = performance.now();
  let bytes = 0;
  const seen = new Set();
  for (const id of ids.slice(0, n)) {
    const r = await get(docUrl(id), opts.auth);
    bytes += r.bytes;
    seen.add(r.status);
  }
  const total = performance.now() - t;
  add(`N+1 ${type} ${n} 건 차례로 · 총`, { status: [...seen].join(","), ms: total, bytes });
  add(`N+1 ${type} ${n} 건 차례로 · 건당`, { status: [...seen].join(","), ms: total / n, bytes: bytes / n });

  const js = add("/js/main.mjs", await get(at("js/main.mjs"), {}));
  if (js.headers.etag) add("/js/main.mjs if-none-match", await get(at("js/main.mjs"), { "if-none-match": js.headers.etag }));
  else rows.push({ name: "/js/main.mjs if-none-match", status: "etag 없음", ms: null, bytes: null });
  add("/vendor/mermaid/mermaid.min.js gzip", await get(at("vendor/mermaid/mermaid.min.js"), gzip));

  const head = `# api ${opts.label} · ${opts.url} · ${new Date().toISOString()} · 로그인 ${opts.auth.authorization ? "--token" : "--cookie"} · 문서 ${docs.length}(보관 제외) · ${type} ${ids.length}`;
  const table = formatTable(["측정", "상태", "ms", "바이트"], rows.map((r) => [r.name, String(r.status ?? "-"), r.ms, r.bytes]));
  const text = `${head}\n\n${table}\n`;
  console.log(text);
  writeFileSync(join(out, `${opts.label}-api.txt`), text);
  writeFileSync(
    join(out, `${opts.label}-api.json`),
    `${JSON.stringify({ label: opts.label, url: opts.url, at: new Date().toISOString(), type, docs: docs.length, typeDocs: ids.length, rows, docSamples: one.map((r) => ({ status: r.status, ms: r.ms, bytes: r.bytes })) }, null, 2)}\n`,
  );
  console.error(`결과: ${join(out, `${opts.label}-api.txt`)} · ${opts.label}-api.json`);
}

try {
  await main();
} finally {
  for (const a of Object.values(agents)) a.destroy();
}
