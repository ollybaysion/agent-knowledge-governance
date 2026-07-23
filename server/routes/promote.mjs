// §6 POST .../promote (approver) and .../deprecate (editor) — both slot-unit,
// both require If-Match (S4), neither ever creates confirmed except promote.
import { validateForStore } from "../../src/envelope.mjs";
import { readJson, revOfPath, readJsonAtRev } from "../store.mjs";
import { persistDoc } from "../render-store.mjs";
import { listSlotAddresses, getSlot, setSlot, diffSlots } from "../slots.mjs";

function priorityOf(user) {
  return user.role === "agent" ? "agent" : "human";
}

// Shared shape: load current+base, verify If-Match resolves, verify the
// TARGET slots (not the whole doc) are unchanged since base (S4/S6 fusion).
function loadForSlotAction(storeDir, refs, type, id, ifMatch) {
  const bodySchema = refs[`${type}/v1`];
  if (!bodySchema)
    return { error: { status: 400, body: { error: "unknown_type" } } };
  const relpath = `${type}/${id}.json`;
  const currentDoc = readJson(storeDir, relpath);
  if (!currentDoc)
    return { error: { status: 404, body: { error: "not_found" } } };
  const currentRev = revOfPath(storeDir, relpath);
  const baseDoc =
    ifMatch === currentRev
      ? currentDoc
      : readJsonAtRev(storeDir, relpath, ifMatch);
  if (!baseDoc)
    return {
      error: { status: 409, body: { error: "unknown_base_rev", currentRev } },
    };
  return {
    bodySchema,
    currentDoc,
    currentRev,
    baseDoc,
    sameBase: baseDoc === currentDoc,
  };
}

function overlapWithBase(bodySchema, baseDoc, currentDoc, sameBase, targets) {
  if (sameBase) return [];
  const changed = diffSlots(bodySchema, baseDoc.body, currentDoc.body);
  return targets.filter((a) => changed.has(a));
}

export function registerPromoteRoutes(app) {
  const { storeDir, refs, queue } = app.akg;

  app.post(
    "/api/docs/:type/:id/promote",
    { config: { roles: ["approver"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const requestedSlots = request.body?.slots;

      const result = await queue.enqueue(
        async () => {
          const loaded = loadForSlotAction(storeDir, refs, type, id, ifMatch);
          if (loaded.error) return loaded.error;
          const { bodySchema, currentDoc, currentRev, baseDoc, sameBase } =
            loaded;

          const targets =
            requestedSlots ??
            listSlotAddresses(bodySchema, currentDoc.body).filter(
              (a) => getSlot(currentDoc.body, a)?.tier === "inferred",
            );
          if (targets.length === 0)
            return { status: 400, body: { error: "no_eligible_slots" } };

          const overlap = overlapWithBase(
            bodySchema,
            baseDoc,
            currentDoc,
            sameBase,
            targets,
          );
          if (overlap.length)
            return {
              status: 409,
              body: { error: "slot_conflict", overlap, currentRev },
            };

          const now = new Date().toISOString();
          const newBody = structuredClone(currentDoc.body);
          const notEligible = [];
          for (const addr of targets) {
            const slot = getSlot(currentDoc.body, addr);
            if (!slot || slot.tier !== "inferred") {
              notEligible.push(addr);
              continue;
            }
            // text/evidence unchanged — promote only ever moves the tier (D4).
            setSlot(newBody, addr, {
              ...slot,
              tier: "confirmed",
              by: `promote:${request.user.id}`,
              at: now,
            });
          }
          if (notEligible.length)
            return {
              status: 400,
              body: { error: "not_inferred", slots: notEligible },
            };

          const newDoc = { ...currentDoc, body: newBody };
          const errors = validateForStore(newDoc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message: `promote ${type}/${id}: ${targets.join(", ")}`,
          });
          return {
            status: 200,
            body: { rev, json: newDoc, promoted: targets },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/api/docs/:type/:id/deprecate",
    { config: { roles: ["editor"] } },
    async (request, reply) => {
      const { type, id } = request.params;
      const ifMatch = request.headers["if-match"];
      if (!ifMatch) return reply.code(428).send({ error: "if_match_required" });
      const targets = request.body?.slots;
      const reason = request.body?.reason;
      if (!Array.isArray(targets) || targets.length === 0) {
        return reply.code(400).send({ error: "slots_required" });
      }

      const result = await queue.enqueue(
        async () => {
          const loaded = loadForSlotAction(storeDir, refs, type, id, ifMatch);
          if (loaded.error) return loaded.error;
          const { bodySchema, currentDoc, currentRev, baseDoc, sameBase } =
            loaded;

          const overlap = overlapWithBase(
            bodySchema,
            baseDoc,
            currentDoc,
            sameBase,
            targets,
          );
          if (overlap.length)
            return {
              status: 409,
              body: { error: "slot_conflict", overlap, currentRev },
            };

          const now = new Date().toISOString();
          const newBody = structuredClone(currentDoc.body);
          const notEligible = [];
          for (const addr of targets) {
            const slot = getSlot(currentDoc.body, addr);
            if (
              !slot ||
              slot.tier === "scaffold" ||
              slot.tier === "deprecated"
            ) {
              notEligible.push(addr); // scaffold has nothing to deprecate; already deprecated is a no-op-turned-error
              continue;
            }
            // text/evidence preserved (§3.1) — deprecate only withdraws trust, never erases content.
            setSlot(newBody, addr, {
              ...slot,
              tier: "deprecated",
              by: `deprecate:${request.user.id}`,
              at: now,
            });
          }
          if (notEligible.length)
            return {
              status: 400,
              body: { error: "not_deprecatable", slots: notEligible },
            };

          const newDoc = { ...currentDoc, body: newBody };
          const errors = validateForStore(newDoc, refs);
          if (errors.length)
            return {
              status: 400,
              body: { error: "validation_failed", details: errors },
            };

          // json-spec has no `reason` field on tiered-value (additionalProperties:false)
          // — audit = git log (D2), so a reason lives in the commit message, not the JSON.
          const message = reason
            ? `deprecate ${type}/${id}: ${targets.join(", ")} — ${reason}`
            : `deprecate ${type}/${id}: ${targets.join(", ")}`;
          const rev = persistDoc(storeDir, type, newDoc, {
            author: request.user.id,
            message,
          });
          return {
            status: 200,
            body: { rev, json: newDoc, deprecated: targets },
          };
        },
        { priority: priorityOf(request.user) },
      );
      return reply.code(result.status).send(result.body);
    },
  );
}
