// A golden-set md: the questions an agent is scored against, one document per
// agent (id = the domain-skill id). Shared by the server's validator and the
// dashboard (served as /golden-set.mjs), so both read the same questions. No
// node imports: this file runs in the browser as it is.
//
// `## 설정` holds where data questions run; each kind section holds `###`
// questions, the heading being the question and `- 이름: 값` lines its fields.
// fdc-agent-be-spring GoldenMarkdownTool reads the same rules.
import { GOLDEN_SECTIONS, normalizeHeading, scan } from "./skill-sections.mjs";
import { skillDataIds } from "./skill-data-ids.mjs";

/** The four question kinds, numbered as the scoring design numbers them. */
export const GOLDEN_KINDS = [
  { kind: 1, key: "일반 지식", fields: ["조각", "채점표"], required: ["조각"] },
  { kind: 2, key: "데이터 설명", fields: ["조회", "입력"], required: ["조회"] },
  { kind: 3, key: "데이터 연관", fields: ["조회", "채점표", "입력"], required: ["조회", "채점표"] },
  { kind: 4, key: "고도화 분석", fields: ["보류"], required: ["보류"] },
];
const KIND_BY_KEY = new Map(GOLDEN_KINDS.map((k) => [k.key, k]));
const SECTION_KEYS = new Set(GOLDEN_SECTIONS.map((s) => s.key));
const SETTINGS = "설정";
const SETTING_FIELDS = { 라인: "line", 설비: "eqp", 기간: "duration" };

/** `조각: 없음` — the author marks knowledge the skill md does not have. */
export const NO_KNOWLEDGE = "없음";

const MINUTE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}";
const DURATION = new RegExp(`^(${MINUTE})\\s*~\\s*(${MINUTE})$`);
const FIELD = /^-\s+([^:：]+?)\s*[:：]\s*(.*?)\s*$/;
const BARE_FIELD = /^-\s+(\S+)\s*$/;
const H3 = /^###\s+(.*?)\s*#*\s*$/;

const list = (v) =>
  v
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Read a golden md. Every rule break is an error naming the line; the reader
 * keeps going so one save shows them all.
 * @returns {{
 *   settings: {line?: string, eqp?: string, duration?: {from: string, to: string}} | null,
 *   questions: {kind: number, text: string, line: number, pieces: string[],
 *     noKnowledge: boolean, queries: string[], rubric: string|null,
 *     inputs: Record<string,string>, deferred: boolean}[],
 *   errors: string[],
 * }} line is 1-based
 */
