// 정리: 중복 후보와 흡수 기록 (server/curation.mjs 가 저장 꼴을 적는다).
// The curator writes them with an agent token; a person reads them on the
// 정리 tab, and an admin decides: a pair is dismissed or resolved, an
// absorption is reverted.
import { randomUUID } from "node:crypto";
import { dataIdConflicts, validateForStore } from "../../src/envelope.mjs";
import { saveCheck } from "../../src/flow/agent-md.mjs";
import { errorReport } from "../../src/flow/flow-error.mjs";
import { commitFiles, hasAsset, listIds, readJson, readJsonAtRev, revOfPath } from "../store.mjs";
import { absorbedPath, docWrites } from "../render-store.mjs";
import { applyEdit, EditError } from "../edit.mjs";
import { mergeBodyLinks } from "../links.mjs";
import { agentRegistry, dataIdOwners } from "../data-ids.mjs";
import {
  ABSORPTION_STATUSES,
  PAIR_STATUSES,
  PAIRS_DIR,
  ABSORPTIONS_DIR,
  absorptionPath,
  pairPath,
  parseKey,
  readAbsorptionBody,
  readPairsBody,
  sightPair,
  stableJson,
} from "../curation.mjs";
import { priorityOf } from "./docs.mjs";

const docPath = (d) => `${d.type}/${d.id}.json`;
const short = (rev) => rev.slice(0, 7);

