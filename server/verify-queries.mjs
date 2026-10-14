import { skillDataIds } from "../src/skill-data-ids.mjs";
import { isEqpBind, START_TIME, END_TIME, varsOf } from "../src/sql-bind.mjs";
import { knowledgePaths } from "../src/verify-set.mjs";
import { listIds, readJson } from "./store.mjs";

const SKILL = "domain-skill";

const skillLinks = (doc) =>
  (doc.links ?? []).filter((l) => l?.type === SKILL && typeof l.id === "string").map((l) => l.id.trim());

/**
 * The active skills a link or two away from `selfId`, links counted both
 * ways — the consumer's LINK1 and LINK2 (KnowledgeService.tiers) — each in
 * store order.
 * @returns {{link1: {id: string, markdown: string}[], link2: {id: string, markdown: string}[]}}
 */
export function linkedSkills(storeDir, selfId, selfDoc) {
  const active = new Map();
  for (const id of listIds(storeDir, SKILL)) {
    if (id === selfId) continue;
    let doc;
    try {
      doc = readJson(storeDir, `${SKILL}/${id}.json`);
    } catch {
      continue;
    }
    if (doc && doc.status === "active" && typeof doc.body?.markdown === "string") active.set(id, doc);
  }
  const links = new Map(); // id -> ids linked either way
  const join = (a, b) => {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) links.set(x, (links.get(x) ?? new Set()).add(y));
  };
  for (const [id, doc] of [[selfId, selfDoc], ...active]) for (const to of skillLinks(doc)) join(id, to);
  const near = links.get(selfId) ?? new Set();
  const far = new Set([...near].flatMap((id) => [...(links.get(id) ?? [])]));
  const pick = (ids) => [...active].filter(([id]) => ids.has(id)).map(([id, doc]) => ({ id, markdown: doc.body.markdown }));
  return { link1: pick(near), link2: pick(new Set([...far].filter((id) => !near.has(id)))) };
}

/**
 * The knowledge pieces a 일반 지식 정답 can name: `own`'s, then the LINK1 and
 * LINK2 skills' — the consumer's reachableDocuments — each skill's paths as
 * knowledgePaths reads them. A piece id is `<skill>/<path>`.
 * @returns {{skill: string, tier: "own"|"link1"|"link2", paths: string[]}[]}
 */
export function pieceChoices(own, { link1, link2 }) {
  return [
    { skill: own.id, tier: "own", paths: knowledgePaths(own.markdown) },
    ...link1.map((s) => ({ skill: s.id, tier: "link1", paths: knowledgePaths(s.markdown) })),
    ...link2.map((s) => ({ skill: s.id, tier: "link2", paths: knowledgePaths(s.markdown) })),
  ];
}

/** Every piece id of pieceChoices, for the 정답 check. */
export const pieceIds = (choices) => new Set(choices.flatMap((c) => c.paths.map((p) => `${c.skill}/${p}`)));

const EXAMPLE = /예\s*[:：]\s*([^\s),·]+)/;

/**
 * The queries a verification-set question can name for `own`: its `## 데이터`
 * queries, then each linked skill's, first id wins — the consumer's
 * reachableQueries. Each bind says where its value comes from: the 설정's
 * 설비 (eqp binds), its 기간 (start_time · end_time), or a person (ask), with
 * the ASK item of that id — the query's skill first, then `own`'s.
 * @param {{id: string, markdown: string}} own
 * @param {{id: string, markdown: string}[]} linked
 */
export function queryChoices(own, linked) {
  const items = new Map([own, ...linked].map((s) => [s.id, skillDataIds(s.markdown)]));
  const askOf = (skill, name) =>
    [skill, own.id].map((id) => items.get(id).find((d) => !d.query && d.id === name)).find(Boolean);
  const seen = new Set();
  const out = [];
  for (const [skill, list] of items) {
    for (const d of list) {
      if (!d.query || !d.sql || seen.has(d.id)) continue;
      seen.add(d.id);
      const binds = varsOf(d.sql).map((name) => {
        const lower = name.toLowerCase();
        if (isEqpBind(name)) return { name, from: "eqp" };
        if (lower === START_TIME) return { name, from: "start" };
        if (lower === END_TIME) return { name, from: "end" };
        const ask = askOf(skill, name);
        if (!ask) return { name, from: "ask" };
        const example = EXAMPLE.exec(`${ask.text ?? ""}\n${ask.ask ?? ""}`)?.[1] ?? null;
        return {
          name, from: "ask",
          title: ask.title?.replace(/\s+@[A-Za-z][A-Za-z0-9_]*$/, "") ?? null,
          question: ask.ask ?? ask.text, text: ask.text, example,
        };
      });
      out.push({ skill, id: d.id, title: d.title?.replace(/\s+@[A-Za-z][A-Za-z0-9_]*$/, "") ?? null, sql: d.sql, binds });
    }
  }
  return out;
}
