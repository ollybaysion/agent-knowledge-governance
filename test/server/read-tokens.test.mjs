// Personal read tokens (consuming.md "다른 앱에서 AKG 문서 읽기"). A person
// issues a token on the AKG page; a local app (WorkBench) reads with
// `Authorization: Bearer akgr_…` across origins. Each test names the line of
// the contract it checks.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createClient } from "redis";

import { buildApp } from "../../server/app.mjs";
import { clearAuthFailures } from "../../server/auth.mjs";
import { LAST_USED_WINDOW_MS, READ_TOKEN_PATTERN } from "../../server/read-tokens.mjs";
import { REDIS_URL, READ_TOKEN_PREFIX, signIn, as } from "../sign-in.mjs";

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const tokenKey = (token) => `${READ_TOKEN_PREFIX}:read-token:${sha256(token)}`;
const indexKey = (owner) => `${READ_TOKEN_PREFIX}:read-tokens:${owner}`;

// One run's owners, so a token left by another run never counts toward the limit here.
const run = randomUUID().slice(0, 8);
const owners = new Set();
let seq = 0;
const ownerId = (name) => {
  const id = `rt-${name}-${run}-${++seq}`;
  owners.add(id);
  return id;
};

let client = null;
async function redis() {
  if (!client) {
    client = createClient({ url: REDIS_URL });
    await client.connect();
  }
  return client;
}
after(async () => {
  const r = await redis();
  for (const owner of owners) {
    const members = await r.zRange(indexKey(owner), 0, -1);
    for (const hash of members) await r.del(`${READ_TOKEN_PREFIX}:read-token:${hash}`);
    await r.del(indexKey(owner));
  }
  await r.close();
});

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n${"글 ".repeat(400)}\n` },
});

/**
 * A server with two people: an admin (`a`) and a user (`u`), plus an agent (`bot`).
 * Pass `auth` overrides for a Keycloak server.
 */
async function setup({ keycloakIssuer } = {}) {
  const home = mkdtempSync(join(tmpdir(), "akg-read-tokens-test-"));
  const admin = ownerId("admin");
  const user = ownerId("user");
  const n = seq;
  const signedIn = await signIn(home, [
    { id: admin, group: "admin", token: `a-${run}-${n}` },
    { id: user, group: "user", token: `u-${run}-${n}` },
    { id: `bot-${run}-${n}`, group: "agent", token: `bot-${run}-${n}` },
  ]);
  const auth = keycloakIssuer ? { ...signedIn, usersFile: "", keycloakIssuer } : signedIn;
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  const A = as(`a-${run}-${n}`);
  const U = as(`u-${run}-${n}`);
  const BOT = as(`bot-${run}-${n}`);
  if (!keycloakIssuer)
    assert.equal((await app.inject({ method: "POST", url: "/api/docs/voc", headers: A, payload: voc("line-alarm") })).statusCode, 201);
  const issue = async (headers, payload = { label: "WorkBench" }) =>
    app.inject({ method: "POST", url: "/api/read-tokens", headers, payload });
  const bearer = (token) => ({ authorization: `Bearer ${token}` });
  return {
    app,
    admin,
    user,
    A,
    U,
    BOT,
    issue,
    bearer,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
      clearAuthFailures("127.0.0.1");
    },
  };
}

function readCors(res, label) {
  assert.equal(res.headers["access-control-allow-origin"], "*", `${label}: allow-origin`);
  assert.equal(res.headers["access-control-expose-headers"], "ETag", `${label}: expose-headers`);
  assert.equal(res.headers["access-control-allow-credentials"], undefined, `${label}: allow-credentials`);
}
function noCors(res, label) {
  for (const h of ["access-control-allow-origin", "access-control-expose-headers", "access-control-allow-methods", "access-control-allow-credentials"])
    assert.equal(res.headers[h], undefined, `${label}: ${h}`);
}

// ---------- 토큰 ----------

test("토큰: akgr_ + 43 자 base64url, id = sha256 앞 12 자, 발급 응답 201 {id, label, createdAt, expiresAt, token}", async () => {
  const s = await setup();
  try {
    const res = await s.issue(s.U, { label: "  WorkBench 노트북  " });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ["createdAt", "expiresAt", "id", "label", "token"]);
    assert.match(body.token, READ_TOKEN_PATTERN);
    assert.match(body.token, /^akgr_[A-Za-z0-9_-]{43}$/);
    assert.equal(body.id, sha256(body.token).slice(0, 12));
    assert.equal(body.label, "WorkBench 노트북");
    assert.equal(res.headers["cache-control"], "no-store");
    // ISO 8601, 기본 90 일.
    assert.equal(new Date(body.createdAt).toISOString(), body.createdAt);
    assert.equal(Date.parse(body.expiresAt) - Date.parse(body.createdAt), 90 * DAY);
    // 토큰마다 다르다.
    assert.notEqual((await s.issue(s.U)).json().token, body.token);
  } finally {
    await s.cleanup();
  }
});

test("저장: Redis 에 원문은 없고 sha256 키의 hash(owner · label · createdAt · expiresAt) 와 사람별 zset 색인, PEXPIREAT = expiresAt", async () => {
  const s = await setup();
  try {
    const body = (await s.issue(s.U)).json();
    const r = await redis();
    const fields = await r.hGetAll(tokenKey(body.token));
    assert.deepEqual(Object.keys(fields).sort(), ["createdAt", "expiresAt", "label", "owner"]);
    assert.equal(fields.owner, s.user);
    assert.equal(fields.label, "WorkBench");
    assert.equal(Number(fields.createdAt), Date.parse(body.createdAt));
    assert.equal(Number(fields.expiresAt), Date.parse(body.expiresAt));
    assert.ok(!Object.values(fields).some((v) => v.includes(body.token.slice(5))), "원문이 값에 없다");
    const pttl = await r.pTTL(tokenKey(body.token));
    assert.ok(Math.abs(Date.now() + pttl - Number(fields.expiresAt)) < 5000, `PTTL ${pttl}`);
    const hash = sha256(body.token);
    assert.equal(await r.zScore(indexKey(s.user), hash), Number(fields.createdAt));
    // 원문으로 된 키는 어디에도 없다.
    assert.deepEqual(await r.keys(`*${body.token.slice(5)}*`), []);
  } finally {
    await s.cleanup();
  }
});

test("기간: days 30 · 90 · 365, 그 밖은 400 invalid_days; 이름: 앞뒤 공백 제거 뒤 1~40 자, 그 밖은 400 invalid_label", async () => {
  const s = await setup();
  try {
    for (const days of [30, 365]) {
      const body = (await s.issue(s.U, { label: `d${days}`, days })).json();
      assert.equal(Date.parse(body.expiresAt) - Date.parse(body.createdAt), days * DAY, String(days));
    }
    for (const days of [0, 7, 91, "90", 3650]) {
      const res = await s.issue(s.U, { label: "x", days });
      assert.equal(res.statusCode, 400, String(days));
      assert.equal(res.json().error, "invalid_days");
    }
    for (const label of ["", "   ", "가".repeat(41), 12, null, undefined, "줄\n바꿈"]) {
      const res = await s.issue(s.U, { label });
      assert.equal(res.statusCode, 400, JSON.stringify(label));
      assert.equal(res.json().error, "invalid_label");
    }
    assert.equal((await s.issue(s.U, { label: "가".repeat(40) })).statusCode, 201);
  } finally {
    await s.cleanup();
  }
});

test("상한: 살아 있는 토큰 5 개, 여섯째는 409 {error: read_token_limit, limit: 5}; 폐기하거나 만료되면 다시 발급된다", async () => {
  const s = await setup();
  try {
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      const res = await s.issue(s.U, { label: `t${i}` });
      assert.equal(res.statusCode, 201, `t${i}`);
      tokens.push(res.json());
    }
    const over = await s.issue(s.U, { label: "t5" });
    assert.equal(over.statusCode, 409);
    assert.deepEqual(over.json(), { error: "read_token_limit", limit: 5 });
    // 다른 사람은 따로 센다.
    assert.equal((await s.issue(s.A)).statusCode, 201);

    assert.equal((await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${tokens[0].id}`, headers: s.U })).statusCode, 204);
    assert.equal((await s.issue(s.U, { label: "t5" })).statusCode, 201);
    assert.equal((await s.issue(s.U, { label: "t6" })).statusCode, 409);

    // 만료(키가 사라짐): 색인에 남은 항목은 세지 않고 치운다.
    const r = await redis();
    await r.del(tokenKey(tokens[1].token));
    assert.equal(await r.zScore(indexKey(s.user), sha256(tokens[1].token)) !== null, true);
    assert.equal((await s.issue(s.U, { label: "t6" })).statusCode, 201);
    assert.equal(await r.zScore(indexKey(s.user), sha256(tokens[1].token)), null);
  } finally {
    await s.cleanup();
  }
});

