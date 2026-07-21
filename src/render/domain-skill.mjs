// domain-skill/v1 body (agent-skill-foundry spec v2) -> SKILL.md.
//
// This is a port of agent-skill-foundry/forge/render-skill.mjs and the
// contract is byte-equality with it (json-spec §4.4): the same body must
// render to the same file on both sides. Keep every fixed string identical —
// the fixed intro, the section headings, the output scaffolding, the
// discipline block. (The previous port had drifted here: its fixed intro read
// "주어진 인자를 받아…" while the renderer emits "입력 `{argumentHint}`를
// 받아…", so the two sides could never have been byte-equal.)
//
// `description` is not a body field: it is synthesized here from scope +
// focus + inputs, so the routing sentence cannot drift off its skeleton.
// Korean particle agreement is computed so any focus reads naturally.
//
// Schema validation (unknown keys, minItems, patterns) is the caller's job
// via envelope.mjs — this module only renders.

export const DEFAULT_DISCIPLINE = [
  "- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을",
  "  식별자로 넣지 않는다.",
  "- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다 —",
  "  모르는 값을 아는 척하지 않는다 (코드표는 표준 db-schema 문서에서 주입).",
  "- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고",
  "  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람).",
].join("\n");

function hasFinalConsonant(text) {
  const last = text.trim().slice(-1);
  if (!last) return false;
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

const objectParticle = (text) => (hasFinalConsonant(text) ? "을" : "를");
const subjectParticle = (text) => (hasFinalConsonant(text) ? "이" : "가");

/** The precondition clause: the required argument names, joined. */
function precondition(inputs) {
  return `${inputs
    .filter((p) => p.required)
    .map((p) => p.name)
    .join("·")} 필요`;
}

/** "언제 부르나"(트리거)만 적는다 — 골격은 scope.의도 가 고른다. */
export function synthesizeDescription(spec) {
  const when = precondition(spec.inputs);
  if (spec.scope.의도 === "생성 이력")
    return `특정 ${spec.focus}${subjectParticle(spec.focus)} 어떻게 만들어졌는지 묻는 상황에서 호출한다 (${when}).`;
  return `특정 ${spec.scope.단위}의 ${spec.focus}${objectParticle(spec.focus)} 묻는 상황에서 호출한다 (${when}).`;
}

function frontmatter(spec) {
  const lines = [
    "---",
    `name: ${spec.name}`,
    `argument-hint: "${spec.argumentHint}"`,
  ];
  if (spec.anchorTable) lines.push(`anchor-table: ${spec.anchorTable}`);
  lines.push(
    "disable-model-invocation: true",
    "description: >-",
    `  ${synthesizeDescription(spec)}`,
    "---",
  );
  return lines.join("\n");
}

// The execution framing is invariant across every stamped skill, so the
// renderer owns it; body.intro may only add domain caveats below this line.
function fixedIntro(spec) {
  return [
    `입력 \`${spec.argumentHint}\`를 받아 아래 **조회 절차**를 순서대로 실행하고,`,
    "얻은 값을 **출력 형식**대로 자연어로 답한다.",
  ].join("\n");
}

function inputBlocks(inputs) {
  return inputs
    .map(
      (p) =>
        `- **${p.name}** (${p.required ? "필수" : "선택"}) — ${p.description}`,
    )
    .join("\n");
}

function dependencyBlocks(dependencies) {
  const rows = dependencies
    .map((d) => {
      const tools = d.tools ? ` (${d.tools.join(", ")})` : "";
      const why = d.why ? ` — ${d.why}` : "";
      return `- **${d.mcp}**${tools}${why}`;
    })
    .join("\n");
  return [
    rows,
    "실행 전 `list_connections`로 확인하고, 없으면 무엇이 없는지 밝히고 멈춘다.",
  ];
}

function stepBlocks(step) {
  const blocks = [`### ${step.title}`];
  if (step.lead) blocks.push(step.lead);
  blocks.push("```sql\n" + step.sql + "\n```");
  if (step.branches)
    blocks.push(
      step.branches.map((b) => `- 만약 ${b.when} → ${b.then}`).join("\n"),
    );
  if (step.notes) blocks.push(step.notes);
  return blocks;
}

function quoted(label, text) {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? `> **${label}**: ${line}` : `> ${line}`))
    .join("\n");
}

// Form is free, content is not. The narration line refuses to fix a format;
// 반드시 포함 (composed from steps[].produces) is the floor that keeps a weak
// model from silently dropping a dimension it actually fetched. The clause
// "질문이 특정 항목만 묻는 게 아니면" is what keeps that floor from
// contradicting the deliberately narrow second example.
function outputBlocks(spec) {
  const blocks = [
    `조회한 데이터로 ${spec.scope.단위}의 ${spec.focus}${objectParticle(spec.focus)} 설명한다. 정해진 형식은 없다.\n` +
      "체계적·논리적으로, 없는 정보는 지어내지 않는다.",
  ];
  const produces = spec.steps.map((s) => s.produces).filter(Boolean);
  blocks.push(
    `**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): ${produces.join(" · ")}`,
  );
  blocks.push(
    "**하지 말 것**",
    spec.output.avoid.map((a) => `- ${a}`).join("\n"),
  );
  blocks.push("**예시** (모양만 참고, 값은 조회 결과로 바꾼다)");
  for (const ex of spec.output.examples) {
    blocks.push(`${quoted("질문", ex.ask)}\n${quoted("답", ex.answer)}`);
  }
  return blocks;
}

export function renderDomainSkillMd(doc) {
  const spec = doc.body;
  const blocks = [
    frontmatter(spec),
    `# ${spec.name}`,
    fixedIntro(spec),
    spec.intro,
    "## 입력 파라미터",
    inputBlocks(spec.inputs),
    "## 의존성",
    ...dependencyBlocks(spec.dependencies),
    "## 조회 절차",
    ...spec.steps.flatMap(stepBlocks),
    "## 출력 형식",
    ...outputBlocks(spec),
    "## 규율",
    spec.discipline ?? DEFAULT_DISCIPLINE,
  ];
  return blocks.join("\n\n") + "\n";
}
