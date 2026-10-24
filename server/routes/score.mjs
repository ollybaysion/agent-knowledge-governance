// An agent's answer-quality record: store/score/<agent>.json, an array of
// score-record/v1 lines, appended one commit per write. The scorer (fdc-agent-be-spring)
// writes a machine line per question each time it scores; a person writes a
// human line (a 0~100 score for one question). The skill md is left alone.
import { readJson, commitFiles, isValidId, revOfPath } from "../store.mjs";
import { validateNode } from "../../src/validate.mjs";
import { priorityOf } from "./docs.mjs";

const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const MAX_LINES = 500;

const recordPath = (agent) => `score/${agent}.json`;

/** Server-local date and time to the second: 2026-10-14T19:30:05. */
export function localSeconds(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/**
 * One submitted line as a score-record/v1 line. A human line takes its `by`
 * and `at` from the request, not the body; a machine line keeps the scorer's.
 * @returns {{line?: object, errors?: string[]}}
 */
function lineOf(raw, agent, user, now, schema) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { errors: ["줄은 객체입니다"] };
  let line;
  if (raw.human !== undefined) {
    if (raw.machine !== undefined || raw.run !== undefined) return { errors: ["사람 줄에는 machine · run 을 두지 않습니다"] };
    if (user.group === "agent") return { errors: ["사람 점수는 사람 계정만 적습니다"] };
    line = { agent, kind: raw.kind, text: raw.text, at: now, human: { score: raw.human?.score, by: user.id, at: now } };
  } else {
    if (raw.machine === undefined || raw.run === undefined || raw.model === undefined || raw.mdRev === undefined)
      return { errors: ["기계 줄에는 machine · run · model · mdRev 가 있어야 합니다"] };
    line = { ...raw, agent };
  }
  const errors = [];
  validateNode(schema, line, "$", {}, errors);
  return errors.length ? { errors } : { line };
}

export function registerScoreRoutes(app) {
  const { storeDir, queue, contracts } = app.akg;
  const schema = contracts["score-record/v1"];

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
    { config: { roles: ["user", "agent"] } },
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
    { config: { roles: ["admin", "agent"] } },
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
        const { line, errors } = lineOf(r, agent, request.user, now, schema);
        if (errors) rejected.push({ index, errors });
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
