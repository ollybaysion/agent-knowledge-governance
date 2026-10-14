// The `## 답변 품질 검증 Set` section of a main skill md: the questions the
// agent's answers are scored against. Shared by the server's validator and the
// dashboard (served as /verify-set.mjs). No node imports: this file runs in the
// browser as it is.
//
// `### 설정` holds where data questions run; each kind `###` holds `####`
// questions, the heading being the question. fdc-agent-be-spring
// VerificationSetTool reads the same rules.
import { normalizeHeading, scan } from "./skill-sections.mjs";

export const VERIFY_SECTION = "답변 품질 검증 Set";
const SETTINGS = "설정";

/**
 * The four question kinds, numbered as the scoring design numbers them. `sql`
 * is how many ```sql blocks a question takes: "none", "one" or "many" (one or
 * more). A data question's answer is its SQL with every value bound.
 */
export const VERIFY_KINDS = [
  { kind: 1, key: "일반 지식", fields: ["정답", "채점표"], required: ["정답"], sql: "none" },
  { kind: 2, key: "데이터 설명", fields: [], required: [], sql: "one" },
  { kind: 3, key: "데이터 연관", fields: ["채점표"], required: ["채점표"], sql: "many" },
  { kind: 4, key: "고도화 분석", fields: ["보류"], required: ["보류"], sql: "none" },
];
const KIND_BY_KEY = new Map(VERIFY_KINDS.map((k) => [k.key, k]));
const PARTS = [SETTINGS, ...VERIFY_KINDS.map((k) => k.key)];
const SETTING_FIELDS = { 라인: "line", 설비: "eqp", 기간: "duration" };

/** `정답: 없음` — the author marks knowledge the skill md does not have. */
export const NO_KNOWLEDGE = "없음";

