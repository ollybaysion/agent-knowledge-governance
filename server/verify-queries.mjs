import { skillDataIds } from "../src/skill-data-ids.mjs";
import { isEqpBind, START_TIME, END_TIME, varsOf } from "../src/sql-bind.mjs";
import { listIds, readJson } from "./store.mjs";

const SKILL = "domain-skill";

const skillLinks = (doc) =>
  (doc.links ?? []).filter((l) => l?.type === SKILL && typeof l.id === "string").map((l) => l.id.trim());

/**
 * The active skills one link away from `selfId`, either direction — the
 * consumer's LINK1 (KnowledgeService.tiers) — in store order.
 * @returns {{id: string, markdown: string}[]}
 */
export function linkedSkills(storeDir, selfId, selfDoc) {
  const mine = new Set(skillLinks(selfDoc));
  const out = [];
  for (const id of listIds(storeDir, SKILL)) {
    if (id === selfId) continue;
    let doc;
    try {
      doc = readJson(storeDir, `${SKILL}/${id}.json`);
    } catch {
      continue;
    }
    if (!doc || doc.status !== "active" || typeof doc.body?.markdown !== "string") continue;
    if (mine.has(id) || skillLinks(doc).includes(selfId)) out.push({ id, markdown: doc.body.markdown });
  }
  return out;
}

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
