// A query item's ```chart fence is checked when an agent md (domain-skill,
// domain) is stored active — POST, PUT and activation — with BE's codes
// (src/flow/chart-fence.mjs). A draft waits for its activation; an md type
// is stored as plain text (a manual's step text is one line and holds no fence).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-chart-save-"));
  const signedIn = await signIn(home, [
    { id: "ed", group: "admin", token: "chart-ed" },
  ]);
  const app = await buildApp({ storeDir: join(home, "store"), auth: signedIn });
  const admin = (method, url, payload, headers = {}) =>
    app.inject({
      method,
      url,
      headers: { ...as("chart-ed"), ...headers },
      payload,
    });
  return {
    admin,
    revOf: async (type, id) =>
      (await admin("GET", `/api/docs/${type}/${id}`)).json().rev,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** One query item with a ```chart fence; the fence opens on md line 11. */
const chartMd = (name, chart) =>
  `# ${name}\n\n## 데이터\n\n### trend — 트렌드\n\n\`\`\`sql\nselect ts, value from fdc_trace\n\`\`\`\n\n\`\`\`chart\n${chart}\n\`\`\`\n`;
const BAD = "kind = pie\nx = ts\ny = nope";
const GOOD = "kind = line\nx = ts\ny = value";
const BAD_DETAILS = [
  "$.body.markdown: 그래프 펜스 오류 12 번째 줄 CHART_KIND 모르는 종류 pie — 받는 종류는 line · step · area · bar · stacked-bar · scatter · histogram · heatmap · box",
  "$.body.markdown: 그래프 펜스 오류 14 번째 줄 CHART_COLUMN y 열 nope 이 조회 trend 의 출력 열에 없다 — 출력 열은 TS · VALUE",
];

const skill = (id, markdown, status = "active") => ({
  schema: "domain-skill/v1",
  id,
  keywords: [{ kw: id, inject: "full" }],
  status,
  body: { name: id, markdown },
});

test("POST · PUT: an active skill md with a bad chart fence is 400 validation_failed, one detail per CHART_* error; a sound one is stored", async () => {
  const t = await setup();
  try {
    const bad = await t.admin(
      "POST",
      "/api/docs/domain-skill",
      skill("trend-a", chartMd("trend-a", BAD)),
    );
    assert.equal(bad.statusCode, 400, bad.body);
    assert.equal(bad.json().error, "validation_failed");
    assert.deepEqual(bad.json().details, BAD_DETAILS);
    assert.equal(
      (await t.admin("GET", "/api/docs/domain-skill/trend-a")).statusCode,
      404,
    );

    const good = await t.admin(
      "POST",
      "/api/docs/domain-skill",
      skill("trend-a", chartMd("trend-a", GOOD)),
    );
    assert.equal(good.statusCode, 201, good.body);

    const put = await t.admin(
      "PUT",
      "/api/docs/domain-skill/trend-a",
      { name: "trend-a", markdown: chartMd("trend-a", BAD) },
      { "if-match": good.json().rev },
    );
    assert.equal(put.statusCode, 400, put.body);
    assert.deepEqual(put.json().details, BAD_DETAILS);
  } finally {
    await t.cleanup();
  }
});

test("activation: a draft with a bad chart fence is stored, and its activation — one or many — is refused with the same details", async () => {
  const t = await setup();
  try {
    const draft = await t.admin(
      "POST",
      "/api/docs/domain-skill",
      skill("trend-b", chartMd("trend-b", BAD), "inactive"),
    );
    assert.equal(draft.statusCode, 201, draft.body);

    const one = await t.admin(
      "POST",
      "/api/docs/domain-skill/trend-b/activate",
      null,
      { "if-match": draft.json().rev },
    );
    assert.equal(one.statusCode, 400, one.body);
    assert.deepEqual(one.json().details, BAD_DETAILS);

    const many = await t.admin("POST", "/api/docs/domain-skill/activate", {
      items: [{ id: "trend-b", rev: draft.json().rev }],
    });
    assert.equal(many.statusCode, 200, many.body);
    assert.deepEqual(many.json().results, [
      {
        id: "trend-b",
        status: "error",
        error: "validation_failed",
        details: BAD_DETAILS,
      },
    ]);
  } finally {
    await t.cleanup();
  }
});

test("a domain document is an agent md too (BE reads it as a skill): its bad chart fence is refused", async () => {
  const t = await setup();
  try {
    const md = chartMd("trend-c", BAD).replace(
      "## 데이터",
      "## 도메인 지식\n\n글\n\n## 데이터",
    );
    const r = await t.admin("POST", "/api/docs/domain", {
      ...skill("trend-c", md),
      schema: "domain/v1",
    });
    assert.equal(r.statusCode, 400, r.body);
    assert.deepEqual(
      r.json().details.map((d) => d.split(" — ")[0]),
      [
        "$.body.markdown: 그래프 펜스 오류 16 번째 줄 CHART_KIND 모르는 종류 pie",
        "$.body.markdown: 그래프 펜스 오류 18 번째 줄 CHART_COLUMN y 열 nope 이 조회 trend 의 출력 열에 없다",
      ],
    );
  } finally {
    await t.cleanup();
  }
});

test("an md type is no agent md: a bad chart fence in it is plain text", async () => {
  const t = await setup();
  try {
    const md = await t.admin("POST", "/api/docs/unclassified", {
      schema: "unclassified/v1",
      id: "chart-note",
      keywords: [{ kw: "chart", inject: "pointer" }],
      status: "active",
      body: { name: "chart-note", markdown: chartMd("chart-note", BAD) },
    });
    assert.equal(md.statusCode, 201, md.body);
  } finally {
    await t.cleanup();
  }
});
