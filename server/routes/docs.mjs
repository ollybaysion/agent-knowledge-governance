// §6 document CRUD: GET list/single, POST create, PUT edit (S4/S5/S6), PUT catalog.
import { validateDocument } from "../../src/envelope.mjs";
import {
  readJson,
  readText,
  revOfPath,
  readJsonAtRev,
  listIds,
} from "../store.mjs";
import { persistDoc, archiveDoc } from "../render-store.mjs";
import { listSlotAddresses, tierSummary, getSlot } from "../slots.mjs";
import { applyEdit, EditError } from "../edit.mjs";
import { resolveConflict } from "../conflict.mjs";

const DOC_TYPES = ["db-schema", "msg-format", "domain-skill"];

function mdRelPath(type, doc) {
  if (type === "domain-skill")
    return `rendered/domain-skill/${doc.body.name}/SKILL.md`;
  return `rendered/${type}/docs/${doc.id}.md`;
}

function priorityOf(user) {
  return user.role === "agent" ? "agent" : "human";
}

export function registerDocsRoutes(app) {
  const { storeDir, refs, queue } = app.akg;

  app.get("/api/docs", { config: { roles: ["viewer"] } }, async (request) => {
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
  });

  app.get(
    "/api/docs/:type/:id",
    { config: { roles: ["viewer"] } },
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
        return reply.send(readText(storeDir, mdRelPath(type, doc)) ?? "");
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
        md: readText(storeDir, mdRelPath(type, doc)),
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
      const errors = validateDocument(doc, refs);
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
          const errors = validateDocument(newDoc, refs);
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
          const errors = validateDocument(newDoc, refs);
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

  // §6 DELETE — soft archive (status: archived): dropped from the compiled
  // injection index, but the JSON + git history are preserved.
  app.delete(
    "/api/docs/:type/:id",
    { config: { roles: ["approver"] } },
    async (request, reply) => {
      const { type, id } = request.params;
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
}

export { DOC_TYPES, mdRelPath, priorityOf, listSlotAddresses };
