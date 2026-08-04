// domain-skill/v1 body (spec v3) -> SKILL.md.
//
// The document is the four cells in order: 질문 → rephrasing → 필요 데이터 →
// 조달 수단 (issue #46). What changed for a reader of the md is the middle: a
// numbered 조회 절차 became a list of what must be known, each item pointing at
// the query that fills it. Order is gone from the queries — so the wiring that
// used to live in prose (`lead`: "1단계의 EQP_ID로:") is now rendered from
// `binds`, which is the only dependency left between two queries.
//
// `description` is not a body field: it is synthesized here from `questions`, so
// the routing sentence quotes how someone actually asks instead of a skeleton
// assembled from taxonomy fields (scope/focus, removed in v3).
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

/** The precondition clause: the required argument names, joined. */
function precondition(inputs) {
  return `${inputs
    .filter((p) => p.required)
    .map((p) => p.name)
    .join("·")} 필요`;
}

// The routing sentence quotes `questions` verbatim — the utterances ARE the
// routing signal (issue #46 supersedes the scope+focus skeleton), and all of
// them are quoted because a variant that never reaches the description cannot
// route anything. The consumer contract is unchanged: one complete sentence
// ending in a period, on the first line.
export function synthesizeDescription(spec) {
  const asked = spec.questions.map((q) => `"${q}"`).join(", ");
  return `${asked} 같은 질문에 답한다 (${precondition(spec.inputs)}).`;
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
// renderer owns it. It names the two sections that carry the work, in the
// direction v3 fixed: the needs decide what to fetch, not the other way round.
function fixedIntro(spec) {
  return [
    `입력 \`${spec.argumentHint}\`를 받아 아래 **필요 데이터**를 **조달 수단**으로 채우고,`,
    "채운 값으로 **출력 형식**대로 자연어로 답한다.",
  ].join("\n");
}

// Every phrasing is quoted, separated by a bare `>` so md reads them as
// distinct paragraphs of one quote — a single question renders exactly as
// before.
function questionBlocks(spec) {
  return [spec.questions.map((q) => `> ${q}`).join("\n>\n"), spec.rephrasing];
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

// A need reads as one line: what it is, when it applies, where it comes from.
// An empty filledBy is not a gap in the document — it is the document saying
// this skill cannot get that, which is the point of making needs first class.
const sourceOf = (need) =>
  need.filledBy.length === 0
    ? "(조달 수단 없음 — 이 스킬로는 알 수 없다)"
    : need.filledBy.map((f) => `\`${f.query}.${f.column}\``).join(" 또는 ");

function needBlocks(needs) {
  return [
    "알아야 할 것 하나에 조달 수단이 붙는다. 여럿이면 **아무거나 하나**면 되고,\n" +
      "조달 수단이 없는 항목은 이 스킬로 알 수 없는 것이다.",
    needs
      .map((n) => {
        const when = n.when ? ` (\`${n.when}\` 일 때)` : "";
        return `- **${n.id}** — ${n.what}${when} ← ${sourceOf(n)}`;
      })
      .join("\n"),
  ];
}

// binds is where a query says it depends on another one — the last thing left
// of the old step order, and now the only thing. Rendering it keeps the md
// reader able to chain queries without a numbered flow to follow.
function bindLines(binds) {
  return Object.entries(binds)
    .map(([name, src]) =>
      src.from === "arg"
        ? `- \`:${name}\` ← 인자 \`${src.arg}\``
        : `- \`:${name}\` ← \`${src.query}.${src.column}\``,
    )
    .join("\n");
}

function queryBlocks(query) {
  const head = query.table
    ? `### \`${query.id}\` — \`${query.table}\``
    : `### \`${query.id}\``;
  const blocks = [head, "```sql\n" + query.sql + "\n```"];
  if (query.binds && Object.keys(query.binds).length)
    blocks.push(bindLines(query.binds));
  if (query.notes) blocks.push(query.notes);
  return blocks;
}

function quoted(label, text) {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? `> **${label}**: ${line}` : `> ${line}`))
    .join("\n");
}

// Form is free, content is not. The floor is composed from `needs` now, not
// from what the queries happened to produce — the same inversion the body made.
// A conditional need is listed apart so the floor stays true when its condition
// does not hold, and the unmet line is fixed text: v3 gives a stop message no
// field of its own (user decision 2026-08-04), so the model names the needs it
// could not fill and answers with the rest.
function outputBlocks(spec) {
  // A need with no filledBy is not part of the floor — it can never be filled,
  // and demanding it would make every answer report the same permanent gap.
  // It gets its own line instead, which says what to do when asked for it.
  const procurable = spec.needs.filter((n) => n.filledBy.length > 0);
  const always = procurable.filter((n) => !n.when);
  const conditional = procurable.filter((n) => n.when);
  const unknown = spec.needs.filter((n) => n.filledBy.length === 0);
  const blocks = [
    "채운 값으로 위 **질문**에 답한다. 정해진 형식은 없다.\n" +
      "체계적·논리적으로, 없는 정보는 지어내지 않는다.",
  ];
  if (always.length)
    blocks.push(
      `**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): ${always
        .map((n) => n.what)
        .join(" · ")}`,
    );
  if (conditional.length)
    blocks.push(
      `**조건부 포함**: ${conditional
        .map((n) => `${n.what} (\`${n.when}\` 일 때)`)
        .join(" · ")}`,
    );
  if (unknown.length)
    blocks.push(
      `**알 수 없는 것**: ${unknown
        .map((n) => n.what)
        .join(" · ")} — 조달 수단이 없다. 물으면 지어내지 말고 없다고 답한다.`,
    );
  blocks.push(
    "채우지 못한 항목이 있으면 **무엇을 못 채웠는지 밝히고** 채운 것만으로 답한다 —\n" +
      "빈칸을 추측으로 메우지 않는다.",
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
    "## 질문",
    ...questionBlocks(spec),
    "## 입력 파라미터",
    inputBlocks(spec.inputs),
    "## 의존성",
    ...dependencyBlocks(spec.dependencies),
    "## 필요 데이터",
    ...needBlocks(spec.needs),
    "## 조달 수단",
    "순서는 의미가 없다 — 각 쿼리는 그것을 지목한 필요 데이터 중 조건이 성립한 것이\n" +
      "하나라도 있을 때 실행한다.",
    ...spec.queries.flatMap(queryBlocks),
    "## 출력 형식",
    ...outputBlocks(spec),
    "## 규율",
    spec.discipline ?? DEFAULT_DISCIPLINE,
  ];
  return blocks.join("\n\n") + "\n";
}
