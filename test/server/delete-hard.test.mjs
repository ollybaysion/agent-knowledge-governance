// DELETE = 완전 삭제(사용자 결정 2026-07-24: 보관 단계 없이 바로). 문서가
// store 트리(HEAD)에서 사라져 목록·API 에서 완전히 없어지고, git 이력은
// 감사 기록으로 남는다. 순회 형태 파라미터는 경로 조립 전에 거부한다(S11).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-del-"));
  saveUsers(join(home, "users.json"), [
    { id: "ed", role: "editor", tokenHash: hashToken("edtok") },
    { id: "ap", role: "approver", tokenHash: hashToken("aptok") },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, usersPath: join(home, "users.json") });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const auth = (t) => ({ authorization: `Bearer ${t}` });

function doc(id = "fdc_sensor") {
  return {
    schema: "db-schema/v1",
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "inactive",
    body: { table: id.toUpperCase() },
  };
}
// A complete db-schema — needed to activate (full schema), so it lands in the
// compiled index and the recompile-on-delete is actually exercised.
function completeDoc(id) {
  return {
    schema: "db-schema/v1",
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "inactive",
    body: {
      table: id.toUpperCase(),
      catalog: {
        columns: [{ name: "A_ID", type: "NUMBER", nullable: false }],
        primaryKey: ["A_ID"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A_ID: { text: null, tier: "scaffold" } },
    },
  };
}
const create = (app, id) =>
  app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: doc(id),
  });

test("DELETE removes a doc from HEAD but keeps its git history", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    assert.equal((await create(app, "fdc_sensor")).statusCode, 201);
    const jsonPath = join(storeDir, "db-schema", "fdc_sensor.json");
    assert.ok(existsSync(jsonPath));

    const del = await app.inject({
      method: "DELETE",
      url: "/api/docs/db-schema/fdc_sensor",
      headers: auth("aptok"),
    });
    assert.equal(del.statusCode, 200);
    assert.ok(!existsSync(jsonPath), "file gone from the tree");

    // 목록·단건 API 에서 완전히 사라진다.
    const single = await app.inject({
      method: "GET",
      url: "/api/docs/db-schema/fdc_sensor",
      headers: auth("aptok"),
    });
    assert.equal(single.statusCode, 404);
    const list = await app.inject({
      method: "GET",
      url: "/api/docs?type=db-schema",
      headers: auth("aptok"),
    });
    assert.ok(!JSON.parse(list.body).docs.some((d) => d.id === "fdc_sensor"));

    // 감사용 git 이력은 남는다 — delete 커밋이 파일 삭제를 기록한다.
    const log = execFileSync(
      "git",
      ["-C", storeDir, "log", "--format=%s", "--", "db-schema/fdc_sensor.json"],
      { encoding: "utf8" },
    );
    assert.match(log, /delete db-schema\/fdc_sensor/);
  } finally {
    await cleanup();
  }
});

test("DELETE is approver-only (editor 403) and 404s on unknown doc", async () => {
  const { app, cleanup } = await setup();
  try {
    assert.equal((await create(app, "fdc_sensor")).statusCode, 201);
    const ed = await app.inject({
      method: "DELETE",
      url: "/api/docs/db-schema/fdc_sensor",
      headers: auth("edtok"),
    });
    assert.equal(ed.statusCode, 403);
    const gone = await app.inject({
      method: "DELETE",
      url: "/api/docs/db-schema/nope",
      headers: auth("aptok"),
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("DELETE rejects traversal-shaped params before touching paths (S11)", async () => {
  const { app, cleanup } = await setup();
  try {
    // %2F 디코드로 다단 세그먼트가 파라미터에 들어오는 §13-1 부류 — 전역
    // invalid_path_param 가드(400)가 먼저 끊는다. 라우트 안 isValidId 는
    // 그 층이 사라져도 버티는 심층 방어.
    for (const url of [
      "/api/docs/proposals/pending%2Fx",
      "/api/docs/db-schema/..%2Findex",
    ]) {
      const r = await app.inject({ method: "DELETE", url, headers: auth("aptok") });
      assert.equal(r.statusCode, 400, url);
      assert.equal(JSON.parse(r.body).error, "invalid_path_param", url);
    }
  } finally {
    await cleanup();
  }
});

test("deleting an indexed doc recompiles the index without it", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const c = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: completeDoc("fdc_a"),
    });
    assert.equal(c.statusCode, 201);
    // fdc_a 를 활성화해 인덱스에 실린 뒤 삭제 — 재컴파일이 확실히 돌게.
    // 전이는 If-Match 필수(428) 이므로 create 가 준 rev 를 싣는다.
    const act = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/fdc_a/activate",
      headers: { ...auth("aptok"), "if-match": c.json().rev },
    });
    assert.equal(act.statusCode, 200, act.payload);
    const del = await app.inject({
      method: "DELETE",
      url: "/api/docs/db-schema/fdc_a",
      headers: auth("aptok"),
    });
    assert.equal(del.statusCode, 200);
    const idx = JSON.parse(
      execFileSync(
        "git",
        ["-C", storeDir, "show", "HEAD:rendered/db-schema/index.json"],
        { encoding: "utf8" },
      ),
    );
    assert.ok(!idx.some((e) => e.path.includes("fdc_a")));
  } finally {
    await cleanup();
  }
});
