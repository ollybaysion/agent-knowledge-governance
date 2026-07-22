// Render/migrate round-trip tests using hand-authored inline fixtures. The one
// file fixture is test/fixtures/foundry-golden-SKILL.md — a checked-in copy of
// agent-skill-foundry's golden output, which is what pins the cross-repo
// byte-equality contract for domain-skill (json-spec §4.4). These fixtures are small and synthetic on purpose (see
// examples/ for realistic sample docs, which exist for dashboard preview,
// not test assertions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas, validateDocument } from "../src/envelope.mjs";
import { renderDbSchemaMd } from "../src/render/db-schema.mjs";
import { migrateDbSchemaMd } from "../src/migrate/db-schema.mjs";
import { renderMsgFormatMd } from "../src/render/msg-format.mjs";
import { migrateMsgFormatMd } from "../src/migrate/msg-format.mjs";
import {
  renderDomainSkillMd,
  synthesizeDescription,
} from "../src/render/domain-skill.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "schemas"));

test("db-schema: render(migrate(md)) differs from md only in the h1 owner split, and the migrated doc is schema-valid", () => {
  const md = `# T.X

<!-- dbdoc:manual:purpose -->
테스트 목적 [근거: design.md:1]
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| A | NUMBER | N | - | PK 컬럼 |
| B | VARCHAR2(10) | Y | 'x' | 추정) B 설명 [근거: a.ts:1] |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: A
- 인덱스: IX_X_B(B)
- 관계: B → Y.B
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
단건 조회: SELECT * FROM T.X WHERE A = :a [근거: q:1]
<!-- dbdoc:end:queries -->
`;
  const { doc, warnings } = migrateDbSchemaMd(md, {
    fetchedAt: "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(validateDocument(doc, refs), []);
  // id = lower(table); the H1's owner survives only as a body attribute, and
  // the owner-qualified keyword is gone with it.
  assert.equal(doc.id, "x");
  assert.deepEqual(doc.keywords, [{ kw: "x", inject: "full" }]);
  // render emits `# TABLE` + `owner: OWNER` where the legacy md had
  // `# OWNER.TABLE` — everything below the h1 stays byte-identical.
  assert.equal(renderDbSchemaMd(doc), md.replace("# T.X\n", "# X\nowner: T\n"));
});

test("db-schema: a scaffold column desc with no 추정)/[근거: marker migrates to catalog.columns[].comment, not a tiered value", () => {
  const md = `# T.X

<!-- dbdoc:manual:purpose -->
{{설명}}
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| A | NUMBER | N | - | 원시 오라클 코멘트 |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: A
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}
<!-- dbdoc:end:queries -->
`;
  const { doc, warnings } = migrateDbSchemaMd(md);
  assert.deepEqual(warnings, []);
  assert.equal(doc.body.catalog.columns[0].comment, "원시 오라클 코멘트");
  assert.deepEqual(doc.body.columnDescs.A, { text: null, tier: "scaffold" });
  // legacy `# OWNER.TABLE` h1 renders back as `# TABLE` + `owner: OWNER`
  assert.equal(renderDbSchemaMd(doc), md.replace("# T.X\n", "# X\nowner: T\n"));
});

test("db-schema migrate: reports the deprecated 마이그레이션 주의 section instead of dropping it silently", () => {
  const md = `# T.X

<!-- dbdoc:manual:purpose -->
{{설명}}
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| A | NUMBER | N | - | {{설명}} |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: A
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}
<!-- dbdoc:end:queries -->

## 마이그레이션 주의

<!-- dbdoc:manual:migration -->
{{선택 — 변경 이력, 함부로 바꾸면 안 되는 컬럼과 이유}}
<!-- dbdoc:end:migration -->
`;
  const { warnings } = migrateDbSchemaMd(md);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /마이그레이션 주의/);
});

test("msg-format: render(migrate(md)) === md, and the migrated doc is schema-valid", () => {
  const md = `# CMD_START_LOT

Host → Equipment. 로트 시작을 지시한다 [근거: spec:1]

| # | 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| 1 | LOT_ID | string | ✓ | 로트 ID [근거: spec:2] |
| 2 | RECIPE | string | - | {{설명}} |

## 예시 페이로드

**정상 요청**

\`\`\`
LOT_ID=L001
RECIPE=R1
\`\`\`
`;
  const doc = migrateMsgFormatMd(md);
  assert.deepEqual(validateDocument(doc, refs), []);
  assert.equal(doc.id, "cmd-start-lot");
  assert.equal(renderMsgFormatMd(doc), md);
});

test("msg-format: render(migrate(md)) === md with no examples section", () => {
  const md = `# CMD_PING

Equipment → Host. 생존 확인 [근거: spec:9]

| # | 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| 1 | TS | string | ✓ | {{설명}} |
`;
  const doc = migrateMsgFormatMd(md);
  assert.deepEqual(validateDocument(doc, refs), []);
  assert.equal(renderMsgFormatMd(doc), md);
});

test("domain-skill: render(spec v2) matches the expected SKILL.md byte-for-byte", () => {
  const doc = {
    schema: "domain-skill/v1",
    id: "fdc-x",
    keywords: [{ kw: "fdc-x", inject: "full" }],
    status: "active",
    body: {
      name: "fdc-x",
      argumentHint: "{id}",
      scope: { 단위: "센서", 카디널리티: "단일", 의도: "상태" },
      focus: "현재 상태",
      intro: "이 스킬은 예시용이다.",
      inputs: [{ name: "id", required: true, description: "조회 키" }],
      dependencies: [{ mcp: "agent-db-plugin", tools: ["run_query"] }],
      steps: [
        {
          title: "조회",
          produces: "현재 상태",
          lead: "먼저 조회한다",
          sql: "SELECT * FROM T WHERE ID = :id",
          branches: [{ when: "rows = 0", then: "종료한다" }],
          notes: "결과 없으면 중단",
        },
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
  assert.deepEqual(validateDocument(doc, refs), []);

  const expected =
    '---\nname: fdc-x\nargument-hint: "{id}"\ndisable-model-invocation: true\ndescription: >-\n  특정 센서의 현재 상태를 묻는 상황에서 호출한다 (id 필요).\n---' +
    "\n\n" +
    "# fdc-x" +
    "\n\n" +
    "입력 `{id}`를 받아 아래 **조회 절차**를 순서대로 실행하고,\n" +
    "얻은 값을 **출력 형식**대로 자연어로 답한다." +
    "\n\n" +
    "이 스킬은 예시용이다." +
    "\n\n" +
    "## 입력 파라미터" +
    "\n\n" +
    "- **id** (필수) — 조회 키" +
    "\n\n" +
    "## 의존성" +
    "\n\n" +
    "- **agent-db-plugin** (run_query)" +
    "\n\n" +
    "실행 전 `list_connections`로 확인하고, 없으면 무엇이 없는지 밝히고 멈춘다." +
    "\n\n" +
    "## 조회 절차" +
    "\n\n" +
    "### 조회" +
    "\n\n" +
    "먼저 조회한다" +
    "\n\n" +
    "```sql\nSELECT * FROM T WHERE ID = :id\n```" +
    "\n\n" +
    "- 만약 rows = 0 → 종료한다" +
    "\n\n" +
    "결과 없으면 중단" +
    "\n\n" +
    "## 출력 형식" +
    "\n\n" +
    "조회한 데이터로 센서의 현재 상태를 설명한다. 정해진 형식은 없다.\n" +
    "체계적·논리적으로, 없는 정보는 지어내지 않는다." +
    "\n\n" +
    "**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): 현재 상태" +
    "\n\n" +
    "**하지 말 것**" +
    "\n\n" +
    "- 없는 사유를 추측한다 — 사유 컬럼은 데이터에 없다\n" +
    "- 측정값을 지어낸다 — 이 스킬 범위 밖이다\n" +
    "- 코드를 구체화한다 — 라벨 이상은 모른다" +
    "\n\n" +
    "**예시** (모양만 참고, 값은 조회 결과로 바꾼다)" +
    "\n\n" +
    "> **질문**: 전체 설명\n> **답**: 넓은 답이다." +
    "\n\n" +
    "> **질문**: 좁은 질문\n> **답**: 좁은 답이다." +
    "\n\n" +
    "## 규율" +
    "\n\n" +
    "- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을\n" +
    "  식별자로 넣지 않는다.\n" +
    "- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다 —\n" +
    "  모르는 값을 아는 척하지 않는다 (코드표는 표준 db-schema 문서에서 주입).\n" +
    "- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고\n" +
    "  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람)." +
    "\n";

  assert.equal(renderDomainSkillMd(doc), expected);
});

// The whole point of this port is that both sides stamp the same file. The
// example body IS the foundry golden spec, so this pins the cross-repo
// contract against a checked-in copy of foundry's own golden output.
test("domain-skill: the example renders byte-identically to the foundry golden", () => {
  const doc = JSON.parse(
    readFileSync(
      join(__dirname, "..", "examples", "domain-skill", "fdc-explain-sensor.json"),
      "utf8",
    ),
  );
  assert.deepEqual(validateDocument(doc, refs), []);
  const expected = readFileSync(
    join(__dirname, "fixtures", "foundry-golden-SKILL.md"),
    "utf8",
  );
  assert.equal(renderDomainSkillMd(doc), expected);
});

test("domain-skill: 생성 이력 uses its own description skeleton and particle", () => {
  const body = {
    name: "fdc-trace",
    argumentHint: "{eqp} {pidx}",
    scope: { 단위: "센서", 카디널리티: "단일", 의도: "생성 이력" },
    focus: "센서 측정값",
    intro: "예시용.",
    inputs: [
      { name: "eqp", required: true, description: "설비" },
      { name: "pidx", required: true, description: "인덱스" },
    ],
    dependencies: [{ mcp: "agent-db-plugin" }],
    steps: [{ title: "조회", produces: "측정 분포", sql: "SELECT 1" }],
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
  };
  assert.equal(
    synthesizeDescription(body),
    "특정 센서 측정값이 어떻게 만들어졌는지 묻는 상황에서 호출한다 (eqp·pidx 필요).",
  );
});