test("동시 발급: 넷이 있을 때 둘이 한꺼번에 오면 하나만 201, 하나는 409", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 4; i++) assert.equal((await s.issue(s.U, { label: `t${i}` })).statusCode, 201);
    const codes = (await Promise.all([s.issue(s.U, { label: "x" }), s.issue(s.U, { label: "y" })])).map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [201, 409]);
  } finally {
    await s.cleanup();
  }
});

// ---------- 토큰으로 들어온 요청 ----------

test("읽기: 토큰으로 /api/types · /api/docs · /api/docs/:type/:id(?format=md) · /api/tags · /api/me 가 200, 신원은 group user", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const h = s.bearer(token);
    for (const url of ["/api/types", "/api/docs", "/api/docs/voc/line-alarm", "/api/tags"]) {
      const res = await s.app.inject({ method: "GET", url, headers: h });
      assert.equal(res.statusCode, 200, url);
      readCors(res, url);
    }
    const md = await s.app.inject({ method: "GET", url: "/api/docs/voc/line-alarm?format=md", headers: h });
    assert.equal(md.statusCode, 200);
    assert.match(md.headers["content-type"], /markdown|text/);
    assert.match(md.body, /# line-alarm/);
    const me = await s.app.inject({ method: "GET", url: "/api/me", headers: h });
    assert.equal(me.json().id, s.user);
    assert.equal(me.json().group, "user");
    assert.equal(me.headers["x-csrf-token"], undefined);
    const head = await s.app.inject({ method: "HEAD", url: "/api/docs", headers: h });
    assert.equal(head.statusCode, 200);
    readCors(head, "HEAD");
  } finally {
    await s.cleanup();
  }
});

