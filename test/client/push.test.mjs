// akg CLI `push` (issue #18) — src/client/push.mjs against a REAL in-process
// server (Phase 1's buildApp(), app.inject — no network). The domain-skill
// cases are the point of the command: agent-skill-foundry emits spec.json and
// this is how it reaches the hub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import {
  buildDocument,
  isEnvelope,
  push,
  validateForPush,
} from "../../src/client/push.mjs";
import { AkgApiError } from "../../src/client/errors.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXAMPLE = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "examples", "domain-skill", "fdc-explain-sensor.json"),
    "utf8",
  ),
);
/** The example's body IS agent-skill-foundry's golden spec.json. */
const GOLDEN_SPEC = EXAMPLE.body;

async function setupServer() {
  const home = mkdtempSync(join(tmpdir(), "akg-push-server-"));
  saveUsers(join(home, "users.json"), [
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

function fetchImplFromApp(app, calls = []) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method ?? "GET"} ${u.pathname}`);
    const res = await app.inject({
      method: opts.method ?? "GET",
      url: u.pathname + u.search,
      headers: opts.headers,
      payload: opts.body,
    });
    return {
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] },
      json: async () => res.json(),
    };
  };
}

const pushTo = (app, doc, calls) =>
  push({
    serverUrl: "http://x",
    token: "ed-tok",
    type: "domain-skill",
    doc,
    fetchImpl: fetchImplFromApp(app, calls),
  });

// ---------------------------------------------------------------- envelope

test("buildDocument: a bare foundry spec.json gets its envelope derived", () => {
  const { doc, derived } = buildDocument("domain-skill", GOLDEN_SPEC);
  assert.equal(derived, true);
  assert.equal(doc.schema, "domain-skill/v1");
  assert.equal(doc.id, "fdc-explain-sensor"); // == body.name
  assert.deepEqual(doc.keywords, [
    { kw: "fdc-explain-sensor", inject: "full" },
  ]);
  assert.equal(doc.status, "active");
  assert.deepEqual(doc.body, GOLDEN_SPEC);
  assert.deepEqual(validateForPush(doc), []);
});

test("buildDocument: the derived envelope equals the checked-in example", () => {
  const { doc } = buildDocument("domain-skill", GOLDEN_SPEC);
  assert.deepEqual(doc, EXAMPLE);
});

test("buildDocument: a full envelope passes through untouched", () => {
  const { doc, derived } = buildDocument("domain-skill", EXAMPLE);
  assert.equal(derived, false);
  assert.deepEqual(doc, EXAMPLE);
});

test("buildDocument: flags override what the file carried", () => {
  const { doc } = buildDocument("domain-skill", EXAMPLE, {
    keywords: [{ kw: "sensor", inject: "pointer" }],
    status: "inactive",
  });
  assert.deepEqual(doc.keywords, [{ kw: "sensor", inject: "pointer" }]);
  assert.equal(doc.status, "inactive");
});

test("buildDocument: envelope whose schema contradicts the type is refused", () => {
  assert.throws(
    () => buildDocument("db-schema", EXAMPLE),
    /schema 가 "domain-skill\/v1" 인데 type 은 "db-schema"/,
  );
});

test("buildDocument: a body with no derivable id names the missing field", () => {
  const { name, ...noName } = GOLDEN_SPEC;
  assert.throws(
    () => buildDocument("domain-skill", noName),
    /`name` 이 필요합니다/,
  );
});

test("buildDocument: id derivation per type (db-schema qualified/unqualified, msg-format)", () => {
  assert.equal(
    buildDocument("db-schema", { owner: "T", table: "SENSOR" }).doc.id,
    "t.sensor",
  );
  assert.equal(
    buildDocument("db-schema", { table: "SENSOR" }).doc.id,
    "sensor",
  );
  assert.equal(
    buildDocument("msg-format", { command: "SET_TEMP" }).doc.id,
    "set-temp",
  );
});

test("isEnvelope: only schema+body together make an envelope", () => {
  assert.equal(isEnvelope(EXAMPLE), true);
  assert.equal(isEnvelope(GOLDEN_SPEC), false);
  assert.equal(isEnvelope({ schema: "domain-skill/v1" }), false);
  assert.equal(isEnvelope(null), false);
});

// -------------------------------------------------------------- validation

test("validateForPush: an unknown key in the body is rejected before any network call", () => {
  const { doc } = buildDocument("domain-skill", {
    ...GOLDEN_SPEC,
    // spec v1's `description` was removed in v2 — an old spec must not pass
    // silently just because the server would have caught it later.
    description: "손으로 쓴 라우팅 문장",
  });
  const errors = validateForPush(doc);
  assert.equal(errors.length > 0, true);
  assert.match(errors.join("\n"), /description/);
});

test("validateForPush: a spec where no step declares produces is rejected", () => {
  const { doc } = buildDocument("domain-skill", {
    ...GOLDEN_SPEC,
    steps: GOLDEN_SPEC.steps.map(({ produces, ...rest }) => rest),
  });
  assert.match(validateForPush(doc).join("\n"), /반드시 포함/);
});

// ------------------------------------------------------------ create/update

test("push: a first push creates the doc and renders it to the skill tree", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const { doc } = buildDocument("domain-skill", GOLDEN_SPEC);
    const calls = [];
    const result = await pushTo(app, doc, calls);

    assert.equal(result.created, true);
    assert.equal(typeof result.rev, "string");
    assert.deepEqual(calls, ["POST /api/docs/domain-skill"]);

    // The whole point of pushing a spec: the hub now serves the SKILL.md, and
    // it is byte-identical to the golden foundry renders locally.
    const md = await app.inject({
      method: "GET",
      url: "/api/docs/domain-skill/fdc-explain-sensor?format=md",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(md.statusCode, 200);
    assert.equal(
      md.body,
      readFileSync(
        join(__dirname, "..", "fixtures", "foundry-golden-SKILL.md"),
        "utf8",
      ),
    );
  } finally {
    await cleanup();
  }
});

test("push: pushing the same spec again updates it instead of failing", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const { doc } = buildDocument("domain-skill", GOLDEN_SPEC);
    const first = await pushTo(app, doc);

    const edited = buildDocument("domain-skill", {
      ...GOLDEN_SPEC,
      focus: "정체·소속 설비·현재 상태와 최근 이벤트",
    }).doc;
    const calls = [];
    const second = await pushTo(app, edited, calls);

    assert.equal(second.created, false);
    assert.notEqual(second.rev, first.rev);
    assert.deepEqual(calls, [
      "POST /api/docs/domain-skill",
      "GET /api/docs/domain-skill/fdc-explain-sensor",
      "PUT /api/docs/domain-skill/fdc-explain-sensor",
    ]);

    const after = await app.inject({
      method: "GET",
      url: "/api/docs/domain-skill/fdc-explain-sensor",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.equal(
      after.json().json.body.focus,
      "정체·소속 설비·현재 상태와 최근 이벤트",
    );
  } finally {
    await cleanup();
  }
});

test("push: an update reports that the envelope it built was not applied", async () => {
  const { app, cleanup } = await setupServer();
  try {
    await pushTo(app, buildDocument("domain-skill", GOLDEN_SPEC).doc);

    // Same body, different envelope — PUT takes the body alone, so the
    // caller has to be told the keyword change did NOT happen.
    const relabelled = buildDocument("domain-skill", GOLDEN_SPEC, {
      keywords: [{ kw: "sensor explain", inject: "pointer" }],
    }).doc;
    const result = await pushTo(app, relabelled);

    assert.equal(result.created, false);
    assert.equal(result.envelopeIgnored, true);

    const after = await app.inject({
      method: "GET",
      url: "/api/docs/domain-skill/fdc-explain-sensor",
      headers: { authorization: "Bearer ed-tok" },
    });
    assert.deepEqual(after.json().json.keywords, [
      { kw: "fdc-explain-sensor", inject: "full" },
    ]);
  } finally {
    await cleanup();
  }
});

test("push: an unchanged re-push is a no-op update, not an envelope warning", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const { doc } = buildDocument("domain-skill", GOLDEN_SPEC);
    await pushTo(app, doc);
    const again = await pushTo(app, doc);
    assert.equal(again.created, false);
    assert.equal(again.envelopeIgnored, false);
  } finally {
    await cleanup();
  }
});

test("push: a server rejection fails CLOSED with the status attached", async () => {
  const { app, cleanup } = await setupServer();
  try {
    const { doc } = buildDocument("domain-skill", GOLDEN_SPEC);
    await assert.rejects(
      () =>
        push({
          serverUrl: "http://x",
          token: "not-a-real-token",
          type: "domain-skill",
          doc,
          fetchImpl: fetchImplFromApp(app),
        }),
      (err) => {
        assert.equal(err instanceof AkgApiError, true);
        assert.equal(err.status, 401);
        return true;
      },
    );
  } finally {
    await cleanup();
  }
});
