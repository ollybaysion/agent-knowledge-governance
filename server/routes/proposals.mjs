// §6 proposal queue: submit (agent·editor), list pending (editor),
// adopt/reject (editor). Storage: store/proposals/pending|archive/<uuid>.json
// — a directory listing IS the queue (design §D2), no separate DB.
import { createHash, randomUUID } from "node:crypto";
import { validateDocument } from "../../src/envelope.mjs";
import {
  readJson,
  revOfPath,
  commitFiles,
  listIds,
  isValidId,
} from "../store.mjs";
import { docWrites } from "../render-store.mjs";
import { setSlot } from "../slots.mjs";

function priorityOf(user) {
  return user.role === "agent" ? "agent" : "human";
}

export function registerProposalsRoutes(app) {
  const { storeDir, refs, queue } = app.akg;

  app.post(
    "/api/proposals",
    { config: { roles: ["agent", "editor"] } },
    async (request, reply) => {
      const { type, id, slots } = request.body ?? {};
      if (
        !type ||
        !id ||
        !slots ||
        typeof slots !== "object" ||
        Object.keys(slots).length === 0
      ) {
        return reply.code(400).send({ error: "invalid_proposal" });
      }
      if (!refs[`${type}/v1`])
        return reply.code(400).send({ error: "unknown_type" });
      const contentHash = createHash("sha256")
        .update(JSON.stringify({ type, id, slots }))
        .digest("hex");

      const result = await queue.enqueue(
        async () => {
          // S8 dedup: an agent's identical resubmission returns the existing pending proposal.
          for (const uuid of listIds(storeDir, "proposals/pending")) {
            const existing = readJson(
              storeDir,
              `proposals/pending/${uuid}.json`,
            );
            if (existing?.contentHash === contentHash)
              return { status: 200, body: { id: uuid, deduped: true } };
          }
          const uuid = randomUUID();
          const proposal = {
            type,
            docId: id, // NOT `id` — the wrapper below owns `id` for the proposal's own uuid
            slots,
            submittedBy: request.user.id,
            createdAt: new Date().toISOString(),
            contentHash,
          };
          commitFiles(storeDir, {
            author: request.user.id,
            message: `propose ${type}/${id}`,
            writes: [
              {
                relpath: `proposals/pending/${uuid}.json`,
                content: JSON.stringify(proposal, null, 2) + "\n",
              },
            ],
          });
          return { status: 201, body: { id: uuid } };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.get(
    "/api/proposals",
    { config: { roles: ["editor"] } },
    async (request) => {
      const state = request.query?.state === "archive" ? "archive" : "pending";
      const dir = `proposals/${state}`;
      const proposals = listIds(storeDir, dir).map((uuid) => ({
        id: uuid,
        ...readJson(storeDir, `${dir}/${uuid}.json`),
      }));
      return { proposals };
    },
  );

  app.post(
    "/api/proposals/:pid/adopt",
    { config: { roles: ["editor"] } },
    async (request, reply) => {
      const { pid } = request.params;
      // CS7: pid becomes a file path below — reject anything that isn't a
      // plain id before it can steer the read/write out of proposals/.
      if (!isValidId(pid))
        return reply.code(400).send({ error: "invalid_proposal_id" });
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const overrideSlots = request.body?.slots;

      const result = await queue.enqueue(
        async () => {
          // S8: pending-file existence check + move happens inside the queue —
          // a second adopt/reject racing the first finds no pending file left.
          const proposal = readJson(storeDir, `proposals/pending/${pid}.json`);
          if (!proposal)
            return { status: 409, body: { error: "already_resolved" } };
          const { type, docId } = proposal;
          const relpath = `${type}/${docId}.json`;
          const currentDoc = readJson(storeDir, relpath);
          if (!currentDoc)
            return { status: 404, body: { error: "target_doc_not_found" } };
          const currentRev = revOfPath(storeDir, relpath);
          if (ifMatch !== currentRev) {
            return {
              status: 409,
              body: { error: "rev_mismatch", currentRev, current: currentDoc },
            };
          }

          const slotsToApply = overrideSlots ?? proposal.slots;
          const now = new Date().toISOString();
          const newBody = structuredClone(currentDoc.body);
          for (const [addr, val] of Object.entries(slotsToApply)) {
            const evidence = Array.isArray(val.evidence) ? val.evidence : [];
            if (!val.text || evidence.length === 0) {
              return {
                status: 400,
                body: { error: "invalid_slot_value", address: addr },
              };
            }
            setSlot(newBody, addr, {
              text: val.text,
              tier: "inferred",
              evidence,
              by: `adopt:${request.user.id}`,
              at: now,
            });
          }
          const newDoc = { ...currentDoc, body: newBody };
          const errors = validateDocument(newDoc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          const writes = [
            ...docWrites(storeDir, type, newDoc),
            {
              relpath: `proposals/archive/${pid}.json`,
              content:
                JSON.stringify(
                  {
                    ...proposal,
                    resolution: "adopted",
                    resolvedBy: request.user.id,
                    resolvedAt: now,
                  },
                  null,
                  2,
                ) + "\n",
            },
          ];
          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: `adopt proposal ${pid} -> ${type}/${docId}`,
            writes,
            removes: [`proposals/pending/${pid}.json`],
          });
          return { status: 200, body: { rev, json: newDoc } };
        },
        { priority: "human" },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/api/proposals/:pid/reject",
    { config: { roles: ["editor"] } },
    async (request, reply) => {
      const { pid } = request.params;
      if (!isValidId(pid))
        return reply.code(400).send({ error: "invalid_proposal_id" });
      const reason = request.body?.reason ?? null;

      const result = await queue.enqueue(
        async () => {
          const proposal = readJson(storeDir, `proposals/pending/${pid}.json`);
          if (!proposal)
            return { status: 409, body: { error: "already_resolved" } };
          const now = new Date().toISOString();
          const writes = [
            {
              relpath: `proposals/archive/${pid}.json`,
              content:
                JSON.stringify(
                  {
                    ...proposal,
                    resolution: "rejected",
                    reason,
                    resolvedBy: request.user.id,
                    resolvedAt: now,
                  },
                  null,
                  2,
                ) + "\n",
            },
          ];
          const rev = commitFiles(storeDir, {
            author: request.user.id,
            message: reason
              ? `reject proposal ${pid} — ${reason}`
              : `reject proposal ${pid}`,
            writes,
            removes: [`proposals/pending/${pid}.json`],
          });
          return { status: 200, body: { rev } };
        },
        { priority: "human" },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}
