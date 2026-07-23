// §6 document CRUD: GET list/single, POST create, POST batch (#12), PUT edit
// (S4/S5/S6), PUT facts (#12), PUT catalog.
import { validateForStore } from "../../src/envelope.mjs";
import {
  readJson,
  readText,
  revOfPath,
  readJsonAtRev,
  listIds,
  commitFiles,
  isValidId,
} from "../store.mjs";
import {
  persistDoc,
  archiveDoc,
  purgeDoc,
  renderDocMd,
  docWrites,
} from "../render-store.mjs";
import { listSlotAddresses, tierSummary, getSlot } from "../slots.mjs";
import { applyEdit, EditError } from "../edit.mjs";
import { mergeFacts } from "../facts.mjs";
import { resolveConflict } from "../conflict.mjs";

const DOC_TYPES = ["db-schema", "msg-format", "domain-skill"];

function mdRelPath(type, doc) {
  if (type === "domain-skill")
    return `rendered/domain-skill/${doc.body.name}/SKILL.md`;
  return `rendered/${type}/docs/${doc.id}.md`;
}

// Published md if there is one, otherwise rendered on the spot. Only an active
// doc has a file in rendered/ (issue #7), and a doc nobody can preview is a doc
// nobody can judge — which would make the inactive state unusable in the very
// review it exists to enable.
function docMd(storeDir, type, doc) {
  const stored = readText(storeDir, mdRelPath(type, doc));
  if (stored != null) return stored;
  // An inactive draft has no stored md and its body may be too incomplete to
  // render — the dashboard builds the doc view from the JSON, not this md, so a
  // failed render is not fatal. (Active docs always have a stored md, so they
  // never reach this render path.)
  try {
    return renderDocMd(type, doc);
  } catch {
    return null;
  }
}

function priorityOf(user) {
  return user.role === "agent" ? "agent" : "human";
}

