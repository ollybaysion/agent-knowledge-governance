// 2단계 삭제의 2단 — POST /api/docs/:type/:id/purge (approver 전용).
// archived 문서만 store 트리에서 제거되고(HEAD 소멸), git 이력은 남는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-purge-"));
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

async function createAndArchive(app, id = "fdc_sensor") {
  const c = await app.inject({
    method: "POST",
    url: "/api/docs/db-schema",
    headers: auth("edtok"),
    payload: doc(id),
  });
  assert.equal(c.statusCode, 201);
  const d = await app.inject({
    method: "DELETE",
    url: `/api/docs/db-schema/${id}`,
    headers: auth("aptok"),
  });
  assert.equal(d.statusCode, 200);
}

test("purge removes an archived doc from HEAD but keeps git history", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    await createAndArchive(app);
    const jsonPath = join(storeDir, "db-schema", "fdc_sensor.json");
    assert.ok(existsSync(jsonPath), "archived tombstone still on disk");

    const r = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/fdc_sensor/purge",
      headers: auth("aptok"),
    });
    assert.equal(r.statusCode, 200);
    assert.ok(!existsSync(jsonPath), "purged file gone from the tree");

    // 목록·단건 API 에서도 완전히 사라진다.
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

    // 감사용 git 이력은 남는다 — purge 커밋이 파일 삭제를 기록한다.
    const log = execFileSync(
      "git",
      ["-C", storeDir, "log", "--format=%s", "--", "db-schema/fdc_sensor.json"],
      { encoding: "utf8" },
    );
    assert.match(log, /purge db-schema\/fdc_sensor/);
    assert.match(log, /archive db-schema\/fdc_sensor/);
  } finally {
    await cleanup();
  }
});

test("purge refuses a non-archived doc (409) — the archive step is the gate", async () => {
  const { app, cleanup } = await setup();
  try {
    const c = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: doc(),
    });
    assert.equal(c.statusCode, 201);
    const r = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/fdc_sensor/purge",
      headers: auth("aptok"),
    });
    assert.equal(r.statusCode, 409);
    assert.equal(JSON.parse(r.body).error, "not_archived");
  } finally {
    await cleanup();
  }
});

test("purge is approver-only (editor 403) and 404s on unknown doc", async () => {
  const { app, cleanup } = await setup();
  try {
    await createAndArchive(app);
    const ed = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/fdc_sensor/purge",
      headers: auth("edtok"),
    });
    assert.equal(ed.statusCode, 403);
    const gone = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/nope/purge",
      headers: auth("aptok"),
    });
    assert.equal(gone.statusCode, 404);
  } finally {
    await cleanup();
  }
});

test("purge rejects traversal-shaped params before touching paths (S11)", async () => {
  const { app, cleanup } = await setup();
  try {
    // %2F 디코드로 다단 세그먼트가 파라미터에 들어오는 §13-1 부류 — 전역
    // invalid_path_param 가드(400)가 먼저 끊고, 라우트 가드는 심층 방어(404).
    for (const url of [
      "/api/docs/proposals/pending%2Fx/purge",
      "/api/docs/db-schema/..%2Findex/purge",
    ]) {
      const r = await app.inject({ method: "POST", url, headers: auth("aptok") });
      assert.equal(r.statusCode, 400, url);
      assert.equal(JSON.parse(r.body).error, "invalid_path_param", url);
    }
    // 대문자 id 도 전역 가드가 거부한다(ID 형식 중앙 검증) — 라우트 안
    // DOC_TYPES/isValidId 검사는 이 층이 사라져도 버티는 심층 방어로 남는다.
    const upper = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/UPPER/purge",
      headers: auth("aptok"),
    });
    assert.equal(upper.statusCode, 400);
    assert.equal(JSON.parse(upper.body).error, "invalid_path_param");
    // 강화된 DELETE 도 동일 (기존 라우트 가드 추가분).
    const d = await app.inject({
      method: "DELETE",
      url: "/api/docs/db-schema/..%2Findex",
      headers: auth("aptok"),
    });
    assert.equal(d.statusCode, 400);
  } finally {
    await cleanup();
  }
});

test("purging an indexed active→archived doc recompiles index without it", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    await createAndArchive(app, "fdc_a");
    // 살아있는 이웃 문서 — purge 후에도 인덱스는 이웃만 담아야 한다.
    const c = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema",
      headers: auth("edtok"),
      payload: doc("fdc_b"),
    });
    assert.equal(c.statusCode, 201);
    const r = await app.inject({
      method: "POST",
      url: "/api/docs/db-schema/fdc_a/purge",
      headers: auth("aptok"),
    });
    assert.equal(r.statusCode, 200);
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
