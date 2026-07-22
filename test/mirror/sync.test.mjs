// akg CLI `sync` (design §8.1, §9.2 acceptance row 2 "소비 연결(A모드)").
// Uses Phase 1's buildApp() as a real server (app.inject, no network) and
// wraps its /api/bundle response as a fetchImpl — so these tests exercise
// the ACTUAL tar.gz bytes the server produces, not a hand-rolled fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { syncMirror } from "../../src/mirror/sync.mjs";

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-sync-server-"));
  saveUsers(join(home, "users.json"), [
    { id: "viewer1", role: "viewer", tokenHash: hashToken("view-tok") },
    { id: "editor1", role: "editor", tokenHash: hashToken("ed-tok") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  return {
    app,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function dbSchemaDoc(table, owner = "T") {
  const id = table.toLowerCase(); // id = lower(table); owner never qualifies it
  const alias = id.replace(/^t_/, ""); // 짧은 별칭 — 포인터 주입 번들용 키워드
  return {
    schema: "db-schema/v1",
    id,
    keywords: [
      { kw: id, inject: "full" },
      { kw: alias, inject: "pointer" },
    ],
    status: "active",
    body: {
      owner,
      table,
      catalog: {
        columns: [{ name: "A", type: "NUMBER", nullable: false }],
        primaryKey: ["A"],
        fetchedAt: "2026-01-01T00:00:00Z",
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

function domainSkillDoc(name) {
  return {
    schema: "domain-skill/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    body: {
      name,
      argumentHint: "{id}",
      scope: { 단위: "센서", 카디널리티: "단일", 의도: "상태" },
      focus: "현재 상태",
      intro: "테스트 스킬.",
      inputs: [{ name: "id", required: true, description: "조회 키" }],
      dependencies: [{ mcp: "agent-db-plugin" }],
      steps: [
        { title: "1단계", produces: "현재 상태", sql: "SELECT 1 FROM dual" },
      ],
      output: {
        avoid: [
          "없는 사유를 추측한다 — 사유 컬럼은 데이터에 없다",
          "측정값을 지어낸다 — 이 스킬 범위 밖이다",
          "코드를 구체화한다 — 라벨 이상은 모른다",
        ],
        examples: [
          { ask: "전체 설명", answer: "넓은 답이다." },
          { ask: "좁은 질문", answer: "좁은 답이다." },
        ],
      },
    },
  };
}

async function postDoc(app, doc) {
  const type = doc.schema.split("/")[0];
  const res = await app.inject({
    method: "POST",
    url: `/api/docs/${type}`,
    headers: { authorization: "Bearer ed-tok" },
    payload: doc,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

// Wraps app.inject as a fetch-like function so syncMirror's real HTTP-shaped
// code path (status/headers.get/arrayBuffer) runs unmodified against the
// real server, no network involved.
function fetchImplFromApp(app, token) {
  return async (url, init = {}) => {
    const u = new URL(url);
    const res = await app.inject({
      method: "GET",
      url: u.pathname + u.search,
      // With a token the harness supplies the header. With null it forwards
      // whatever syncMirror actually sent — which is how the anonymous path
      // (no Authorization header at all) gets exercised for real.
      headers: token
        ? { authorization: `Bearer ${token}` }
        : (init.headers ?? {}),
    });
    return {
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] },
      arrayBuffer: async () => {
        const buf = res.rawPayload;
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        );
      },
    };
  };
}

function tmpMirrorDir() {
  const home = mkdtempSync(join(tmpdir(), "akg-sync-mirror-"));
  return join(home, "akg"); // mirrorDir itself must NOT pre-exist (first sync case)
}

function siblingEntries(mirrorDir) {
  return readdirSync(dirname(mirrorDir)).filter(
    (n) => n !== basename(mirrorDir),
  );
}

test("0. a tokenless sync works against a server with anonymous read on", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));

  const mirrorDir = tmpMirrorDir();
  const result = await syncMirror({
    serverUrl: "http://test.local",
    token: null, // no ~/.claude/akg/token, no AKG_TOKEN
    mirrorDir,
    fetchImpl: fetchImplFromApp(app, null), // forwards syncMirror's own headers
  });

  assert.equal(result.changed, true);
  assert.ok(
    existsSync(join(mirrorDir, "db-schema", "index.json")),
    "an anonymous pull must produce the same mirror a viewer token would",
  );
  rmSync(mirrorDir, { recursive: true, force: true });
  await cleanup();
});

test("1. first sync (no local rev) produces a mirror matching §5.1's provider contract", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));

  const mirrorDir = tmpMirrorDir();
  const result = await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl: fetchImplFromApp(app, "view-tok"),
  });

  assert.equal(result.changed, true);
  assert.ok(result.rev);

  const index = JSON.parse(
    readFileSync(join(mirrorDir, "db-schema", "index.json"), "utf8"),
  );
  assert.ok(Array.isArray(index));
  // full bundle (precision omitted) + pointer bundle (precision 0.5), §5.1.
  const full = index.find((e) => e.keywords.includes("t_sensor"));
  const pointer = index.find((e) => e.keywords.includes("sensor"));
  assert.equal(full.path, "docs/t_sensor.md");
  assert.equal(full.precision, undefined);
  assert.equal(pointer.path, "docs/t_sensor.md");
  assert.equal(pointer.precision, 0.5);

  // §4 D1 self-containment: path resolves relative to the index's own folder.
  assert.ok(existsSync(join(mirrorDir, "db-schema", full.path)));

  const meta = JSON.parse(readFileSync(join(mirrorDir, "meta.json"), "utf8"));
  assert.equal(meta.rev, result.rev);
  assert.equal(meta.serverUrl, "http://test.local");

  await cleanup();
});