test("admin 주인: 토큰의 group 은 user — admin 경로(GET /api/proposals)는 403 forbidden", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.A)).json();
    const h = s.bearer(token);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/proposals", headers: s.A })).statusCode, 200);
    const res = await s.app.inject({ method: "GET", url: "/api/proposals", headers: h });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, "forbidden");
    readCors(res, "403 forbidden");
    const me = (await s.app.inject({ method: "GET", url: "/api/me", headers: h })).json();
    assert.deepEqual([me.id, me.group], [s.admin, "user"]);
  } finally {
    await s.cleanup();
  }
});

test("메서드: GET · HEAD 만 — POST · PUT · DELETE 는 403 read_only_token, CORS 헤더 없음", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.A)).json();
    const h = s.bearer(token);
    for (const [method, url, payload] of [
      ["POST", "/api/docs/voc", voc("from-token")],
      ["PUT", "/api/docs/voc/line-alarm", { name: "line-alarm", markdown: "# x\n" }],
      ["DELETE", "/api/docs/voc/line-alarm", undefined],
    ]) {
      const res = await s.app.inject({ method, url, headers: { ...h, "if-match": "x" }, payload });
      assert.equal(res.statusCode, 403, `${method} ${url}`);
      assert.deepEqual(res.json(), { error: "read_only_token" });
      noCors(res, `${method} ${url}`);
    }
    assert.equal((await s.app.inject({ method: "GET", url: "/api/docs/voc/from-token", headers: s.A })).statusCode, 404);
  } finally {
    await s.cleanup();
  }
});

test("틀린 토큰: 없음 · 틀림 · 꼴이 틀림 → 401 {error: unauthorized, reason: read_token_invalid} + CORS; 실패가 쌓이면 429 + CORS", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const wrong = `akgr_${"A".repeat(43)}`;
    for (const t of [wrong, "akgr_short", `${token}x`, "akgr_"]) {
      const res = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(t) });
      assert.equal(res.statusCode, 401, t);
      assert.deepEqual(res.json(), { error: "unauthorized", reason: "read_token_invalid" });
      readCors(res, `401 ${t}`);
    }
    // recordAuthFailure: 4 번 실패했다. 20 번이 되면 429.
    for (let i = 0; i < 16; i++) await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(wrong) });
    const limited = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(token) });
    assert.equal(limited.statusCode, 429);
    readCors(limited, "429");
  } finally {
    await s.cleanup();
  }
});

