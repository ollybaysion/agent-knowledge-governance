// Render/migrate round-trip tests using hand-authored inline fixtures — no
// golden/ directory. These fixtures are small and synthetic on purpose (see
// examples/ for realistic sample docs, which exist for dashboard preview,
// not test assertions).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas, validateDocument } from "../src/envelope.mjs";
import { renderDbSchemaMd } from "../src/render/db-schema.mjs";
import { migrateDbSchemaMd } from "../src/migrate/db-schema.mjs";
import { renderMsgFormatMd } from "../src/render/msg-format.mjs";
import { migrateMsgFormatMd } from "../src/migrate/msg-format.mjs";
import { renderDomainSkillMd } from "../src/render/domain-skill.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const refs = loadSchemas(join(__dirname, "..", "schemas"));

test("db-schema: render(migrate(md)) === md, and the migrated doc is schema-valid", () => {
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
  assert.equal(renderDbSchemaMd(doc), md);
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
  assert.equal(renderDbSchemaMd(doc), md);
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

test("domain-skill: render(spec) matches the expected SKILL.md byte-for-byte", () => {
  const doc = {
    schema: "domain-skill/v1",
    id: "fdc-x",
    keywords: [{ kw: "fdc-x", inject: "full" }],
    status: "active",
    body: {
      name: "fdc-x",
      argumentHint: "{id}",
      description: "X를 설명한다.\n대상은 미확정이면 실패한다.",
      intro: "이 스킬은 예시용이다.",
      steps: [
        {
          title: "조회",
          lead: "먼저 조회한다",
          sql: "SELECT * FROM T WHERE ID = :id",
          notes: "결과 없으면 중단",
        },
      ],
      valueRules: [{ target: "ID", rule: "그대로 출력", basis: "scaffold" }],
      output: {
        lead: "아래 형식으로 답한다.",
        template: "ID: {id}",
        exampleLabel: "예시:",
        example: "ID: X-1",
      },
    },
  };
  assert.deepEqual(validateDocument(doc, refs), []);

  const expected =
    '---\nname: fdc-x\nargument-hint: "{id}"\ndisable-model-invocation: true\ndescription: >-\n  X를 설명한다.\n  대상은 미확정이면 실패한다.\n---' +
    "\n\n" +
    "# fdc-x" +
    "\n\n" +
    "주어진 인자를 받아, 아래 **조회 절차를 순서대로** 실행하고 얻은 값들을\n" +
    "**출력 형식**대로 자연어로 바꿔 답한다. 모든 조회는 지정된 read-only MCP로\n" +
    "하고, 값은 항상 바인드로 넘긴다.\n\n이 스킬은 예시용이다." +
    "\n\n" +
    "## 조회 절차" +
    "\n\n" +
    "### 조회" +
    "\n\n" +
    "먼저 조회한다" +
    "\n\n" +
    "```sql\nSELECT * FROM T WHERE ID = :id\n```" +
    "\n\n" +
    "결과 없으면 중단" +
    "\n\n" +
    "## 값 해석 규칙" +
    "\n\n" +
    "| 대상 | 규칙 | 근거 |\n| --- | --- | --- |\n| ID | 그대로 출력 | scaffold |" +
    "\n\n" +
    "## 출력 형식" +
    "\n\n" +
    "아래 형식으로 답한다." +
    "\n\n" +
    "ID: {id}" +
    "\n\n" +
    "예시:" +
    "\n\n" +
    "ID: X-1" +
    "\n\n" +
    "## 규율" +
    "\n\n" +
    "- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을\n" +
    "  식별자로 넣지 않는다.\n" +
    "- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다\n" +
    "  (위 ⚠ 규칙) — 모르는 값을 아는 척하지 않는다.\n" +
    "- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고\n" +
    "  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람)." +
    "\n";

  assert.equal(renderDomainSkillMd(doc), expected);
});

test("domain-skill: render(spec) omits the intro paragraph when spec.intro is absent", () => {
  const doc = {
    schema: "domain-skill/v1",
    id: "fdc-x",
    keywords: [{ kw: "fdc-x", inject: "full" }],
    status: "active",
    body: {
      name: "fdc-x",
      argumentHint: "{id}",
      description: "X를 설명한다.",
      steps: [{ title: "조회", sql: "SELECT 1" }],
      valueRules: [{ target: "ID", rule: "그대로 출력", basis: "scaffold" }],
      output: { lead: "답한다.", template: "ID: {id}" },
    },
  };
  const md = renderDomainSkillMd(doc);
  assert.ok(!md.includes("이 스킬은"));
  assert.ok(md.includes("주어진 인자를 받아"));
  assert.ok(!md.includes("예시:"));
});
