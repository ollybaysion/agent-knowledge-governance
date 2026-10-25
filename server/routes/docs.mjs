// §6 document CRUD: GET list/single, POST create, POST batch (#12), PUT edit
// (S4/S5/S6), PUT facts (#12), PUT catalog.
import { dataIdConflicts, validateForStore } from "../../src/envelope.mjs";
import { skillDataIds } from "../../src/skill-data-ids.mjs";
import {
  checkVerifySet,
  fromVerificationSet,
  parseVerifySet,
  toVerificationSet,
  VERIFY_SECTION,
  verifySetBody,
  VerifySetError,
} from "../../src/verify-set.mjs";
import { joinSkill, SkillSplitError, splitSkill } from "../../src/skill-sections.mjs";
import { validateNode } from "../../src/validate.mjs";
import {
  readJson,
  readText,
  revOfPath,
  changedAtOfPath,
  readJsonAtRev,
  listIds,
  commitFiles,
  isValidId,
  hasAsset,
} from "../store.mjs";
import {
  persistDoc,
  renderDocMd,
  docsWrites,
} from "../render-store.mjs";
import { docMdPath, rendersToMd } from "../../src/render/index.mjs";
import { listSlotAddresses, tierSummary, getSlot } from "../slots.mjs";
import { applyEdit, EditError } from "../edit.mjs";
import { mergeFacts } from "../facts.mjs";
import { resolveConflict } from "../conflict.mjs";
import {
  backlinksOf,
  mergeBodyLinks,
  missingLinkTargets,
  resolveLinks,
  resolveWikilinks,
  withLinks,
} from "../links.mjs";
import { dataIdOwners } from "../data-ids.mjs";
import { hasGroup } from "../auth.mjs";
import { UNCLASSIFIED } from "../types.mjs";
import { linkedSkills, pieceChoices, pieceIds, queryChoices } from "../verify-queries.mjs";

// Published md if there is one, otherwise rendered on the spot. Only an active
// doc has a file in rendered/ (issue #7), and a doc nobody can preview is a doc
// nobody can judge — which would make the inactive state unusable in the very
// review it exists to enable.
function docMd(storeDir, type, doc, md) {
  const stored = readText(storeDir, docMdPath(type, doc, { md }));
  if (stored != null) return stored;
  // An inactive draft has no stored md and its body may be too incomplete to
  // render — the dashboard builds the doc view from the JSON, not this md, so a
  // failed render is not fatal. (Active docs always have a stored md, so they
  // never reach this render path.)
  try {
    return renderDocMd(type, doc, { md });
  } catch {
    return null;
  }
}

// The name people know a document by, for the dashboard's search: a manual's
// title, a screen's name, a skill's name, a table, a command.
function titleOf(doc) {
  const b = doc.body ?? {};
  return b.title ?? b.name ?? b.table ?? b.command ?? null;
}

