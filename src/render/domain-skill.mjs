// domain-skill/v1 body -> SKILL.md. Ported from
// agent-skill-foundry/forge/render-skill.mjs, adapted to the target state
// akg now owns (json-spec §4.4, design §5.3): h1Title is gone (H1 is always
// "# {name}"), intro is optional and holds ONLY domain-specific caveats —
// the execution framing that used to live in every hand-written intro is
// now a single fixed sentence the renderer always emits.
//
// Schema validation (unknown keys, minItems, name/description patterns) is
// the caller's job via envelope.mjs — this module only renders.

export const DEFAULT_DISCIPLINE = [
  "- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을",
  "  식별자로 넣지 않는다.",
  "- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다",
  "  (위 ⚠ 규칙) — 모르는 값을 아는 척하지 않는다.",
  "- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고",
  "  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람).",
].join("\n");

const FIXED_INTRO =
  "주어진 인자를 받아, 아래 **조회 절차를 순서대로** 실행하고 얻은 값들을\n" +
  "**출력 형식**대로 자연어로 바꿔 답한다. 모든 조회는 지정된 read-only MCP로\n" +
  "하고, 값은 항상 바인드로 넘긴다.";

function frontmatter(spec) {
  const desc = spec.description
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return [
    "---",
    `name: ${spec.name}`,
    `argument-hint: "${spec.argumentHint}"`,
    "disable-model-invocation: true",
    "description: >-",
    desc,
    "---",
  ].join("\n");
}

function stepBlocks(step) {
  const blocks = [`### ${step.title}`];
  if (step.lead) blocks.push(step.lead);
  blocks.push("```sql\n" + step.sql + "\n```");
  if (step.notes) blocks.push(step.notes);
  return blocks;
}

function rulesTable(rules) {
  const rows = rules.map((r) => `| ${r.target} | ${r.rule} | ${r.basis} |`);
  return ["| 대상 | 규칙 | 근거 |", "| --- | --- | --- |", ...rows].join("\n");
}

export function renderDomainSkillMd(doc) {
  const spec = doc.body;
  const blocks = [
    frontmatter(spec),
    `# ${spec.name}`,
    spec.intro ? `${FIXED_INTRO}\n\n${spec.intro}` : FIXED_INTRO,
    "## 조회 절차",
    ...spec.steps.flatMap(stepBlocks),
    "## 값 해석 규칙",
    rulesTable(spec.valueRules),
    "## 출력 형식",
    spec.output.lead,
    spec.output.template,
  ];
  if (spec.output.example)
    blocks.push(spec.output.exampleLabel, spec.output.example);
  blocks.push("## 규율", spec.discipline ?? DEFAULT_DISCIPLINE);
  return blocks.join("\n\n") + "\n";
}