test("만료: expiresAt 이 지난 토큰은 401 read_token_invalid", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const r = await redis();
    await r.hSet(tokenKey(token), "expiresAt", String(Date.now() - 1));
    const res = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(token) });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, "read_token_invalid");
    // 목록에도 없다.
    assert.deepEqual((await s.app.inject({ method: "GET", url: "/api/read-tokens", headers: s.U })).json().tokens, []);
    // 목록이 색인에서 뺀 키: 키의 PEXPIREAT 는 고치기 전 expiresAt 이라 여기서 지운다.
    await r.del(tokenKey(token));
  } finally {
    await s.cleanup();
  }
});

test("폐기: DELETE /api/read-tokens/:id → 204, 그 뒤 토큰은 401; 남의 토큰 · 없는 id 는 404", async () => {
  const s = await setup();
  try {
    const mine = (await s.issue(s.U)).json();
    const theirs = (await s.issue(s.A)).json();
    // 남의 토큰은 404, 그 토큰은 살아 있다.
    const other = await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${theirs.id}`, headers: s.U });
    assert.equal(other.statusCode, 404);
    assert.equal((await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(theirs.token) })).statusCode, 200);
    for (const id of ["000000000000", "nope"]) {
      assert.equal((await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${id}`, headers: s.U })).statusCode, 404, id);
    }

    assert.equal((await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(mine.token) })).statusCode, 200);
    const del = await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${mine.id}`, headers: s.U });
    assert.equal(del.statusCode, 204);
    noCors(del, "DELETE");
    const res = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(mine.token) });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, "read_token_invalid");
    assert.equal((await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${mine.id}`, headers: s.U })).statusCode, 404);
    assert.equal(await (await redis()).exists(tokenKey(mine.token)), 0);
  } finally {
    await s.cleanup();
  }
});

test("lastUsedAt: 첫 사용에 쓰고, 1 시간 안에는 다시 쓰지 않고, 1 시간이 지나면 다시 쓴다", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const r = await redis();
    const read = () => s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(token) });
    assert.equal(await r.hGet(tokenKey(token), "lastUsedAt"), null);
    await read();
    const first = Number(await r.hGet(tokenKey(token), "lastUsedAt"));
    assert.ok(Math.abs(Date.now() - first) < 5000);

    const recent = Date.now() - LAST_USED_WINDOW_MS + 60_000; // 59 분 전
    await r.hSet(tokenKey(token), "lastUsedAt", String(recent));
    await read();
    await read();
    assert.equal(Number(await r.hGet(tokenKey(token), "lastUsedAt")), recent);

    const old = Date.now() - LAST_USED_WINDOW_MS - 1000; // 1 시간 1 초 전
    await r.hSet(tokenKey(token), "lastUsedAt", String(old));
    await read();
    assert.ok(Number(await r.hGet(tokenKey(token), "lastUsedAt")) > old + 1000);

    const list = (await s.app.inject({ method: "GET", url: "/api/read-tokens", headers: s.U })).json();
    assert.equal(Date.parse(list.tokens[0].lastUsedAt), Number(await r.hGet(tokenKey(token), "lastUsedAt")));
  } finally {
    await s.cleanup();
  }
});

// ---------- 토큰 관리 경로 ----------

test("목록: GET /api/read-tokens → {tokens: [{id, label, createdAt, expiresAt, lastUsedAt}], limit: 5}, 자기 것만, 최근 발급 순, 원문 없음", async () => {
  const s = await setup();
  try {
    const first = (await s.issue(s.U, { label: "첫째" })).json();
    await new Promise((r) => setTimeout(r, 5));
    const second = (await s.issue(s.U, { label: "둘째" })).json();
    await s.issue(s.A, { label: "admin 것" });
    const res = await s.app.inject({ method: "GET", url: "/api/read-tokens", headers: s.U });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.limit, 5);
    assert.deepEqual(
      body.tokens.map((t) => [t.id, t.label]),
      [
        [second.id, "둘째"],
        [first.id, "첫째"],
      ],
    );
    for (const t of body.tokens) assert.deepEqual(Object.keys(t).sort(), ["createdAt", "expiresAt", "id", "label", "lastUsedAt"]);
    assert.equal(body.tokens[1].createdAt, first.createdAt);
    assert.equal(body.tokens[1].expiresAt, first.expiresAt);
    assert.equal(body.tokens[1].lastUsedAt, null);
    assert.ok(!res.body.includes(first.token) && !res.body.includes(second.token));
  } finally {
    await s.cleanup();
  }
});

