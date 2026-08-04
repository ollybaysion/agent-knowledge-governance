// Render/migrate round-trip tests using hand-authored inline fixtures. The one
// file fixture is test/fixtures/domain-skill-golden-SKILL.md — the stamped
// SKILL.md of the example spec, which pins the whole document against
// accidental drift (json-spec §4.4). It used to be named for foundry and
// described as a copy of foundry's golden output; foundry ships no renderer and
// no golden md any more (akg is the format owner and the only renderer), so the
// name now says what the file actually is. These fixtures are small and
// synthetic on purpose (see examples/ for realistic sample docs, which exist for
// dashboard preview, not test assertions).
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

test("domain-skill: render(spec v3) matches the expected SKILL.md byte-for-byte", () => {
  const doc = {
    schema: "domain-skill/v1",
    id: "fdc-x",
    keywords: [{ kw: "fdc-x", inject: "full" }],
    status: "active",
    body: {
      name: "fdc-x",
      argumentHint: "{id}",
      question: "T-1 지금 어때?",
      rephrasing: "T-1 의 현재 상태와, 멈춰 있다면 그 사유 코드까지.",
      inputs: [{ name: "id", required: true, description: "조회 키" }],
      dependencies: [{ mcp: "agent-db-plugin", tools: ["run_query"] }],
      needs: [
        {
          id: "state",
          what: "현재 상태",
          filledBy: [{ query: "row", column: "STATE" }],
        },
        {
          id: "stop_reason",
          what: "멈춘 사유",
          when: "state = STOP",
          filledBy: [{ query: "reason_row", column: "REASON_CD" }],
        },
        // 조달 수단이 없는 것도 문서에 남는다 — 그게 답불가의 선언이다.
        { id: "operator", what: "지금 붙어 있는 작업자", filledBy: [] },
      ],
      queries: [
        {
          id: "row",
          kind: "sql",
          sql: "SELECT id, state FROM T WHERE ID = :id",
          binds: { id: { from: "arg", arg: "id" } },
          notes: "결과 없으면 중단",
        },
        {
          id: "reason_row",
          kind: "sql",
          sql: "SELECT reason_cd FROM T_STOP WHERE ID = :tid",
          binds: { tid: { from: "query", query: "row", column: "ID" } },
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
    '---\nname: fdc-x\nargument-hint: "{id}"\ndisable-model-invocation: true\ndescription: >-\n  "T-1 지금 어때?" 같은 질문에 답한다 (id 필요).\n---' +
    "\n\n" +
    "# fdc-x" +
    "\n\n" +
    "입력 `{id}`를 받아 아래 **필요 데이터**를 **조달 수단**으로 채우고,\n" +
    "채운 값으로 **출력 형식**대로 자연어로 답한다." +
    "\n\n" +
    "## 질문" +
    "\n\n" +
    "> T-1 지금 어때?" +
    "\n\n" +
    "T-1 의 현재 상태와, 멈춰 있다면 그 사유 코드까지." +
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
    "## 필요 데이터" +
    "\n\n" +
    "알아야 할 것 하나에 조달 수단이 붙는다. 여럿이면 **아무거나 하나**면 되고,\n" +
    "조달 수단이 없는 항목은 이 스킬로 알 수 없는 것이다." +
    "\n\n" +
    "- **state** — 현재 상태 ← `row.STATE`\n" +
    "- **stop_reason** — 멈춘 사유 (`state = STOP` 일 때) ← `reason_row.REASON_CD`\n" +
    "- **operator** — 지금 붙어 있는 작업자 ← (조달 수단 없음 — 이 스킬로는 알 수 없다)" +
    "\n\n" +
    "## 조달 수단" +
    "\n\n" +
    "순서는 의미가 없다 — 각 쿼리는 그것을 지목한 필요 데이터 중 조건이 성립한 것이\n" +
    "하나라도 있을 때 실행한다." +
    "\n\n" +
    "### `row`" +
    "\n\n" +
    "```sql\nSELECT id, state FROM T WHERE ID = :id\n```" +
    "\n\n" +
    "- `:id` ← 인자 `id`" +
    "\n\n" +
    "결과 없으면 중단" +
    "\n\n" +
    "### `reason_row`" +
    "\n\n" +
    "```sql\nSELECT reason_cd FROM T_STOP WHERE ID = :tid\n```" +
    "\n\n" +
    "- `:tid` ← `row.ID`" +
    "\n\n" +
    "## 출력 형식" +
    "\n\n" +
    "채운 값으로 위 **질문**에 답한다. 정해진 형식은 없다.\n" +
    "체계적·논리적으로, 없는 정보는 지어내지 않는다." +
    "\n\n" +
    "**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): 현재 상태" +
    "\n\n" +
    "**조건부 포함**: 멈춘 사유 (`state = STOP` 일 때)" +
    "\n\n" +
    "**알 수 없는 것**: 지금 붙어 있는 작업자 — 조달 수단이 없다. 물으면 지어내지 말고 없다고 답한다." +
    "\n\n" +
    "채우지 못한 항목이 있으면 **무엇을 못 채웠는지 밝히고** 채운 것만으로 답한다 —\n" +
    "빈칸을 추측으로 메우지 않는다." +
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

// The example is the realistic body, so the golden pins the whole document —
// every fixed string the renderer owns, in one place, against accidental drift.
test("domain-skill: the example renders byte-identically to the checked-in golden", () => {
  const doc = JSON.parse(
    readFileSync(
      join(__dirname, "..", "examples", "domain-skill", "fdc-explain-sensor.json"),
      "utf8",
    ),
  );
  assert.deepEqual(validateDocument(doc, refs), []);
  const expected = readFileSync(
    join(__dirname, "fixtures", "domain-skill-golden-SKILL.md"),
    "utf8",
  );
  assert.equal(renderDomainSkillMd(doc), expected);
});

// The routing sentence quotes the question verbatim (issue #46) — no skeleton
// picked by a taxonomy field, so there is one shape instead of two.
test("domain-skill: the description quotes the question and lists the required args", () => {
  const body = {
    name: "fdc-trace",
    argumentHint: "{eqp} {pidx}",
    question: "이 측정값 어떻게 나온 거야?",
    rephrasing: "그 측정값이 어느 레시피 스텝에서 언제 수집됐는지.",
    inputs: [
      { name: "eqp", required: true, description: "설비" },
      { name: "pidx", required: true, description: "인덱스" },
      { name: "since", required: false, description: "시작 시각" },
    ],
  };
  assert.equal(
    synthesizeDescription(body),
    '"이 측정값 어떻게 나온 거야?" 같은 질문에 답한다 (eqp·pidx 필요).',
  );
});
