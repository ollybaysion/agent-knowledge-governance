// bench/lib.mjs: the bench scripts' arguments, Chrome lookup and table, without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLOW,
  UsageError,
  apiOptions,
  baseUrl,
  cookieHeader,
  cookiePairs,
  displayWidth,
  firstAccessOptions,
  fmt,
  formatTable,
  median,
  pickChrome,
  sceneTable,
  summarize,
} from "../bench/lib.mjs";

const URL_ARG = ["--url", "http://akg.local:8790"];

test("first-access: the defaults with a pasted cookie", () => {
  assert.deepEqual(firstAccessOptions([...URL_ARG, "--cookie", "SESSION=abc"]), {
    url: "http://akg.local:8790/",
    cookie: "SESSION=abc",
    redis: null,
    chrome: null,
    label: "run",
    runs: 3,
    out: null,
    throttle: null,
    doc: null,
    type: null,
    port: 0,
  });
});

test("first-access: --redis plants a session under the namespace given; --throttle slow is the slow profile", () => {
  const o = firstAccessOptions([...URL_ARG, "--redis", "redis://r:6379", "--namespace", "fdc:session", "--group", "admin", "--throttle", "slow", "--runs", "5", "--doc", "db-schema/a/b", "--label", "office-1"]);
  assert.deepEqual(o.redis, { url: "redis://r:6379", namespace: "fdc:session", identity: { id: "bench-user", group: "admin" } });
  assert.equal(o.throttle, SLOW);
  assert.equal(o.runs, 5);
  assert.deepEqual(o.doc, { type: "db-schema", id: "a/b" });
  assert.equal(o.label, "office-1");
  assert.equal(firstAccessOptions([...URL_ARG, "--redis", "redis://r"]).redis.namespace, "spring:session");
});

test("first-access: a bad argument is a UsageError", () => {
  const bad = [
    [],
    ["--url", "ftp://x"],
    [...URL_ARG],
    [...URL_ARG, "--cookie", "a", "--redis", "redis://r"],
    [...URL_ARG, "--cookie", "a", "--throttle", "fast"],
    [...URL_ARG, "--cookie", "a", "--runs", "0"],
    [...URL_ARG, "--cookie", "a", "--doc", "no-slash"],
    [...URL_ARG, "--cookie", "a", "--label", "../x"],
    [...URL_ARG, "--cookie", "a", "--group", "agent"],
    [...URL_ARG, "--cookie", "a", "--unknown"],
  ];
  for (const argv of bad) assert.throws(() => firstAccessOptions(argv), UsageError, argv.join(" "));
});

test("api: --token or --cookie, --n 300 by default", () => {
  assert.deepEqual(apiOptions([...URL_ARG, "--token", "t1"]), { url: "http://akg.local:8790/", auth: { authorization: "Bearer t1" }, label: "run", out: null, type: null, n: 300 });
  assert.deepEqual(apiOptions([...URL_ARG, "--cookie", "abc", "--n", "20", "--type", "manual"]).auth, { cookie: "SESSION=abc" });
  assert.throws(() => apiOptions([...URL_ARG]), UsageError);
  assert.throws(() => apiOptions([...URL_ARG, "--token", "t", "--cookie", "c"]), UsageError);
});

test("the address keeps its path prefix and drops hash and query", () => {
  assert.equal(baseUrl("https://h/akg"), "https://h/akg/");
  assert.equal(baseUrl("http://h:1/#/overview?x=1"), "http://h:1/");
  assert.equal(new URL("api/docs", baseUrl("https://h/akg")).href, "https://h/akg/api/docs");
});

test("a pasted cookie: name=value, a bare value as SESSION, several at once", () => {
  assert.deepEqual(cookiePairs("SESSION=YWJj"), [{ name: "SESSION", value: "YWJj" }]);
  assert.deepEqual(cookiePairs(" YWJj= "), [{ name: "YWJj", value: "" }]);
  assert.deepEqual(cookiePairs("YWJj"), [{ name: "SESSION", value: "YWJj" }]);
  assert.equal(cookieHeader("SESSION=a; other=b"), "SESSION=a; other=b");
  assert.throws(() => cookiePairs(" ; "), UsageError);
});

test("Chrome: --chrome, env CHROME, PATH in order, then the install folders", () => {
  const has = (...paths) => (p) => paths.includes(p);
  assert.equal(pickChrome({ flag: "/x/chrome", env: { CHROME: "/y" }, platform: "linux", exists: has() }), "/x/chrome");
  assert.equal(pickChrome({ env: { CHROME: "/y", PATH: "/usr/bin" }, platform: "linux", exists: has("/usr/bin/google-chrome") }), "/y");
  assert.equal(pickChrome({ env: { PATH: "/a:/b" }, platform: "linux", exists: has("/b/google-chrome", "/a/chromium") }), "/b/google-chrome");
  assert.equal(pickChrome({ env: { PATH: "/a:/b" }, platform: "linux", exists: has("/a/chromium") }), "/a/chromium");
  assert.equal(pickChrome({ env: { PATH: "/a" }, platform: "linux", exists: has() }), null);

  const win = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(pickChrome({ env: { Path: "C:\\bin" }, platform: "win32", exists: has(win) }), win);
  assert.equal(pickChrome({ env: { Path: "C:\\bin" }, platform: "win32", exists: has("C:\\bin\\chrome.exe", win) }), "C:\\bin\\chrome.exe");
  const local = "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  assert.equal(pickChrome({ env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, platform: "win32", exists: has(local) }), local);

  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(pickChrome({ env: { PATH: "/usr/bin" }, platform: "darwin", exists: has(mac) }), mac);
});

test("median: the middle one, the mean of two middles, null for none", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([null, undefined]), null);
  assert.equal(median([5, null, 1]), 3);
});

test("summarize: medians per scene and metric, texts joined, unmeasured metrics left out", () => {
  const runs = [
    { scenes: { "overview-cold": { paintMs: 300, docsList: "200 1B" }, "first-doc": { docMs: 10 } } },
    { scenes: { "overview-cold": { paintMs: 100, docsList: "200 1B" }, "first-doc": { docMs: null } } },
    { scenes: { "overview-cold": { paintMs: 200, docsList: "304 0B" } } },
  ];
  assert.deepEqual(summarize(runs), [
    { scene: "overview-cold", key: "paintMs", name: "첫 그림 ms", median: 200, values: [300, 100, 200] },
    { scene: "overview-cold", key: "docsList", name: "/api/docs 응답", median: "200 1B | 304 0B", values: ["200 1B", "200 1B", "304 0B"] },
    { scene: "first-doc", key: "docMs", name: "첫 문서 ms", median: 10, values: [10, null, null] },
  ]);
});

test("the table lines up Hangul (two columns each) and puts numbers on the right", () => {
  assert.equal(displayWidth("첫 그림"), 7);
  assert.equal(fmt(1321.4), "1,321");
  assert.equal(fmt(20.94), "20.9");
  assert.equal(fmt(3.9), "3.90");
  assert.equal(fmt(null), "-");
  assert.equal(formatTable(["이름", "ms"], [["가", 5], ["abc", 1234]]), ["이름  ms", "----  -----", "가        5", "abc   1,234"].join("\n"));
  const t = sceneTable(
    [
      { scene: "a", name: "x", median: 1, values: [1] },
      { scene: "a", name: "y", median: 2, values: [2] },
    ],
    1,
  );
  assert.deepEqual(t.split("\n").slice(2), ["a     x          1     1", "      y          2     2"]);
});