export function parseGolden(markdown) {
  const errors = [];
  const questions = [];
  let settings = null;
  let section = null; // "설정" | a GOLDEN_KINDS entry | "?" (unknown) | null (before the first ##)
  let question = null;
  const seenSections = new Set();
  const seenFields = new Set();

  const at = (i, raw) => `${i + 1}행 "${raw.trim()}"`;

  function setting(i, raw, name, value) {
    const key = SETTING_FIELDS[name];
    if (!key) {
      errors.push(`${at(i, raw)}: 설정 칸은 라인 · 설비 · 기간 셋입니다`);
      return;
    }
    if (key in settings) {
      errors.push(`${at(i, raw)}: 설정 칸 "${name}" 이 두 번 있습니다`);
      return;
    }
    if (key === "duration") {
      const m = DURATION.exec(value);
      if (!m) {
        errors.push(`${at(i, raw)}: 기간은 "시작 ~ 끝"(예 2026-10-01T00:00 ~ 2026-10-01T06:00)입니다`);
        return;
      }
      if (m[1] >= m[2]) {
        errors.push(`${at(i, raw)}: 기간의 끝이 시작보다 뒤여야 합니다`);
        return;
      }
      settings.duration = { from: m[1], to: m[2] };
    } else if (value === "") {
      errors.push(`${at(i, raw)}: 설정 칸 "${name}" 의 값이 비었습니다`);
    } else {
      settings[key] = value;
    }
  }

  function field(i, raw, name, value) {
    const kind = section;
    if (!kind.fields.includes(name)) {
      errors.push(`${at(i, raw)}: ${kind.key} 질문의 칸은 ${kind.fields.join(" · ")} 입니다`);
      return;
    }
    if (seenFields.has(name)) {
      errors.push(`${at(i, raw)}: 칸 "${name}" 이 두 번 있습니다`);
      return;
    }
    seenFields.add(name);
    if (name === "보류") {
      if (value !== "") errors.push(`${at(i, raw)}: 보류 는 값 없이 "- 보류" 한 줄입니다`);
      question.deferred = true;
      return;
    }
    if (value === "") {
      errors.push(`${at(i, raw)}: 칸 "${name}" 의 값이 비었습니다`);
      return;
    }
    if (name === "조각") {
      if (value === NO_KNOWLEDGE) question.noKnowledge = true;
      else question.pieces = list(value);
    } else if (name === "조회") {
      question.queries = list(value);
    } else if (name === "채점표") {
      question.rubric = value;
    } else if (name === "입력") {
      for (const pair of list(value)) {
        const eq = pair.indexOf("=");
        const k = eq > 0 ? pair.slice(0, eq).trim() : "";
        if (!k) {
          errors.push(`${at(i, raw)}: 입력은 "키=값" 을 쉼표로 잇습니다 — "${pair}"`);
          continue;
        }
        question.inputs[k] = pair.slice(eq + 1).trim();
      }
    }
  }

  function close() {
    if (!question) return;
    const kind = GOLDEN_KINDS[question.kind - 1];
    for (const name of kind.required)
      if (!seenFields.has(name))
        errors.push(`${question.line}행 "### ${question.text}": ${kind.key} 질문에는 "${name}" 칸이 있어야 합니다`);
    questions.push(question);
    question = null;
    seenFields.clear();
  }

  scan(markdown).forEach(({ line: raw, heading, fenced }, i) => {
    if (heading !== null) {
      close();
      const key = normalizeHeading(heading);
      if (!SECTION_KEYS.has(key)) {
        errors.push(
          `${at(i, raw)}: 모르는 절입니다 (허용: ${GOLDEN_SECTIONS.map((s) => `## ${s.key}`).join(" · ")})`,
        );
        section = "?";
        return;
      }
      if (seenSections.has(key)) errors.push(`${at(i, raw)}: 같은 절이 두 번 있습니다`);
      seenSections.add(key);
      if (key === SETTINGS) {
        settings ??= {};
        section = SETTINGS;
      } else {
        section = KIND_BY_KEY.get(key);
      }
      return;
    }
    const line = raw.trim();
    if (section === null || section === "?" || line === "") return;
    if (fenced) {
      errors.push(`${at(i, raw)}: 골든 셋에는 코드 펜스를 쓰지 않습니다`);
      return;
    }
    const h3 = H3.exec(line);
    if (section === SETTINGS) {
      if (h3) {
        errors.push(`${at(i, raw)}: 질문은 종류 절(일반 지식 · 데이터 설명 · 데이터 연관 · 고도화 분석) 아래에 둡니다`);
        return;
      }
      const m = FIELD.exec(line);
      if (m) setting(i, raw, m[1], m[2]);
      else errors.push(`${at(i, raw)}: 설정 칸은 "- 이름: 값" 줄입니다`);
      return;
    }
    if (h3) {
      close();
      question = {
        kind: section.kind,
        text: h3[1],
        line: i + 1,
        pieces: [],
        noKnowledge: false,
        queries: [],
        rubric: null,
        inputs: {},
        deferred: false,
      };
      return;
    }
    if (!question) {
      errors.push(`${at(i, raw)}: 종류 절에는 "### 질문" 과 그 칸만 둡니다`);
      return;
    }
    const m = FIELD.exec(line);
    if (m) {
      field(i, raw, m[1], m[2]);
      return;
    }
    const bare = BARE_FIELD.exec(line);
    if (bare && bare[1] === "보류") field(i, raw, "보류", "");
    else errors.push(`${at(i, raw)}: 칸은 "- 이름: 값" 줄입니다`);
  });
  close();
  return { settings, questions, errors };
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
 * A golden md checked against its agent's skill md. errors refuse the save: a
 * rule break, or a 조회 id the skill has no query for. warnings do not: a 조각
 * path the skill has no heading for (the author may be renaming it), or data
 * questions with no `## 설정` to run them in.
 * @param {string} markdown
 * @param {string|null} skillMarkdown null = no skill to check against
 * @returns {{errors: string[], warnings: string[]}}
 */
export function checkGolden(markdown, skillMarkdown) {
  const { settings, questions, errors } = parseGolden(markdown);
  const warnings = [];
  if (skillMarkdown != null) {
    const queries = new Set(skillDataIds(skillMarkdown).filter((d) => d.query).map((d) => d.id));
    const paths = new Set(knowledgePaths(skillMarkdown));
    for (const q of questions) {
      const missing = q.queries.filter((id) => !queries.has(id));
      if (missing.length)
        errors.push(`${q.line}행 "### ${q.text}": 스킬 md 의 ## 데이터 에 없는 조회 id 입니다 — ${missing.join(", ")}`);
      const unknown = q.pieces.filter((p) => !paths.has(p));
      if (unknown.length)
        warnings.push(`${q.line}행 "### ${q.text}": 스킬 md 의 ## 도메인 지식 에 없는 조각입니다 — ${unknown.join(", ")}`);
    }
  }
  const data = questions.filter((q) => q.kind === 2 || q.kind === 3).length;
  if (data && !(settings?.line && settings?.eqp))
    warnings.push(`## 설정 에 라인 · 설비가 없어 데이터 질문 ${data}개를 돌릴 수 없습니다`);
  return { errors, warnings };
}

/** Questions per kind, for a header: {1: n, 2: n, 3: n, 4: n}. */
export function countByKind(questions) {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const q of questions) out[q.kind] += 1;
  return out;
}