test("2. re-sync at the same rev is a 304 no-op (mirror untouched)", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));

  const mirrorDir = tmpMirrorDir();
  const fetchImpl = fetchImplFromApp(app, "view-tok");
  const first = await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl,
  });

  const docPath = join(mirrorDir, "db-schema", "docs", "t_sensor.md");
  const mtimeBefore = statSync(docPath).mtimeMs;

  const second = await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl,
  });

  assert.equal(second.changed, false);
  assert.equal(second.rev, first.rev);
  assert.equal(statSync(docPath).mtimeMs, mtimeBefore);

  await cleanup();
});

test("3. fail-open — a fetch failure (server down) throws but leaves the existing mirror intact", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));

  const mirrorDir = tmpMirrorDir();
  await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl: fetchImplFromApp(app, "view-tok"),
  });

  const indexPath = join(mirrorDir, "db-schema", "index.json");
  const indexBefore = readFileSync(indexPath, "utf8");
  const mtimeBefore = statSync(indexPath).mtimeMs;

  const throwingFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    syncMirror({
      serverUrl: "http://test.local",
      token: "view-tok",
      mirrorDir,
      fetchImpl: throwingFetch,
    }),
  );

  assert.equal(readFileSync(indexPath, "utf8"), indexBefore);
  assert.equal(statSync(indexPath).mtimeMs, mtimeBefore);
  // no stray .tmp-*/.bak-* directories left beside the mirror
  assert.deepEqual(siblingEntries(mirrorDir), []);

  await cleanup();
});

test("4. a new doc on the server is picked up by the next sync", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));

  const mirrorDir = tmpMirrorDir();
  const fetchImpl = fetchImplFromApp(app, "view-tok");
  await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl,
  });

  await postDoc(app, dbSchemaDoc("T_EQUIPMENT"));

  const second = await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl,
  });
  assert.equal(second.changed, true);

  const index = JSON.parse(
    readFileSync(join(mirrorDir, "db-schema", "index.json"), "utf8"),
  );
  assert.ok(index.some((e) => e.path === "docs/t_equipment.md"));
  assert.ok(
    existsSync(join(mirrorDir, "db-schema", "docs", "t_equipment.md")),
  );

  await cleanup();
});

test("5. zip-slip: a malicious bundle with a path-traversal entry is rejected, nothing written", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "akg-sync-evil-src-"));
  writeFileSync(join(scratch, "evil.txt"), "evil content");
  const evilTarPath = join(scratch, "evil.tar.gz");
  const build = spawnSync("tar", [
    "-czf",
    evilTarPath,
    "-C",
    scratch,
    "--transform",
    "s,^evil.txt,rendered/../../escaped.txt,",
    "evil.txt",
  ]);
  assert.equal(build.status, 0, build.stderr?.toString());
  const evilBuf = readFileSync(evilTarPath);

  const mirrorDir = tmpMirrorDir();
  const evilFetch = async () => ({
    status: 200,
    headers: { get: (name) => (name === "etag" ? "evilrev" : undefined) },
    arrayBuffer: async () =>
      evilBuf.buffer.slice(
        evilBuf.byteOffset,
        evilBuf.byteOffset + evilBuf.byteLength,
      ),
  });

  await assert.rejects(
    syncMirror({
      serverUrl: "http://test.local",
      token: "view-tok",
      mirrorDir,
      fetchImpl: evilFetch,
    }),
    /unsafe tar entry|path traversal/,
  );

  assert.ok(!existsSync(mirrorDir), "mirror was never created");
  assert.ok(
    !existsSync(join(dirname(mirrorDir), "..", "escaped.txt")),
    "no file escaped above the mirror",
  );
  assert.deepEqual(siblingEntries(mirrorDir), []);

  rmSync(scratch, { recursive: true, force: true });
});

test("6. index/docs self-containment: index.json's relative paths resolve inside the SAME type folder", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));
  await postDoc(app, dbSchemaDoc("T_EQUIPMENT"));

  const mirrorDir = tmpMirrorDir();
  await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir,
    fetchImpl: fetchImplFromApp(app, "view-tok"),
  });

  const indexPath = join(mirrorDir, "db-schema", "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.ok(index.length > 0);
  for (const entry of index) {
    // §4 D1 / doc-index.mjs docBaseFor: base = the folder containing the
    // index (its name here is "db-schema", not literally ".claude").
    const resolved = join(dirname(indexPath), entry.path);
    assert.ok(
      existsSync(resolved),
      `${entry.path} must resolve under db-schema/`,
    );
  }

  await cleanup();
});

test("7. --skills off (default) excludes domain-skill/ from the mirror; --skills on installs it", async () => {
  const { app, cleanup } = await setupServer();
  await postDoc(app, dbSchemaDoc("T_SENSOR"));
  await postDoc(app, domainSkillDoc("test-skill"));

  const withoutSkills = tmpMirrorDir();
  await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir: withoutSkills,
    fetchImpl: fetchImplFromApp(app, "view-tok"),
  });
  assert.ok(!existsSync(join(withoutSkills, "domain-skill")));

  const withSkills = tmpMirrorDir();
  await syncMirror({
    serverUrl: "http://test.local",
    token: "view-tok",
    mirrorDir: withSkills,
    skills: true,
    fetchImpl: fetchImplFromApp(app, "view-tok"),
  });
  assert.ok(
    existsSync(join(withSkills, "domain-skill", "test-skill", "SKILL.md")),
  );

  await cleanup();
});