export function registerCurationRoutes(app) {
  const { storeDir, refs, queue, types, catalog } = app.akg;
  const inStore = {
    assetExists: (sha256) => hasAsset(storeDir, sha256),
    dataIdOwners: (selfId, selfType) => dataIdOwners(storeDir, selfId, selfType),
    get mdTypes() {
      return types.mdIds();
    },
  };

  // A side of a pair or record as the list serves it: the stored address and
  // rev, and the document as it stands now.
  const docNow = (d) => {
    const entry = types.bodySchema(d.type) ? catalog.get(d.type, d.id) : null;
    return {
      ...d,
      exists: !!entry,
      title: entry?.title ?? null,
      status: entry?.status ?? null,
      currentRev: entry ? revOfPath(storeDir, docPath(d)) : null,
    };
  };
  const pairView = (pair) => ({ ...pair, a: docNow(pair.a), b: docNow(pair.b) });
  const absorptionView = (rec) => {
    const source = docNow(rec.source);
    const target = docNow(rec.target);
    const mark = source.exists ? catalog.get(rec.source.type, rec.source.id)?.absorbed : null;
    return {
      ...rec,
      source: { ...source, marked: mark?.rev === rec.source.rev },
      target,
      revertable: rec.status === "applied" && target.exists && target.currentRev === rec.target.toRev,
    };
  };
  const readAll = (dir) => listIds(storeDir, dir).map((name) => readJson(storeDir, `${dir}/${name}.json`)).filter(Boolean);

  // ---------- 중복 후보 ----------

  app.post("/api/curation/duplicates", { config: { roles: ["admin", "agent"] } }, async (request, reply) => {
    const read = readPairsBody(request.body);
    if (read.error) return reply.code(400).send(read.rejected ? { error: read.error, rejected: read.rejected } : { error: read.error });
    const { runId, model, pairs } = read;
    const result = await queue.enqueue(
      async () => {
        const at = new Date().toISOString();
        const counts = { opened: 0, updated: 0, kept: 0 };
        const skipped = [];
        const writes = [];
        for (const seen of pairs) {
          const gone = [seen.a, seen.b].find((d) => !types.bodySchema(d.type) || !catalog.exists(d.type, d.id));
          if (gone) {
            skipped.push({ index: seen.index, key: seen.key, error: "not_found", doc: `${gone.type}/${gone.id}` });
            continue;
          }
          const { outcome, pair } = sightPair(readJson(storeDir, pairPath(seen.key)), seen, { runId, model, at });
          counts[outcome] += 1;
          if (pair) writes.push({ relpath: pairPath(seen.key), content: stableJson(pair) });
        }
        if (writes.length)
          await commitFiles(storeDir, {
            author: request.user.id,
            message: `duplicates ${runId}: 열림 ${counts.opened} · 고침 ${counts.updated} · 그대로 ${counts.kept}`,
            writes,
          });
        return { status: 200, body: { ...counts, skipped } };
      },
      { priority: priorityOf(request.user) },
    );
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/curation/duplicates", { config: { roles: ["user", "agent"] } }, async (request, reply) => {
    const status = request.query?.status;
    if (status !== undefined && !PAIR_STATUSES.includes(status))
      return reply.code(400).send({ error: "invalid_query", param: "status", allowed: PAIR_STATUSES });
    const pairs = readAll(PAIRS_DIR)
      .filter((p) => !status || p.status === status)
      .sort((x, y) => y.score - x.score || (x.key < y.key ? -1 : 1))
      .map(pairView);
    return { pairs };
  });

  // A person's call on a pair. The decision keeps both documents' revs as they
  // stand now: the curator's next sighting at those revs leaves the pair alone.
  for (const [action, status] of [
    ["dismiss", "dismissed"],
    ["resolve", "resolved"],
  ]) {
    app.post(`/api/curation/duplicates/:key/${action}`, { config: { roles: ["admin"] } }, async (request, reply) => {
      const { key } = request.params;
      if (!parseKey(key)) return reply.code(400).send({ error: "invalid_path_param", param: "key" });
      const result = await queue.enqueue(
        async () => {
          const pair = readJson(storeDir, pairPath(key));
          if (!pair) return { status: 404, body: { error: "not_found" } };
          const revs = { a: revOfPath(storeDir, docPath(pair.a)), b: revOfPath(storeDir, docPath(pair.b)) };
          const next = { ...pair, status, decision: { status, by: request.user.id, at: new Date().toISOString(), revs } };
          await commitFiles(storeDir, {
            author: request.user.id,
            message: `${action} duplicate ${key}`,
            writes: [{ relpath: pairPath(key), content: stableJson(next) }],
          });
          return { status: 200, body: { pair: pairView(next) } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    });
  }

  // ---------- 흡수 기록 ----------

  app.post("/api/curation/absorptions", { config: { roles: ["admin", "agent"] } }, async (request, reply) => {
    const read = readAbsorptionBody(request.body);
    if (read.error) return reply.code(400).send(read);
    const { source, target } = read;
    for (const [param, d] of [
      ["source", source],
      ["target", target],
    ])
      if (!types.bodySchema(d.type)) return reply.code(400).send({ error: "unknown_type", param, type: d.type });

    const result = await queue.enqueue(
      async () => {
        // Each rev must be a commit the document was at: revert reads fromRev back.
        for (const [param, d, rev] of [
          ["source.rev", source, source.rev],
          ["target.fromRev", target, target.fromRev],
          ["target.toRev", target, target.toRev],
        ])
          if (!readJsonAtRev(storeDir, docPath(d), rev)) return { status: 400, body: { error: "unknown_rev", param } };
        // A retried POST: the same source rev into the same target rev is one record.
        const same = readAll(ABSORPTIONS_DIR).find(
          (r) =>
            r.source.type === source.type &&
            r.source.id === source.id &&
            r.source.rev === source.rev &&
            r.target.type === target.type &&
            r.target.id === target.id &&
            r.target.toRev === target.toRev,
        );
        if (same) return { status: 200, body: { id: same.id, deduped: true } };
        const id = randomUUID();
        const record = { id, ...read, status: "applied", by: request.user.id, at: new Date().toISOString() };
        await commitFiles(storeDir, {
          author: request.user.id,
          message: `absorption ${source.type}/${source.id} → ${target.type}/${target.id} (${read.runId})`,
          writes: [{ relpath: absorptionPath(id), content: stableJson(record) }],
        });
        return { status: 201, body: { id, absorption: absorptionView(record) } };
      },
      { priority: priorityOf(request.user) },
    );
    return reply.code(result.status).send(result.body);
  });

  app.get("/api/curation/absorptions", { config: { roles: ["user", "agent"] } }, async (request, reply) => {
    const status = request.query?.status;
    if (status !== undefined && !ABSORPTION_STATUSES.includes(status))
      return reply.code(400).send({ error: "invalid_query", param: "status", allowed: ABSORPTION_STATUSES });
    const absorptions = readAll(ABSORPTIONS_DIR)
      .filter((r) => !status || r.status === status)
      .sort((x, y) => (x.at === y.at ? (x.id < y.id ? -1 : 1) : x.at < y.at ? 1 : -1))
      .map(absorptionView);
    return { absorptions };
  });

  // One record with the target's body before (fromRev) and after (toRev):
  // what the 정리 tab's 바뀐 부분 compares.
  app.get("/api/curation/absorptions/:id", { config: { roles: ["user", "agent"] } }, async (request, reply) => {
    const rec = readJson(storeDir, absorptionPath(request.params.id));
    if (!rec) return reply.code(404).send({ error: "not_found" });
    const path = docPath(rec.target);
    return {
      absorption: absorptionView(rec),
      before: readJsonAtRev(storeDir, path, rec.target.fromRev)?.body ?? null,
      after: readJsonAtRev(storeDir, path, rec.target.toRev)?.body ?? null,
    };
  });

  // The target goes back to its fromRev body in a new commit, through the
  // checks a document PUT runs. Someone edited it after the absorption (its
  // rev is not toRev): 409, and the person merges by hand. The source's mark
  // goes when it is still the mark of this absorption.
  app.post("/api/curation/absorptions/:id/revert", { config: { roles: ["admin"] } }, async (request, reply) => {
    const { id } = request.params;
    const result = await queue.enqueue(
      async () => {
        const rec = readJson(storeDir, absorptionPath(id));
        if (!rec) return { status: 404, body: { error: "not_found" } };
        if (rec.status === "reverted") return { status: 409, body: { error: "already_reverted", revert: rec.revert } };
        const { type } = rec.target;
        const bodySchema = types.bodySchema(type);
        const relpath = docPath(rec.target);
        const current = bodySchema ? readJson(storeDir, relpath) : null;
        if (!current)
          return { status: 409, body: { error: "target_missing", message: `${type}/${rec.target.id} 이 그 자리에 없습니다(삭제 또는 재분류)` } };
        if (types.isArchived(type))
          return { status: 409, body: { error: "type_archived", message: `${type} 타입은 닫혀 새 내용을 받지 않습니다` } };
        const currentRev = revOfPath(storeDir, relpath);
        if (currentRev !== rec.target.toRev)
          return {
            status: 409,
            body: {
              error: "target_changed",
              currentRev,
              toRev: rec.target.toRev,
              message: "흡수 뒤 대상 문서가 바뀌었습니다. 이력을 보고 손으로 되돌리세요.",
            },
          };
        const before = readJsonAtRev(storeDir, relpath, rec.target.fromRev);
        if (!before) return { status: 409, body: { error: "unknown_rev", param: "target.fromRev" } };

        let body;
        try {
          body = applyEdit(bodySchema, current.body, before.body, request.user.id, new Date().toISOString());
        } catch (err) {
          if (err instanceof EditError) return { status: 400, body: { error: "edit_rejected", message: err.message } };
          throw err;
        }
        const merged = mergeBodyLinks(catalog, types.ids(), type, current, { ...current, body });
        if (merged.error) return { status: 400, body: merged.error };
        const newDoc = merged.doc;
        const errors = validateForStore(newDoc, refs, inStore);
        if (errors.length) return { status: 400, body: { error: "validation_failed", details: errors } };
        const conflicts = dataIdConflicts(newDoc, inStore.dataIdOwners);
        if (conflicts.length) return { status: 409, body: { error: "data_id_conflict", conflicts } };
        if (type === "domain-skill" || type === "domain") {
          const flow = saveCheck(agentRegistry(storeDir), { type, id: rec.target.id, markdown: newDoc.body?.markdown ?? null, active: newDoc.status === "active" });
          if (flow.errors.length)
            return {
              status: 400,
              body: { error: "flow_rejected", errors: flow.errors, details: flow.errors.map((e) => `$.body.markdown: 플로우 오류 ${errorReport(e)}`) },
            };
        }

        const mark = readJson(storeDir, absorbedPath(rec.source.type, rec.source.id))?.absorbed;
        const unmarked = mark?.rev === rec.source.rev;
        const reverted = { ...rec, status: "reverted", revert: { by: request.user.id, at: new Date().toISOString() } };
        const doc = docWrites(storeDir, type, newDoc);
        const rev = await commitFiles(storeDir, {
          author: request.user.id,
          message: `revert absorption ${id}: ${type}/${rec.target.id} → ${short(rec.target.fromRev)}`,
          writes: [...doc.writes, { relpath: absorptionPath(id), content: stableJson(reverted) }],
          removes: [...doc.removes, ...(unmarked ? [absorbedPath(rec.source.type, rec.source.id)] : [])],
        });
        return { status: 200, body: { rev, unmarked, absorption: absorptionView(reverted) } };
      },
      { priority: priorityOf(request.user) },
    );
    return reply.code(result.status).send(result.body);
  });
}
