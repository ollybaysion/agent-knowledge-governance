// Render/migrate round-trip tests using hand-authored inline fixtures. The one
// file fixture is test/fixtures/domain-skill-golden-SKILL.md — the stamped
// SKILL.md of the example skill md, which pins the whole document against
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
import { renderDomainSkillMd, skillSummary } from "../src/render/domain-skill.mjs";

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

test("domain-skill: render(md body) is the frontmatter and then the text as written", () => {
  const markdown = "# fdc-x\n\n## 한 줄 설명\n\nT-1 의 현재 상태를 설명한다.\n\n## 데이터\n\n### row — 상태 행\n\n```sql\nSELECT state FROM t\n```\n\n\n";
  const doc = {
    schema: "domain-skill/v1",
    id: "fdc-x",
    keywords: [{ kw: "fdc-x", inject: "full" }],
    status: "active",
    body: { name: "fdc-x", markdown },
  };
  assert.deepEqual(validateDocument(doc, refs), []);
  const expected = `---
name: fdc-x
disable-model-invocation: true
description: >-
  T-1 의 현재 상태를 설명한다.
---

# fdc-x

## 한 줄 설명

T-1 의 현재 상태를 설명한다.

## 데이터

### row — 상태 행

\`\`\`sql
SELECT state FROM t
\`\`\`
`;
  assert.equal(renderDomainSkillMd(doc), expected);
});

// The example is the realistic body, so the golden pins the whole document —
// every fixed string the renderer owns, in one place, against accidental drift.
test("domain-skill: the example renders byte-identically to the checked-in golden", () => {
  const doc = JSON.parse(
    readFileSync(
      join(__dirname, "..", "examples", "domain-skill", "fdc-explain-sensor-origin.json"),
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

// The frontmatter description is the first paragraph under `## 한 줄 설명` —
// that section exists to be the one-line summary. Without it the name stands in,
// so the frontmatter is never malformed.
test("domain-skill: the description is the 한 줄 설명 paragraph, or the name when there is none", () => {
  assert.equal(
    skillSummary("# a\n\n## 한 줄 설명\n\n\n첫 문장.\n둘째 줄.\n\n## 데이터\n"),
    "첫 문장.",
  );
  assert.equal(skillSummary("# a\n\n## 한 줄 설명:\n\n물음표·콜론은 노이즈.\n"), "물음표·콜론은 노이즈.");
  assert.equal(skillSummary("# a\n\n## 데이터\n\n한 줄 설명 절이 없다.\n"), null);
  const doc = { body: { name: "no-summary", markdown: "# no-summary\n\n## 데이터\n" } };
  assert.match(renderDomainSkillMd(doc), /^---\nname: no-summary\ndisable-model-invocation: true\ndescription: >-\n  no-summary\n---\n/);
});
