// Applying a proposal's slots to a document — shared by adopt (which really
// writes) and submit (which only rehearses).
//
// Why share: a proposal that cannot be adopted used to be accepted at submit
// and only fail later, when a reviewer clicked adopt. That put the discovery
// on the wrong person — the submitting agent got a 201 and moved on, while the
// reviewer got an error they had no way to fix from the queue. Worse, the loop
// below abandons the whole adopt at the FIRST bad slot, so one sloppy entry
// strands every good slot proposed alongside it.
//
// Running the identical code in both places is what makes submit's promise
// honest: submit is not a second, looser opinion about validity, it is the
// same check run earlier (issue #21).
//
// This is defense in depth, NOT a replacement for the adopt-side check. The
// document can change between submit and adopt — a column disappears, someone
// else's edit lands — so a proposal that rehearsed cleanly can still fail for
// real later. Submit's job is only to keep already-doomed proposals out.
import { validateDocument } from "../src/envelope.mjs";
import { setSlot } from "./slots.mjs";

/**
 * Slot values that can never be adopted no matter what the document looks
 * like. Checked without the document, so it also covers the case where the
 * target does not exist yet.
 * @returns {{error: string, address: string} | null}
 */
export function checkSlotValues(slots) {
  for (const [address, val] of Object.entries(slots)) {
    const evidence = Array.isArray(val?.evidence) ? val.evidence : [];
    if (!val?.text || evidence.length === 0)
      return { error: "invalid_slot_value", address };
  }
  return null;
}

/**
 * Apply `slots` to a copy of `currentDoc` and validate the result.
 *
 * @returns {{ok: true, doc: object} | {ok: false, status: number, body: object}}
 */
export function applySlots(currentDoc, slots, refs, { by, at }) {
  const bad = checkSlotValues(slots);
  if (bad) return { ok: false, status: 400, body: bad };

  const newBody = structuredClone(currentDoc.body);
  for (const [address, val] of Object.entries(slots)) {
    try {
      setSlot(newBody, address, {
        text: val.text,
        // The tier is pinned here rather than taken from the proposal: a
        // producer does not get to declare its own guess confirmed. Promotion
        // stays human-only (design D4).
        tier: "inferred",
        evidence: val.evidence,
        by,
        at,
      });
    } catch {
      // setSlot assumes the parent path exists; an address like "nope.deep.x"
      // or "queries[3].note" against a shorter array throws a TypeError.
      // Unhandled, that surfaced as a 500 — an agent could leave a proposal in
      // the queue that crashed the request whenever anyone tried to adopt it.
      return {
        ok: false,
        status: 400,
        body: { error: "invalid_slot_address", address },
      };
    }
  }

  const doc = { ...currentDoc, body: newBody };
  const errors = validateDocument(doc, refs);
  if (errors.length)
    return {
      ok: false,
      status: 400,
      body: { error: "validation_failed", details: errors },
    };
  return { ok: true, doc };
}