// X-AKG-Note: what the editor saved ("절 저장: 도메인 지식"), URI-encoded since a
// header carries no Hangul. One line, no control characters, 80 characters at
// most; anything else is dropped.
export function commitNote(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  let text;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function priorityOf(user) {
  return user.group === "agent" ? "agent" : "human";
}

export function registerDocsRoutes(app) {
  const { storeDir, refs, queue, contracts, types } = app.akg;
  // What the validator needs from the store (a manual's captures, the data
  // ids other skills hold, the md types).
  const inStore = {
    assetExists: (sha256) => hasAsset(storeDir, sha256),
    dataIdOwners: (selfId, selfType) => dataIdOwners(storeDir, selfId, selfType),
    get mdTypes() {
      return types.mdIds();
    },
  };
  // A closed type keeps its documents readable and takes no new content. Run
  // inside the queue, so a type closed a moment earlier is seen.
  const closedType = (type) =>
    types.isArchived(type)
      ? { status: 409, body: { error: "type_archived", message: `${type} 타입은 닫혀 새 내용을 받지 않습니다` } }
      : null;
  const originOf = (doc) => (doc.origin ? { origin: doc.origin } : {});
  // A verification set's 정답 paths the skill md lacks: saved anyway (the
  // author may be renaming a heading), shown beside the document.
  const warningsOf = (type, doc) => {
    if (type !== "domain-skill" || typeof doc.body?.markdown !== "string") return {};
    const { present, warnings } = checkVerifySet(doc.body.markdown, { agent: doc.id, known: knownPieces(doc.id, doc) });
    return present ? { warnings } : {};
  };
  // The piece ids a 정답 can name: this skill's and its linked skills' (LINK1 · LINK2).
  const knownPieces = (id, doc) =>
    pieceIds(pieceChoices({ id, markdown: doc.body?.markdown ?? "" }, linkedSkills(storeDir, id, doc)));
  // Run inside the queue, like already_exists: the other side is in the store.
  const dataIdConflict = (doc) => {
    const conflicts = dataIdConflicts(doc, inStore.dataIdOwners);
    return conflicts.length
      ? { status: 409, body: { error: "data_id_conflict", conflicts } }
      : null;
  };

  const wikilinksOf = (type, doc, typeIds) => {
    const wikilinks = resolveWikilinks(storeDir, typeIds, type, doc).map(({ text, type: t, id, found }) => ({ text, type: t, id, found }));
    return wikilinks.length ? { wikilinks } : {};
  };

  // GET /api/docs/:type/:id's JSON answer.
  const docView = (type, id, doc, rev) => {
    const bodySchema = types.bodySchema(type);
    const typeIds = types.ids();
    return {
      json: doc,
      md: docMd(storeDir, type, doc, types.isMd(type)),
      rev,
      tiers: bodySchema ? tierSummary(bodySchema, doc.body) : {},
      slots: bodySchema
        ? listSlotAddresses(bodySchema, doc.body).map((address) => ({
            address,
            ...getSlot(doc.body, address),
          }))
        : [],
      links: resolveLinks(storeDir, doc.links),
      backlinks: backlinksOf(storeDir, typeIds, type, id),
      wikilinks: resolveWikilinks(storeDir, typeIds, type, doc),
      ...warningsOf(type, doc),
    };
  };

  app.get(
    "/api/docs",
    { config: { roles: ["user", "agent"] } },
    async (request) => {
      const { type, tier, q } = request.query ?? {};
      const docs = [];
      const typeIds = types.ids();
      for (const t of type ? [type] : types.ids()) {
        const bodySchema = types.bodySchema(t);
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
            links: doc.links ?? [],
            title: titleOf(doc),
            ...originOf(doc),
            // what an agent list filters on; absent reads as main
            ...(t === "domain-skill" ? { role: doc.role ?? "main" } : {}),
            rev: revOfPath(storeDir, `${t}/${id}.json`),
            updatedAt: changedAtOfPath(storeDir, `${t}/${id}.json`),
            // The body's [[ ]] with where each points: the graph draws them
            // thin and the unresolved ones as 끊긴 연결.
            ...wikilinksOf(t, doc, typeIds),
          });
        }
      }
      return { docs };
    },
  );

  app.get(
    "/api/docs/:type/:id",
    { config: { roles: ["user", "agent"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      // Only a document type names a document; score/<agent> and
      // assets/<sha> are store files of another shape.
      if (!types.bodySchema(type)) return reply.code(404).send({ error: "not_found" });
      const relpath = `${type}/${id}.json`;
      const doc = readJson(storeDir, relpath);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      const rev = revOfPath(storeDir, relpath);

      if (request.query?.format === "md") {
        if (rev && request.headers["if-none-match"] === rev)
          return reply.code(304).send();
        if (rev) reply.header("etag", rev);
        reply.type("text/markdown; charset=utf-8");
        return reply.send(docMd(storeDir, type, doc, types.isMd(type)) ?? "");
      }
      if (rev) reply.header("etag", rev);
      return docView(type, id, doc, rev);
    },
  );

  // A main skill's verification set as the verification-set/v1 object, read
  // with the parser the save check uses. Cached per document rev.
  // Keyed by the skills' last commit too: the 정답 warnings read the linked skills.
  const verificationSets = new Map(); // id -> {key, set}
  app.get(
    "/api/docs/domain-skill/:id/verification-set",
    { config: { roles: ["user", "agent"] } },
    async (request, reply) => {
      const { id } = request.params;
      const relpath = `domain-skill/${id}.json`;
      const doc = readJson(storeDir, relpath);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      const rev = revOfPath(storeDir, relpath);
      const key = `${rev}:${revOfPath(storeDir, "domain-skill")}:${revOfPath(storeDir, "domain")}`;
      const cached = verificationSets.get(id);
      let set = cached && cached.key === key ? cached.set : undefined;
      if (set === undefined) {
        try {
          set = toVerificationSet(id, doc.body?.markdown ?? "", rev, knownPieces(id, doc));
        } catch (err) {
          if (!(err instanceof VerifySetError)) throw err;
          return reply.code(422).send({ error: "invalid_verification_set", details: err.errors });
        }
        verificationSets.set(id, { key, set });
      }
      if (set === null) return reply.code(404).send({ error: "no_verification_set" });
      if (rev) reply.header("etag", rev);
      return set;
    },
  );

  // Writes the section from a verification-set/v1 object — what GET gives,
  // edited. The base rev is If-Match or the object's own `rev`. The server
  // writes the section md (verifySetBody) and saves the document in one
  // commit, through the same checks a document PUT runs.
  app.put(
    "/api/docs/domain-skill/:id/verification-set",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidId(id)) return reply.code(400).send({ error: "invalid_path_param", param: "id" });
      const submitted = request.body;
      const base = request.headers["if-match"] ?? submitted?.rev;
      if (!base) return reply.code(428).send({ error: "if_match_required", message: "If-Match 나 몸의 rev 에 바탕 rev 를 줍니다" });
      if (!submitted || typeof submitted !== "object" || Array.isArray(submitted))
        return reply.code(400).send({ error: "invalid_body", details: ["몸은 verification-set/v1 객체입니다"] });
      if (submitted.agent !== undefined && submitted.agent !== id)
        return reply.code(400).send({ error: "agent_mismatch", message: `agent 는 ${id} 입니다` });
      const shapeErrors = [];
      validateNode(
        contracts["verification-set/v1"],
        { warnings: [], ...submitted, agent: id, rev: base },
        "$",
        {},
        shapeErrors,
      );
      if (shapeErrors.length) return reply.code(400).send({ error: "invalid_body", details: shapeErrors });

      const result = await queue.enqueue(
        async () => {
          const relpath = `domain-skill/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (base !== currentRev)
            return { status: 409, body: { error: "unknown_base_rev", currentRev } };
          if ((doc.role ?? "main") !== "main")
            return { status: 400, body: { error: "not_main", message: "검증 Set 은 main 스킬에만 둡니다" } };
          let split;
          try {
            split = splitSkill(doc.body?.markdown ?? "");
          } catch (err) {
            if (!(err instanceof SkillSplitError)) throw err;
            return { status: 422, body: { error: "unsplittable_markdown", message: err.message } };
          }
          const sectionBody = verifySetBody(fromVerificationSet(submitted));
          const markdown = joinSkill(
            split.title ?? doc.body.name,
            split.sections.map((x) => (x.key === VERIFY_SECTION ? { ...x, body: sectionBody } : x)),
          );
          const problems = parseVerifySet(markdown).errors;
          if (problems.length)
            return { status: 422, body: { error: "invalid_verification_set", details: problems } };

          let body;
          try {
            body = applyEdit(refs["domain-skill/v1"], doc.body, { ...doc.body, markdown }, request.user.id, new Date().toISOString());
          } catch (err) {
            if (err instanceof EditError) return { status: 400, body: { error: "edit_rejected", message: err.message } };
            throw err;
          }
          const merged = mergeBodyLinks(storeDir, types.ids(), "domain-skill", doc, { ...doc, body });
          if (merged.error) return { status: 400, body: merged.error };
          const newDoc = merged.doc;
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length) return { status: 422, body: { error: "invalid_verification_set", details: errors } };
          const conflict = dataIdConflict(newDoc);
          if (conflict) return conflict;
          const rev = persistDoc(storeDir, "domain-skill", newDoc, {
            author: request.user.id,
            message: `verification-set domain-skill/${id}`,
          });
          return { status: 200, body: toVerificationSet(id, newDoc.body.markdown, rev, knownPieces(id, newDoc)) };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // What a question's 정답 can name — the editor's pickers. `queries`: the
  // 데이터 설명 · 데이터 연관 SQL, this skill's and its LINK1 skills', each
  // with where each bind's value comes from. `pieces`: the 일반 지식 knowledge
  // paths, this skill's and its LINK1 · LINK2 skills'.
  app.get(
    "/api/docs/domain-skill/:id/verification-choices",
    { config: { roles: ["user", "agent"] } },
    async (request, reply) => {
      const { id } = request.params;
      if (!isValidId(id)) return reply.code(400).send({ error: "invalid_path_param", param: "id" });
      const doc = readJson(storeDir, `domain-skill/${id}.json`);
      if (!doc) return reply.code(404).send({ error: "not_found" });
      const own = { id, markdown: doc.body?.markdown ?? "" };
      const linked = linkedSkills(storeDir, id, doc);
      return { queries: queryChoices(own, linked.link1), pieces: pieceChoices(own, linked) };
    },
  );

  // Anyone who writes may file an unclassified document; every other type is
  // the admin's.
  app.post(
    "/api/docs/:type",
    { config: { roles: ["admin", "user"] } },
    async (request, reply) => {
      const { type } = request.params;
      if (type !== UNCLASSIFIED.id && !hasGroup(request.user, ["admin"]))
        return reply.code(403).send({ error: "forbidden" });
      const schemaId = `${type}/v1`;
      const bodySchema = types.bodySchema(type);
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
      const merged = mergeBodyLinks(storeDir, types.ids(), type, null, {
        ...submitted,
        body: resolvedBody,
      });
      if (merged.error) return reply.code(400).send(merged.error);
      const doc = merged.doc;
      const errors = validateForStore(doc, refs, inStore);
      if (errors.length)
        return reply
          .code(400)
          .send({ error: "validation_failed", details: errors });
      const missing = missingLinkTargets(storeDir, doc.links);
      if (missing.length)
        return reply.code(400).send({ error: "unknown_link_target", missing });

      const relpath = `${type}/${doc.id}.json`;
      const result = await queue.enqueue(
        async () => {
          const closed = closedType(type);
          if (closed) return closed;
          if (readJson(storeDir, relpath))
            return { status: 409, body: { error: "already_exists" } };
          const conflict = dataIdConflict(doc);
          if (conflict) return conflict;
          const rev = persistDoc(storeDir, type, doc, {
            author: request.user.id,
            message: `create ${type}/${doc.id}`,
          });
          return { status: 201, body: { rev, json: doc, ...warningsOf(type, doc) } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.put(
    "/api/docs/:type/:id",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const bodySchema = types.bodySchema(type);
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const clientBody = request.body;

      const result = await queue.enqueue(
        async () => {
          const closed = closedType(type);
          if (closed) return closed;
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

          // [[ ]] the edit added or dropped move links[] with it.
          const merged = mergeBodyLinks(storeDir, types.ids(), type, currentDoc, {
            ...currentDoc,
            body: mergedBody,
          });
          if (merged.error) return { status: 400, body: merged.error };
          const newDoc = merged.doc;
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };
          const conflict = dataIdConflict(newDoc);
          if (conflict) return conflict;

          const note = commitNote(request.headers["x-akg-note"]);
          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: note ? `edit ${type}/${id} · ${note}` : `edit ${type}/${id}`,
          });
          return {
            status: 200,
            body: { rev, json: newDoc, rebased: outcome.rebased, ...warningsOf(type, newDoc) },
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
    { config: { roles: ["admin", "agent"] } },
    async (request, reply) => {
      const { type } = request.params;
      const schemaId = `${type}/v1`;
      const bodySchema = types.bodySchema(type);
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
        const merged = mergeBodyLinks(storeDir, types.ids(), type, null, {
          ...raw,
          status: "inactive",
          body,
        });
        if (merged.error) {
          rejected.push({ ...at, ...merged.error });
          continue;
        }
        const doc = merged.doc;
        const errors = validateForStore(doc, refs, inStore);
        if (errors.length) {
          rejected.push({ ...at, error: "validation_failed", details: errors });
          continue;
        }
        const missing = missingLinkTargets(storeDir, doc.links);
        if (missing.length) {
          rejected.push({ ...at, error: "unknown_link_target", missing });
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
          const closed = closedType(type);
          if (closed) return closed;
          const existing = docs
            .filter((d) => readJson(storeDir, `${type}/${d.id}.json`))
            .map((d) => d.id);
          if (existing.length)
            return {
              status: 409,
              body: { error: "already_exists", ids: existing },
            };
          // Against the store and against the batch entries before it.
          if (type === "domain-skill" || type === "domain") {
            const taken = inStore.dataIdOwners(null);
            const conflicts = [];
            for (const doc of docs) {
              for (const c of dataIdConflicts(doc, () => taken))
                conflicts.push({ ...c, source: doc.id });
              for (const { id, query } of skillDataIds(doc.body.markdown))
                if (!taken.has(id) || (query && !taken.get(id).query))
                  taken.set(id, { doc: doc.id, query });
            }
            if (conflicts.length)
              return {
                status: 409,
                body: { error: "data_id_conflict", conflicts },
              };
          }

          const { writes, removes } = docsWrites(storeDir, type, docs);
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
    { config: { roles: ["admin", "agent"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const schemaId = `${type}/v1`;
      const bodySchema = types.bodySchema(type);
      if (!bodySchema) return reply.code(400).send({ error: "unknown_type" });
      const submitted = request.body;
      if (!submitted || typeof submitted !== "object")
        return reply.code(400).send({ error: "invalid_body" });

      const result = await queue.enqueue(
        async () => {
          const closed = closedType(type);
          if (closed) return closed;
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
                ...(submitted.origin !== undefined ? { origin: submitted.origin } : {}),
                body,
              };
          const errors = validateForStore(doc, refs, inStore);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };
          const conflict = dataIdConflict(doc);
          if (conflict) return conflict;

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

  // The envelope's links[] as a whole. PUT /api/docs/:type/:id carries a body
  // only, so the edges get their own write — same If-Match rule as
  // activate: a stale rev is a 409, not a merge.
  app.put(
    "/api/docs/:type/:id/links",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      if (!types.bodySchema(type))
        return reply.code(400).send({ error: "unknown_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const links = request.body?.links;
      if (!Array.isArray(links))
        return reply.code(400).send({ error: "links_required" });

      const result = await queue.enqueue(
        async () => {
          const closed = closedType(type);
          if (closed) return closed;
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev)
            return {
              status: 409,
              body: { error: "unknown_base_rev", currentRev, current: doc },
            };

          // The body's [[ ]] stay linked whatever the list says: they are
          // removed by editing the body, not here.
          const merged = mergeBodyLinks(storeDir, types.ids(), type, doc, doc, links);
          if (merged.error) return { status: 400, body: merged.error };
          const newDoc = merged.doc;
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };
          const missing = missingLinkTargets(storeDir, newDoc.links);
          if (missing.length)
            return {
              status: 400,
              body: { error: "unknown_link_target", missing },
            };

          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: `links ${type}/${id}`,
          });
          return { status: 200, body: { rev, json: newDoc } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // A domain-skill's role (main | sub), the one envelope key besides links an
  // editor changes after creation. Same If-Match rule as links.
  app.put(
    "/api/docs/:type/:id/role",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      if (type !== "domain-skill")
        return reply.code(400).send({ error: "role_not_allowed" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const role = request.body?.role;
      if (role !== "main" && role !== "sub")
        return reply.code(400).send({ error: "invalid_role" });

      const result = await queue.enqueue(
        async () => {
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev)
            return {
              status: 409,
              body: { error: "unknown_base_rev", currentRev, current: doc },
            };

          // role sits after status, before links and body.
          const { schema, id: did, keywords, status, role: _old, ...rest } = doc;
          const newDoc = { schema, id: did, keywords, status, role, ...rest };
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };
          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: `role ${type}/${id} → ${role}`,
          });
          return { status: 200, body: { rev, json: newDoc } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.put(
    "/api/docs/db-schema/:id/catalog",
    { config: { roles: ["admin", "agent"] } },
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
          const errors = validateForStore(newDoc, refs, inStore);
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
      { config: { roles: ["admin"] } },
      async (request, reply) => {
        const { type, id } = request.params;
        if (!types.bodySchema(type))
          return reply.code(400).send({ error: "unknown_type" });
        const ifMatch = request.headers["if-match"];
        if (!ifMatch)
          return reply.code(428).send({ error: "if_match_required" });

        const result = await queue.enqueue(
          async () => {
            const closed = action === "activate" ? closedType(type) : null;
            if (closed) return closed;
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
            const errors = validateForStore(newDoc, refs, inStore);
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

  // The envelope's origin — the original the document was taken from. PUT
  // /api/docs/:type/:id carries a body only, so it gets its own write, with
  // the same If-Match rule as links. `origin: null` drops it.
  app.put(
    "/api/docs/:type/:id/origin",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      if (!types.bodySchema(type)) return reply.code(400).send({ error: "unknown_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const origin = request.body?.origin;
      if (origin === undefined) return reply.code(400).send({ error: "origin_required" });

      const result = await queue.enqueue(
        async () => {
          const closed = closedType(type);
          if (closed) return closed;
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev)
            return { status: 409, body: { error: "unknown_base_rev", currentRev, current: doc } };

          // origin sits after status and role, before links and body.
          const { schema, id: did, keywords, status, role, origin: _old, ...rest } = doc;
          const newDoc = {
            schema,
            id: did,
            keywords,
            status,
            ...(role !== undefined ? { role } : {}),
            ...(origin !== null ? { origin } : {}),
            ...rest,
          };
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length) return { status: 400, body: { error: "validation_failed", details: errors } };
          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: `origin ${type}/${id}`,
          });
          return { status: 200, body: { rev, json: newDoc } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // An md document moved to another md type, or a sub domain-skill moved to
  // domain: its file, its schema, the links[] of the documents that point at
  // it and its rendered md, in one commit.
  app.post(
    "/api/docs/:type/:id/retype",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      if (!types.bodySchema(type)) return reply.code(400).send({ error: "unknown_type" });
      const to = request.body?.type;
      if (typeof to !== "string" || !types.get(to))
        return reply.code(400).send({ error: "unknown_type", type: to ?? null });
      const subToDomain = type === "domain-skill" && to === "domain";
      if (!subToDomain && (!types.isMd(type) || !types.isMd(to)))
        return reply.code(400).send({ error: "structured_type", message: "재분류는 md 타입끼리, 그리고 domain-skill → domain 만 합니다" });
      if (to === type) return reply.code(400).send({ error: "same_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });

      const result = await queue.enqueue(
        async () => {
          const closed = closedType(to);
          if (closed) return closed;
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev)
            return { status: 409, body: { error: "unknown_base_rev", currentRev, current: doc } };
          if (readJson(storeDir, `${to}/${id}.json`))
            return { status: 409, body: { error: "already_exists", type: to, id } };
          if (subToDomain && (doc.role ?? "main") !== "sub")
            return { status: 400, body: { error: "main_skill", message: "domain 으로는 sub 스킬만 옮깁니다" } };

          // domain has no role: the key goes with the move.
          const { role: _role, ...kept } = doc;
          const newDoc = { ...(subToDomain ? kept : doc), schema: `${to}/v1` };
          const errors = validateForStore(newDoc, refs, inStore);
          if (errors.length) return { status: 400, body: { error: "validation_failed", details: errors } };

          const pointsHere = (l) => l.type === type && l.id === id;
          const relinked = [];
          const writes = [];
          const removes = [relpath, docMdPath(type, doc, { md: types.isMd(type) })];
          for (const t of types.ids()) {
            const changed = [];
            for (const sid of listIds(storeDir, t)) {
              if (t === type && sid === id) continue;
              const d = readJson(storeDir, `${t}/${sid}.json`);
              if (!d?.links?.some(pointsHere)) continue;
              changed.push({ ...d, links: d.links.map((l) => (pointsHere(l) ? { ...l, type: to } : l)) });
              relinked.push({ type: t, id: sid });
            }
            if (changed.length) {
              const w = docsWrites(storeDir, t, changed);
              writes.push(...w.writes);
              removes.push(...w.removes);
            }
          }
          const moved = docsWrites(storeDir, to, [newDoc]);
          writes.push(...moved.writes);
          removes.push(...moved.removes);

          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: `retype ${type}/${id} → ${to}`,
            writes,
            removes,
          });
          return { status: 200, body: { ...docView(to, id, newDoc, rev), relinked } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  // §6 DELETE — the file leaves the store; git history keeps it. One commit:
  // the JSON, its rendered md, the index, the links[] entries other documents
  // hold to it and, for a main agent, its score record. A [[ ]] in another
  // body stays as text: the graph shows it as 끊긴 연결.
  app.delete(
    "/api/docs/:type/:id",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      // Same allowlist as PUT: score/<agent>.json and assets/ are not documents.
      if (!types.bodySchema(type)) return reply.code(400).send({ error: "unknown_type" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const result = await queue.enqueue(
        async () => {
          const relpath = `${type}/${id}.json`;
          const doc = readJson(storeDir, relpath);
          if (!doc) return { status: 404, body: { error: "not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev)
            return { status: 409, body: { error: "unknown_base_rev", currentRev, current: doc } };

          const md = types.isMd(type);
          const writes = [];
          const removes = [relpath];
          if (rendersToMd(type, doc, { md })) removes.push(docMdPath(type, doc, { md }));
          if (type === "domain-skill" && (doc.role ?? "main") === "main") removes.push(`score/${id}.json`);

          const pointsHere = (l) => l.type === type && l.id === id;
          const unlinked = [];
          let ownTypeDone = false;
          for (const t of types.ids()) {
            const changed = [];
            for (const sid of listIds(storeDir, t)) {
              if (t === type && sid === id) continue;
              const d = readJson(storeDir, `${t}/${sid}.json`);
              if (!d?.links?.some(pointsHere)) continue;
              changed.push(withLinks(d, d.links.filter((l) => !pointsHere(l))));
              unlinked.push({ type: t, id: sid });
            }
            if (!changed.length && t !== type) continue;
            const w = docsWrites(storeDir, t, changed, { drop: t === type ? id : null });
            writes.push(...w.writes);
            removes.push(...w.removes);
            if (t === type) ownTypeDone = true;
          }
          // A type the type list no longer names still drops the doc from its index.
          if (!ownTypeDone) {
            const w = docsWrites(storeDir, type, [], { drop: id });
            writes.push(...w.writes);
            removes.push(...w.removes);
          }

          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: `delete ${type}/${id}`,
            writes,
            removes,
          });
          return { status: 200, body: { rev, unlinked } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}

export { priorityOf, listSlotAddresses };