const MINUTE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}";
const DURATION = new RegExp(`^(${MINUTE})\\s*~\\s*(${MINUTE})$`);
const FIELD = /^-\s+([^:：]+?)\s*[:：]\s*(.*?)\s*$/;
const BARE_FIELD = /^-\s+(\S+)\s*$/;
const SUB_HEADING = /^(#{3,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(`{3,}|~{3,})\s*(\S*)/;

/** The body of a section that has none yet: its five parts, no question. */
export function verifySetTemplate() {
  return PARTS.map((p) => `### ${p}`).join("\n\n");
}

/**
 * Read the section out of a skill md. Every rule break is an error naming the
 * line (1-based, of the whole md); the reader keeps going so one save shows
 * them all.
 * @returns {{
 *   present: boolean,
 *   settings: {line?: string, eqp?: string, duration?: {from: string, to: string}} | null,
 *   questions: {kind: number, text: string, line: number, pieces: string[],
 *     noKnowledge: boolean, sqls: string[], rubric: string|null, deferred: boolean}[],
 *   errors: string[],
 * }}
 */
export function parseVerifySet(markdown) {
  const errors = [];
  const questions = [];
  let present = false;
  let settings = null;
  let inSection = false;
  let part = null; // "설정" | a VERIFY_KINDS entry | "?" | null (before the first ###)
  let question = null;
  let fence = null; // {marker, lang, lines, line} while inside a fenced block
  const seenParts = new Set();
  const seenFields = new Set();

  const at = (i, raw) => `${i + 1}행 "${raw.trim()}"`;

  function setting(i, raw, name, value) {
    const key = SETTING_FIELDS[name];
    if (!key) return errors.push(`${at(i, raw)}: 설정 칸은 라인 · 설비 · 기간 셋입니다`);
    if (key in settings) return errors.push(`${at(i, raw)}: 설정 칸 "${name}" 이 두 번 있습니다`);
    if (value === "") return errors.push(`${at(i, raw)}: 설정 칸 "${name}" 의 값이 비었습니다`);
    if (key !== "duration") return void (settings[key] = value);
    const m = DURATION.exec(value);
    if (!m) return errors.push(`${at(i, raw)}: 기간은 "시작 ~ 끝"(예 2026-10-01T00:00 ~ 2026-10-01T06:00)입니다`);
    if (m[1] >= m[2]) return errors.push(`${at(i, raw)}: 기간의 끝이 시작보다 뒤여야 합니다`);
    settings.duration = { from: m[1], to: m[2] };
  }

  function field(i, raw, name, value) {
    if (!part.fields.includes(name))
      return errors.push(
        `${at(i, raw)}: ${part.key} 질문에는 ${part.fields.length ? `${part.fields.join(" · ")} 칸만` : "칸 없이 ```sql 블록만"} 씁니다`,
      );
    if (seenFields.has(name)) return errors.push(`${at(i, raw)}: 칸 "${name}" 이 두 번 있습니다`);
    seenFields.add(name);
    if (name === "보류") {
      if (value !== "") errors.push(`${at(i, raw)}: 보류 는 값 없이 "- 보류" 한 줄입니다`);
      question.deferred = true;
      return;
    }
    if (value === "") return errors.push(`${at(i, raw)}: 칸 "${name}" 의 값이 비었습니다`);
    if (name === "정답") {
      if (value === NO_KNOWLEDGE) question.noKnowledge = true;
      else question.pieces = value.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    } else {
      question.rubric = value;
    }
  }

  function closeFence(i) {
    const text = fence.lines.join("\n").trim();
    if (!question) errors.push(`${fence.line}행: SQL 은 "#### 질문" 아래에 둡니다`);
    else if (fence.lang.toLowerCase() !== "sql") errors.push(`${fence.line}행: 정답 블록은 \`\`\`sql 입니다`);
    else if (part.sql === "none") errors.push(`${fence.line}행: ${part.key} 질문에는 SQL 을 쓰지 않습니다`);
    else if (text === "") errors.push(`${fence.line}행: SQL 블록이 비었습니다`);
    else question.sqls.push(text);
    fence = null;
  }

  function close() {
    if (!question) return;
    const kind = VERIFY_KINDS[question.kind - 1];
    const head = `${question.line}행 "#### ${question.text}"`;
    for (const name of kind.required)
      if (!seenFields.has(name)) errors.push(`${head}: ${kind.key} 질문에는 "${name}" 칸이 있어야 합니다`);
    if (kind.sql === "one" && question.sqls.length !== 1)
      errors.push(`${head}: ${kind.key} 질문에는 \`\`\`sql 블록이 꼭 하나 있어야 합니다 (지금 ${question.sqls.length}개)`);
    if (kind.sql === "many" && question.sqls.length === 0)
      errors.push(`${head}: ${kind.key} 질문에는 \`\`\`sql 블록이 하나 이상 있어야 합니다`);
    questions.push(question);
    question = null;
    seenFields.clear();
  }

  scan(markdown).forEach(({ line: raw, heading }, i) => {
    if (heading !== null) {
      if (inSection) close();
      inSection = normalizeHeading(heading) === VERIFY_SECTION;
      if (inSection) present = true;
      return;
    }
    if (!inSection) return;
    if (fence) {
      if (raw.trim().startsWith(fence.marker)) closeFence(i);
      else fence.lines.push(raw);
      return;
    }
    const opens = FENCE.exec(raw);
    if (opens) {
      fence = { marker: opens[1], lang: opens[2] ?? "", lines: [], line: i + 1 };
      return;
    }
    const line = raw.trim();
    if (line === "") return;
    const h = SUB_HEADING.exec(line);
    if (h && h[1].length === 3) {
      close();
      const key = normalizeHeading(h[2]);
      if (!PARTS.includes(key)) {
        errors.push(`${at(i, raw)}: 검증 Set 의 ### 는 ${PARTS.join(" · ")} 입니다`);
        part = "?";
        return;
      }
      if (seenParts.has(key)) errors.push(`${at(i, raw)}: 같은 ### 가 두 번 있습니다`);
      seenParts.add(key);
      part = key === SETTINGS ? SETTINGS : KIND_BY_KEY.get(key);
      if (key === SETTINGS) settings ??= {};
      return;
    }
    if (part === "?") return;
    if (part === null) return errors.push(`${at(i, raw)}: 검증 Set 은 ### 로 나눕니다`);
    if (h && h[1].length === 4) {
      if (part === SETTINGS) return errors.push(`${at(i, raw)}: 질문은 종류(### 일반 지식 …) 아래에 둡니다`);
      close();
      question = { kind: part.kind, text: h[2], line: i + 1, pieces: [], noKnowledge: false, sqls: [], rubric: null, deferred: false };
      return;
    }
    if (h) return errors.push(`${at(i, raw)}: 질문은 #### 한 단계입니다`);
    const m = FIELD.exec(line);
    if (part === SETTINGS) {
      if (m) setting(i, raw, m[1], m[2]);
      else errors.push(`${at(i, raw)}: 설정 칸은 "- 이름: 값" 줄입니다`);
      return;
    }
    if (!question) return errors.push(`${at(i, raw)}: 종류 아래에는 "#### 질문" 과 그 칸만 둡니다`);
    if (m) return field(i, raw, m[1], m[2]);
    const bare = BARE_FIELD.exec(line);
    if (bare && bare[1] === "보류") field(i, raw, "보류", "");
    else errors.push(`${at(i, raw)}: 칸은 "- 이름: 값" 줄입니다`);
  });
  if (fence) errors.push(`${fence.line}행: 펜스가 닫히지 않았습니다`);
  close();
  return { present, settings, questions, errors };
}

/**
 * The knowledge piece paths of a skill md, as the consumer ids them minus the
 * `<skill>/` prefix: `## 도메인 지식` itself when it has text, then every
 * heading under it that has text, its ancestors' titles joined with " / ".
 * (fdc-agent-be-spring SkillMarkdownTool.documents)
 */
export function knowledgePaths(markdown) {
  const out = [];
  let inKnowledge = false;
  let path = []; // [{level, title}]
  let open = null; // {title, hasText}
  const flush = () => {
    if (open?.hasText) out.push(open.title);
    open = null;
  };
  for (const { line, heading, fenced } of scan(markdown)) {
    if (heading !== null) {
      flush();
      inKnowledge = normalizeHeading(heading) === "도메인 지식";
      path = [];
      if (inKnowledge) open = { title: heading.trim(), hasText: false };
      continue;
    }
    if (!inKnowledge) continue;
    const h = fenced ? null : /^(#{3,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      const title = h[2].trim();
      open = { title: [...path.map((p) => p.title), title].join(" / "), hasText: false };
      path.push({ level, title });
      continue;
    }
    if (open && line.trim() !== "") open.hasText = true;
  }
  flush();
  return out;
}

/**
 * The section checked. errors refuse the save (a rule break); warnings do not:
 * a 정답 path the skill's `## 도메인 지식` has no heading for (the author may be
 * renaming it), or data questions with no 라인 · 설비 to run in.
 * @returns {{present: boolean, errors: string[], warnings: string[]}}
 */
export function checkVerifySet(markdown) {
  const { present, settings, questions, errors } = parseVerifySet(markdown);
  const warnings = [];
  const paths = new Set(knowledgePaths(markdown));
  for (const q of questions) {
    const unknown = q.pieces.filter((p) => !paths.has(p));
    if (unknown.length)
      warnings.push(`${q.line}행 "#### ${q.text}": ## 도메인 지식 에 없는 정답 경로입니다 — ${unknown.join(", ")}`);
  }
  const data = questions.filter((q) => q.kind === 2 || q.kind === 3).length;
  if (data && !(settings?.line && settings?.eqp))
    warnings.push(`### 설정 에 라인 · 설비가 없어 데이터 질문 ${data}개를 돌릴 수 없습니다`);
  return { present, errors, warnings };
}

/** Questions per kind, for a header: {1: n, 2: n, 3: n, 4: n}. */
export function countByKind(questions) {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const q of questions) out[q.kind] += 1;
  return out;
}