export function registerDocsRoutes(app) {
  const { storeDir, refs, queue } = app.akg;

  app.get(
    "/api/docs",
    { config: { roles: ["viewer"], anonOk: true } },
    async (request) => {
      const { type, tier, q } = request.query ?? {};
      const types = type ? [type] : DOC_TYPES;
      const docs = [];
      for (const t of types) {
        const bodySchema = refs[`${t}/v1`];
        if (!bodySchema) continue;
        for (const id of listIds(storeDir, t)) {
          const doc = readJson(storeDir, `${t}/${id}.json`);
          if (!doc) continue;
          if (q && !id.includes(q)) continue;
          const tiers = tierSummary(bodySchema, doc.body);
          if (tier && !tiers[tier]) continue;
          docs.push({
            type: t,
            id,
            status: doc.status,
            tiers,
            keywords: doc.keywords,
            rev: revOfPath(storeDir, `${t}/${id}.json`),
          });
        }
      }
      return { docs };
    },
  );

  app.get(
    "/api/docs/:type/:id",
    { config: { roles: ["viewer"], anonOk: true } },
    async (request, reply) => {
      const { type, id } = request.params;
      const relpath = `${type}/${id}.json`;
      const doc = readJson(storeDir, relpath);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      const rev = revOfPath(storeDir, relpath);

      if (request.query?.format === "md") {
        if (rev && request.headers["if-none-match"] === rev)
          return reply.code(304).send();
        if (rev) reply.header("etag", rev);
        reply.type("text/markdown; charset=utf-8");
        return reply.send(docMd(storeDir, type, doc) ?? "");
      }
      if (rev) reply.header("etag", rev);
      const bodySchema = refs[`${type}/v1`];
      const slots = bodySchema
        ? listSlotAddresses(bodySchema, doc.body).map((address) => ({
            address,
            ...getSlot(doc.body, address),
          }))
        : [];
      return {
        json: doc,
        md: docMd(storeDir, type, doc),
        rev,
        tiers: bodySchema ? tierSummary(bodySchema, doc.body) : {},
        slots,
      };
    },
  );

  app.post(
    "/api/docs/:type",
    { config: { roles: ["editor"] } },
    async (request, reply) => {
      const { type } = request.params;
      const schemaId = `${type}/v1`;
      const bodySchema = refs[schemaId];
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const submitted = request.body;
      if (!submitted || submitted.schema !== schemaId) {
        return reply
          .code(400)
          .send({ error: "schema_mismatch", expected: schemaId });
      }
      // No write path may create `confirmed` directly (D4) — including a
      // fresh document. Route the submitted body through the same slot
      // resolver PUT uses, with an empty base, before it ever touches disk.
      let resolvedBody;
      try {
        resolvedBody = applyEdit(
          bodySchema,
          null,
          submitted.body,
          request.user.id,
          new Date().toISOString(),
        );
      } catch (err) {
        if (err instanceof EditError)
          return reply
            .code(400)
            .send({ error: "edit_rejected", message: err.message });
        throw err;
      }
      const doc = { ...submitted, body: resolvedBody };
      const errors = validateForStore(doc, refs);
      if (errors.length)
        return reply
          .code(400)
          .send({ error: "validation_failed", details: errors });

      const relpath = `${type}/${doc.id}.json`;
      const result = await queue.enqueue(
        async () => {
          if (readJson(storeDir, relpath))
            return { status: 409, body: { error: "already_exists" } };
          const rev = persistDoc(storeDir, type, doc, {
            author: request.user.id,
            message: `create ${type}/${doc.id}`,
          });
          return { status: 201, body: { rev, json: doc } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.put(
    "/api/docs/:type/:id",
    { config: { roles: ["editor"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const bodySchema = refs[`${type}/v1`];
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const clientBody = request.body;

      const result = await queue.enqueue(
        async () => {
          // S5: rev re-validation happens HERE, inside the worker, right before commit.
          const relpath = `${type}/${id}.json`;
          const currentDoc = readJson(storeDir, relpath);
          if (!currentDoc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);

          const baseDoc =
            ifMatch === currentRev
              ? currentDoc
              : readJsonAtRev(storeDir, relpath, ifMatch);
          if (!baseDoc) {
            return {
              status: 409,
              body: {
                error: "unknown_base_rev",
                currentRev,
                current: currentDoc,
              },
            };
          }

          const now = new Date().toISOString();
          let outcome;
          try {
            outcome = resolveConflict(
              bodySchema,
              baseDoc.body,
              currentDoc.body,
              clientBody,
              request.user.id,
              now,
            );
          } catch (err) {
            if (err instanceof EditError)
              return {
                status: 400,
                body: { error: "edit_rejected", message: err.message },
              };
            throw err;
          }
          if (outcome.conflict) {
            return {
              status: 409,
              body: {
                error: "slot_conflict",
                overlap: outcome.overlap,
                current: currentDoc,
                currentRev,
              },
            };
          }

          let mergedBody = outcome.mergedBody;
          if (!outcome.rebased) {
            // Fast path (current === base): still route through applyEdit so
            // demotion/evidence rules apply uniformly.
            try {
              mergedBody = applyEdit(
                bodySchema,
                currentDoc.body,
                clientBody,
                request.user.id,
                now,
              );
            } catch (err) {
              if (err instanceof EditError)
                return {
                  status: 400,
                  body: { error: "edit_rejected", message: err.message },
                };
              throw err;
            }
          }

          const newDoc = { ...currentDoc, body: mergedBody };
          const errors = validateForStore(newDoc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: `edit ${type}/${id}`,
          });
          return {
            status: 200,
            body: { rev, json: newDoc, rebased: outcome.rebased },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // Issue #12 R3 — N documents, one commit. The point of the route is that an
  // import cannot reach a prompt: everything it creates lands inactive, so the
  // decision to inject stays where #7 put it, with an approver.
  app.post(
    "/api/docs/:type/batch",
    { config: { roles: ["editor", "agent"] } },
    async (request, reply) => {
      const { type } = request.params;
      const schemaId = `${type}/v1`;
      const bodySchema = refs[schemaId];
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const submitted = request.body?.docs;
      if (!Array.isArray(submitted) || submitted.length === 0)
        return reply.code(400).send({ error: "docs_required" });
      const runId = request.body?.runId;
      if (runId !== undefined && !/^[\w.:-]{1,64}$/.test(runId))
        return reply.code(400).send({ error: "invalid_run_id" });

      const now = new Date().toISOString();
      const docs = [];
      const rejected = [];
      const seen = new Set();
      for (const [i, raw] of submitted.entries()) {
        const at = { index: i, id: raw?.id };
        if (!raw || raw.schema !== schemaId) {
          rejected.push({ ...at, error: "schema_mismatch" });
          continue;
        }
        if (!isValidId(raw.id)) {
          rejected.push({ ...at, error: "invalid_id" });
          continue;
        }
        // Two entries writing the same file in one commit would silently
        // leave whichever came last, with no record that the other existed.
        if (seen.has(raw.id)) {
          rejected.push({ ...at, error: "duplicate_in_batch" });
          continue;
        }
        seen.add(raw.id);
        let body;
        try {
          body = applyEdit(bodySchema, null, raw.body, request.user.id, now);
        } catch (err) {
          if (err instanceof EditError) {
            rejected.push({
              ...at,
              error: "edit_rejected",
              message: err.message,
            });
            continue;
          }
          throw err;
        }
        const doc = { ...raw, status: "inactive", body };
        const errors = validateForStore(doc, refs);
        if (errors.length) {
          rejected.push({ ...at, error: "validation_failed", details: errors });
          continue;
        }
        docs.push(doc);
      }

      // All or nothing. A partially applied import leaves the caller to work
      // out which half landed, and the whole reason to batch is one commit.
      if (rejected.length)
        return reply.code(400).send({ error: "batch_rejected", rejected });

      const result = await queue.enqueue(
        async () => {
          const existing = docs
            .filter((d) => readJson(storeDir, `${type}/${d.id}.json`))
            .map((d) => d.id);
          if (existing.length)
            return {
              status: 409,
              body: { error: "already_exists", ids: existing },
            };

          // docWrites recompiles the index per document, so N documents mean N
          // writes to the same index path. Keyed by relpath, last wins — which
          // is the same file either way, since nothing in a batch is active
          // and compileIndex only ever lists active documents.
          const byPath = new Map();
          const removes = [];
          for (const doc of docs) {
            const w = docWrites(storeDir, type, doc);
            for (const write of w.writes) byPath.set(write.relpath, write);
            removes.push(...w.removes);
          }
          const writes = [...byPath.values()];
          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: `batch create ${docs.length} ${type}${runId ? ` (${runId})` : ""}`,
            writes,
            removes,
          });
          return {
            status: 201,
            body: { rev, created: docs.map((d) => d.id), status: "inactive" },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // Issue #12 R4 — the type-agnostic form of catalog-push, with upsert.
  // Facts go in verbatim; slot values survive at their addresses; addresses
  // the new facts no longer have follow the orphan rule catalog-push set.
  // Same roles as catalog-push: the boundary that matters is facts vs slots,
  // not who is holding the token (issue #12, §7-2).
  app.put(
    "/api/docs/:type/:id/facts",
    { config: { roles: ["editor", "agent"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const schemaId = `${type}/v1`;
      const bodySchema = refs[schemaId];
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const submitted = request.body;
      if (!submitted || typeof submitted !== "object")
        return reply.code(400).send({ error: "invalid_body" });

      const result = await queue.enqueue(
        async () => {
          const relpath = `${type}/${id}.json`;
          const current = readJson(storeDir, relpath);
          const now = new Date().toISOString();
          const { body, orphans } = mergeFacts(
            bodySchema,
            current?.body ?? null,
            submitted.body ?? submitted,
            { by: `deprecate:facts-push`, at: now },
          );

          // Creating: land inactive, like every other bulk path (#7). An
          // existing document keeps whatever status it already had — pushing
          // facts is not a decision to change what is injected.
          const doc = current
            ? { ...current, body }
            : {
                schema: schemaId,
                id,
                keywords: submitted.keywords ?? [],
                status: "inactive",
                body,
              };
          const errors = validateForStore(doc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          const rev = persistDoc(storeDir, type, doc, {
            author: request.user.id,
            message: `facts-push ${type}/${id}`,
          });
          return {
            status: current ? 200 : 201,
            body: { rev, json: doc, orphans, created: !current },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.put(
    "/api/docs/db-schema/:id/catalog",
    { config: { roles: ["editor", "agent"] } },
    async (request, reply) => {
      const { id } = request.params;
      const relpath = `db-schema/${id}.json`;
      const newCatalog = request.body;

      const result = await queue.enqueue(
        async () => {
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };

          const knownCols = new Set(
            (newCatalog?.columns ?? []).map((c) => c.name),
          );
          const columnDescs = { ...doc.body.columnDescs };
          const now = new Date().toISOString();
          for (const name of Object.keys(columnDescs)) {
            if (knownCols.has(name)) continue;
            const slot = columnDescs[name];
            if (slot.tier === "scaffold")
              delete columnDescs[name]; // never-annotated slot for a vanished column: drop
            else
              columnDescs[name] = {
                ...slot,
                tier: "deprecated",
                by: "deprecate:catalog-push",
                at: now,
              };
          }
          for (const name of knownCols) {
            if (!(name in columnDescs))
              columnDescs[name] = { text: null, tier: "scaffold" };
          }

          const newDoc = {
            ...doc,
            body: { ...doc.body, catalog: newCatalog, columnDescs },
          };
          const errors = validateForStore(newDoc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          const rev = persistDoc(storeDir, "db-schema", newDoc, {
            author: request.user.id,
            message: `catalog-push db-schema/${id}`,
          });
          return { status: 200, body: { rev, json: newDoc } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // Issue #7 — the active/inactive transition. Bulk-loaded docs land inactive:
  // fully readable through this API, but absent from rendered/ and the index,
  // so they never reach a mirror or compete for an injection slot. Turning one
  // on is an approver decision, the same rule D4 puts on promoting a slot —
  // both are a human accepting responsibility for what enters a prompt.
  for (const [action, target] of [
    ["activate", "active"],
    ["deactivate", "inactive"],
  ]) {
    app.post(
      `/api/docs/:type/:id/${action}`,
      { config: { roles: ["approver"] } },
      async (request, reply) => {
        const { type, id } = request.params;
        if (!refs[`${type}/v1`])
          return reply.code(400).send({ error: "unknown_type" });
        const ifMatch = request.headers["if-match"];
        if (!ifMatch)
          return reply.code(428).send({ error: "if_match_required" });

        const result = await queue.enqueue(
          async () => {
            const relpath = `${type}/${id}.json`;
            const doc = readJson(storeDir, relpath);
            if (!doc) return { status: 404, body: { error: "not_found" } };
            // S5: revalidate the rev inside the worker, right before committing.
            const currentRev = revOfPath(storeDir, relpath);
            if (ifMatch !== currentRev)
              return {
                status: 409,
                body: { error: "unknown_base_rev", currentRev, current: doc },
              };

            // Archiving is a decision to stop carrying the doc at all; coming
            // back from it is not this route's business.
            if (doc.status === "archived")
              return { status: 400, body: { error: "doc_archived" } };
            // Idempotent: committing an identical tree would fail in git.
            if (doc.status === target)
              return {
                status: 200,
                body: { rev: currentRev, unchanged: true },
              };

            const newDoc = { ...doc, status: target };
            const errors = validateForStore(newDoc, refs);
            if (errors.length)
              return {
                status: 400,
                body: { error: "validation_failed", details: errors },
              };

            const rev = persistDoc(storeDir, type, newDoc, {
              author: request.user.id,
              message: `${action} ${type}/${id}`,
            });
            return { status: 200, body: { rev, json: newDoc } };
          },
          { priority: priorityOf(request.user) },
        );
        return reply.code(result.status).send(result.body);
      },
    );
  }

  // §6 DELETE — soft archive (status: archived): dropped from the compiled
  // injection index, but the JSON + git history are preserved.
  app.delete(
    "/api/docs/:type/:id",
    { config: { roles: ["approver"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      // S11: 파라미터가 그대로 경로가 된다 — Fastify 는 %2F 를 디코드하므로
      // (proposals pid 순회, §13-1 과 같은 부류) 경로 조립 전에 형식을 거부.
      if (!isValidId(type) || !isValidId(id))
        return reply.code(404).send({ error: "not_found" });
      const result = await queue.enqueue(
        async () => {
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const rev = archiveDoc(storeDir, type, doc, {
            author: request.user.id,
            message: `archive ${type}/${id}`,
          });
          return { status: 200, body: { rev } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // 2단계 삭제의 2단(사용자 결정 2026-07-24): archived 문서를 store 트리에서
  // 제거한다. HEAD 에서 파일이 사라져 목록·API 에서 완전히 없어지고, git
  // 이력에는 감사 기록으로만 남는다(이력 소거는 API 로 열지 않는다 — 감사
  // 설계와 충돌). archived 에서만 허용: 1단(보관)이 실수 방지 게이트다.
  app.post(
    "/api/docs/:type/:id/purge",
    { config: { roles: ["approver"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      // 신설 표면이라 더 엄격히: 대시보드가 다루는 타입 화이트리스트 + id 형식
      // 검증을 경로 조립 전에 (S11, §13-1 부류 차단).
      if (!DOC_TYPES.includes(type) || !isValidId(id))
        return reply.code(404).send({ error: "not_found" });
      const result = await queue.enqueue(
        async () => {
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          if (doc.status !== "archived")
            return { status: 409, body: { error: "not_archived" } };
          const rev = purgeDoc(storeDir, type, doc, {
            author: request.user.id,
            message: `purge ${type}/${id}`,
          });
          return { status: 200, body: { rev } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}

export { DOC_TYPES, mdRelPath, priorityOf, listSlotAddresses };