test("관리 경로는 세션만: 읽기 토큰 · agent Bearer 로 부르면 403 session_only", async () => {
  const s = await setup();
  try {
    const { id, token } = (await s.issue(s.U)).json();
    for (const headers of [s.bearer(token), s.BOT]) {
      for (const [method, url, payload] of [
        ["GET", "/api/read-tokens", undefined],
        ["POST", "/api/read-tokens", { label: "x" }],
        ["DELETE", `/api/read-tokens/${id}`, undefined],
      ]) {
        const res = await s.app.inject({ method, url, headers, payload });
        assert.equal(res.statusCode, 403, `${method} ${url} ${headers.authorization}`);
        assert.deepEqual(res.json(), { error: "session_only" });
      }
    }
    // 세션 없음: 401(로그인 주소).
    const anon = await s.app.inject({ method: "GET", url: "/api/read-tokens" });
    assert.equal(anon.statusCode, 401);
    assert.ok(anon.json().login);
  } finally {
    await s.cleanup();
  }
});

test("CSRF: 세션의 POST · DELETE 는 x-csrf-token 이 없거나 틀리면 403 invalid_csrf", async () => {
  const s = await setup();
  try {
    const { id } = (await s.issue(s.U)).json();
    const noToken = { cookie: s.U.cookie };
    const wrongToken = { cookie: s.U.cookie, "x-csrf-token": "nope" };
    for (const headers of [noToken, wrongToken]) {
      const post = await s.app.inject({ method: "POST", url: "/api/read-tokens", headers, payload: { label: "x" } });
      assert.equal(post.statusCode, 403);
      assert.equal(post.json().error, "invalid_csrf");
      const del = await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${id}`, headers });
      assert.equal(del.statusCode, 403);
      assert.equal(del.json().error, "invalid_csrf");
    }
    // GET 은 CSRF 없이 된다.
    assert.equal((await s.app.inject({ method: "GET", url: "/api/read-tokens", headers: noToken })).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

// ---------- CORS ----------

test("CORS: /api 의 GET · HEAD 응답 전부(200 · 304 · 401 · 404)에 Allow-Origin * · Expose-Headers ETag, Allow-Credentials 는 없음", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const h = { ...s.bearer(token), origin: "null" };
    const doc = await s.app.inject({ method: "GET", url: "/api/docs/voc/line-alarm?format=md", headers: h });
    assert.equal(doc.statusCode, 200);
    readCors(doc, "200");
    const etag = doc.headers.etag;
    assert.ok(etag, "본문 응답에 ETag");
    const again = await s.app.inject({ method: "GET", url: "/api/docs/voc/line-alarm?format=md", headers: { ...h, "if-none-match": etag } });
    assert.equal(again.statusCode, 304);
    readCors(again, "304");
    readCors(await s.app.inject({ method: "GET", url: "/api/docs/voc/none", headers: h }), "404 문서");
    readCors(await s.app.inject({ method: "GET", url: "/api/no-such-route", headers: h }), "404 경로");
    readCors(await s.app.inject({ method: "GET", url: "/api/types" }), "401 쿠키 없음");
    // 쿠키 세션의 GET 도 같은 헤더 — Allow-Credentials 가 없어 브라우저는 교차 출처에서 이 응답을 읽지 못한다.
    readCors(await s.app.inject({ method: "GET", url: "/api/types", headers: { ...s.U, origin: "http://localhost:5173" } }), "200 세션");
    // /api 밖(화면 파일)에는 없다.
    noCors(await s.app.inject({ method: "GET", url: "/" }), "/");
  } finally {
    await s.cleanup();
  }
});

test("CORS: 쓰기 응답(201 · 204 · 400 · 403 · 409)에는 CORS 헤더가 없다", async () => {
  const s = await setup();
  try {
    const created = await s.issue(s.U);
    assert.equal(created.statusCode, 201);
    noCors(created, "201");
    noCors(await s.issue(s.U, { label: "" }), "400");
    noCors(await s.app.inject({ method: "POST", url: "/api/read-tokens", headers: { cookie: s.U.cookie }, payload: { label: "x" } }), "403 csrf");
    for (let i = 0; i < 4; i++) await s.issue(s.U);
    noCors(await s.issue(s.U), "409");
    noCors(await s.app.inject({ method: "DELETE", url: `/api/read-tokens/${created.json().id}`, headers: s.U }), "204");
  } finally {
    await s.cleanup();
  }
});

test("프리플라이트: OPTIONS /api/* 는 공개 — GET · HEAD 면 204 + 허용 헤더, 그 밖의 메서드면 CORS 헤더 없이 204", async () => {
  const s = await setup();
  try {
    for (const origin of ["null", "http://localhost:5173", "http://localhost:4173"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await s.app.inject({
          method: "OPTIONS",
          url: "/api/docs/voc/line-alarm?format=md",
          headers: { origin, "access-control-request-method": method, "access-control-request-headers": "authorization" },
        });
        assert.equal(res.statusCode, 204, `${origin} ${method}`);
        assert.equal(res.headers["access-control-allow-origin"], "*");
        assert.equal(res.headers["access-control-allow-methods"], "GET, HEAD");
        assert.equal(res.headers["access-control-allow-headers"], "Authorization, If-None-Match");
        assert.equal(res.headers["access-control-max-age"], "600");
        assert.equal(res.headers["access-control-allow-credentials"], undefined);
        assert.equal(res.body, "");
      }
    }
    for (const method of ["POST", "PUT", "DELETE", undefined]) {
      const res = await s.app.inject({
        method: "OPTIONS",
        url: "/api/docs/voc",
        headers: { origin: "null", ...(method ? { "access-control-request-method": method } : {}) },
      });
      assert.equal(res.statusCode, 204, String(method));
      noCors(res, `OPTIONS ${method}`);
      assert.equal(res.headers["access-control-allow-headers"], undefined);
      assert.equal(res.headers["access-control-max-age"], undefined);
    }
  } finally {
    await s.cleanup();
  }
});

test("gzip 과 함께: 토큰으로 받은 큰 목록은 gzip · Vary accept-encoding 에 CORS 헤더가 같이 실린다", async () => {
  const s = await setup();
  try {
    const { token } = (await s.issue(s.U)).json();
    const res = await s.app.inject({
      method: "GET",
      url: "/api/docs?fields=body",
      headers: { ...s.bearer(token), "accept-encoding": "gzip" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-encoding"], "gzip");
    assert.equal(res.headers.vary, "accept-encoding");
    readCors(res, "gzip");
    assert.ok(Array.isArray(JSON.parse(gunzipSync(res.rawPayload).toString("utf8")).docs));
  } finally {
    await s.cleanup();
  }
});

// ---------- 두 가지 서버 ----------

test("Keycloak 서버에서도: 쿠키 세션으로 발급하고 토큰으로 읽는다", async () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}/realms/fdc-voc-agent`;
    res.setHeader("content-type", "application/json");
    if (req.url === "/realms/fdc-voc-agent/.well-known/openid-configuration")
      return res.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/protocol/openid-connect/certs` }));
    if (req.url === "/realms/fdc-voc-agent/protocol/openid-connect/certs")
      return res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const s = await setup({ keycloakIssuer: `http://127.0.0.1:${server.address().port}/realms/fdc-voc-agent` });
  try {
    const issued = await s.issue(s.U);
    assert.equal(issued.statusCode, 201);
    const res = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer(issued.json().token) });
    assert.equal(res.statusCode, 200);
    readCors(res, "keycloak");
    // akgr_ 로 시작하지 않는 Bearer 는 여전히 Keycloak 토큰으로 본다.
    const jwtish = await s.app.inject({ method: "GET", url: "/api/types", headers: s.bearer("not-a-jwt") });
    assert.equal(jwtish.statusCode, 401);
    assert.deepEqual(jwtish.json(), { error: "unauthorized" });
  } finally {
    await s.cleanup();
    await new Promise((r) => server.close(r));
  }
});

