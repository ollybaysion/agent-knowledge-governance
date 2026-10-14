// An agent's answer-quality record: store/score/<agent>.json, one array of
// lines, appended one commit per write. The scorer (fdc-agent-be-spring)
// writes a machine line per question each time it scores; a person writes a
// human line (a 0~100 score for one question). The skill md is left alone.
import { readJson, commitFiles, isValidId, revOfPath } from "../store.mjs";
import { VERIFY_KINDS } from "../../src/verify-set.mjs";
import { priorityOf } from "./docs.mjs";

const KINDS = new Set(VERIFY_KINDS.map((k) => k.key));
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const MAX_LINES = 500;

const recordPath = (agent) => `score/${agent}.json`;

/** Server-local date and time to the second: 2026-10-14T19:30:05. */
export function localSeconds(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isTextOrNull = (v) => v === undefined || v === null || typeof v === "string";
const isTextList = (v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string"));

/**
 * One submitted line checked and completed. A human line takes its `by` and
 * `at` from the request, not the body.
 * @returns {{line?: object, error?: string}}
 */
function lineOf(raw, agent, user, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "줄은 객체입니다" };
  if (!KINDS.has(raw.kind)) return { error: `kind 는 ${[...KINDS].join(" · ")} 가운데 하나입니다` };
  if (!isText(raw.question)) return { error: "question 이 비었습니다" };
  const head = { agent, kind: raw.kind, question: raw.question };
  if (raw.human !== undefined) {
    if (raw.machine !== undefined) return { error: "한 줄에 machine 과 human 을 같이 두지 않습니다" };
    if (user.role === "agent") return { error: "사람 점수는 사람 계정만 적습니다" };
    const score = raw.human?.score;
    if (!Number.isInteger(score) || score < 0 || score > 100) return { error: "human.score 는 0~100 정수입니다" };
    return { line: { at: now, ...head, human: { score, by: user.id, at: now } } };
  }
  const m = raw.machine;
  if (!m || typeof m !== "object" || typeof m.answered !== "boolean")
    return { error: "machine.answered(참/거짓)가 있어야 합니다" };
  if (!isTextOrNull(m.reason) || !isTextOrNull(m.detail) || !isTextList(m.sql) || !isTextList(m.pieces))
    return { error: "machine 의 reason · detail 은 글, sql · pieces 는 글 목록입니다" };
  if (!(typeof raw.at === "string" && AT.test(raw.at))) return { error: "at 은 2026-10-14T19:30:05 꼴입니다" };
  if (!isText(raw.model) || !isText(raw.mdRev)) return { error: "model · mdRev 가 있어야 합니다" };
  const s = raw.score;
  if (!s || typeof s !== "object" || !(s.g === null || typeof s.g === "number") || typeof s.a !== "number"
    || !Number.isInteger(s.percent))
    return { error: "score 는 { g(수 또는 null), a(수), percent(정수) } 입니다" };
  const machine = { answered: m.answered, reason: m.reason ?? null, detail: m.detail ?? null };
  if (m.sql) machine.sql = m.sql;
  if (m.pieces) machine.pieces = m.pieces;
  const score = { g: s.g, a: s.a, percent: s.percent };
  if (typeof s.band === "string") score.band = s.band;
  return { line: { at: raw.at, ...head, model: raw.model, mdRev: raw.mdRev, machine, score } };
}

export function registerScoreRoutes(app) {
  const { storeDir, queue } = app.akg;

  const agentOf = (request, reply) => {
    const { agent } = request.params;
    if (!isValidId(agent)) {
      reply.code(400).send({ error: "invalid_path_param", param: "agent" });
      return null;
    }
    const skill = readJson(storeDir, `domain-skill/${agent}.json`);
    if (!skill || skill.status === "archived") {
      reply.code(404).send({ error: "agent_not_found" });
      return null;
    }
    return agent;
  };

  // `since` keeps the lines at or after that second (the record is in time order).
  app.get(
    "/api/score/:agent",
    { config: { roles: ["viewer"], anonOk: true } },
    async (request, reply) => {
      const agent = agentOf(request, reply);
      if (!agent) return reply;
      const since = request.query?.since;
      if (since !== undefined && !AT.test(since))
        return reply.code(400).send({ error: "invalid_since", message: "since 는 2026-10-14T19:30:05 꼴입니다" });
      const lines = readJson(storeDir, recordPath(agent)) ?? [];
      return {
        lines: since ? lines.filter((l) => l.at >= since) : lines,
        rev: revOfPath(storeDir, recordPath(agent)),
      };
    },
  );

  app.post(
    "/api/score/:agent",
    { config: { roles: ["editor", "agent"] } },
    async (request, reply) => {
      const agent = agentOf(request, reply);
      if (!agent) return reply;
      const raw = request.body?.lines;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_LINES)
        return reply.code(400).send({ error: "lines_required", message: `lines 는 1~${MAX_LINES} 줄입니다` });
      const now = localSeconds();
      const lines = [];
      const rejected = [];
      raw.forEach((r, index) => {
        const { line, error } = lineOf(r, agent, request.user, now);
        if (error) rejected.push({ index, error });
        else lines.push(line);
      });
      if (rejected.length) return reply.code(400).send({ error: "lines_rejected", rejected });

      const result = await queue.enqueue(
        async () => {
          const relpath = recordPath(agent);
          const all = [...(readJson(storeDir, relpath) ?? []), ...lines];
          const human = lines.some((l) => l.human);
          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: `score ${agent}: ${human ? "사람 점수" : "기계 판정"} ${lines.length}줄`,
            writes: [{ relpath, content: JSON.stringify(all, null, 2) + "\n" }],
          });
          return { status: 201, body: { rev, added: lines.length } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}
