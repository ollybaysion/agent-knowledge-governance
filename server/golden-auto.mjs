// Every agent has a golden-set document of its own id. A new domain-skill gets
// one in its own commit; one already in the store gets one at boot. The
// document is the empty template (no question) and lands inactive, like any
// document no person has written yet.
import { goldenTemplate } from "../src/golden-set.mjs";
import { docWrites } from "./render-store.mjs";
import { commitFiles, listIds, readJson } from "./store.mjs";

/** The commit author of the boot-time fill. */
export const GOLDEN_AUTO_AUTHOR = "akg-auto";

export function goldenDocFor(skillId) {
  return {
    schema: "golden-set/v1",
    id: skillId,
    keywords: [{ kw: `${skillId} golden`, inject: "pointer" }],
    status: "inactive",
    links: [{ type: "domain-skill", id: skillId, rel: "skill" }],
    body: { name: skillId, markdown: goldenTemplate(skillId) },
  };
}

/**
 * The writes for the golden sets these skills lack, for the caller to put in
 * its own commit.
 * @returns {{ids: string[], writes: object[], removes: string[]}}
 */
export function missingGoldenWrites(storeDir, skillIds) {
  const out = { ids: [], writes: [], removes: [] };
  for (const id of skillIds) {
    if (readJson(storeDir, `golden-set/${id}.json`)) continue;
    const w = docWrites(storeDir, "golden-set", goldenDocFor(id));
    out.ids.push(id);
    out.writes.push(...w.writes);
    out.removes.push(...w.removes);
  }
  return out;
}

/**
 * One commit with a golden set for every stored skill (not archived) that has
 * none. Null when every skill already has one.
 * @returns {{rev: string, ids: string[]} | null}
 */
export function fillGoldenSets(storeDir) {
  const skills = listIds(storeDir, "domain-skill").filter(
    (id) => readJson(storeDir, `domain-skill/${id}.json`)?.status !== "archived",
  );
  const { ids, writes, removes } = missingGoldenWrites(storeDir, skills);
  if (ids.length === 0) return null;
  const rev = commitFiles(storeDir, {
    author: GOLDEN_AUTO_AUTHOR,
    message: `auto: golden-set 빈 틀 ${ids.length}개 자동 생성 (에이전트마다 하나) — ${ids.join(", ")}`,
    writes,
    removes,
  });
  return { rev, ids };
}
