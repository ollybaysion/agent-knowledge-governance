// Replacing the machine-known part of a document without touching the
// human-known part (json-spec §3: facts carry no tier, slots carry all of it).
//
// This needs no per-type knowledge. A slot is wherever the type schema says
// `$ref: common/tiered-value.v1`, which is the same rule the editor, the
// conflict resolver and the tier summary already run on — so "keep the slots,
// swap everything else" is expressible once, for every type, as: take the
// incoming body, then put the existing slot values back at their addresses.
import { listSlotAddresses, getSlot, setSlot } from "./slots.mjs";

/**
 * Merge incoming facts over an existing body, preserving slot values.
 *
 * A slot whose address survives keeps its value. A slot whose address is gone
 * from the new facts is an orphan, and follows the rule catalog-push
 * established (§4.1): never annotated, so drop it; annotated, so keep it as
 * evidence of what someone once said, marked deprecated.
 *
 * @param {object} typeSchema body schema for the type
 * @param {object|null} currentBody existing body, or null when creating
 * @param {object} facts incoming body — slot positions in it are ignored
 * @param {{by: string, at: string}} stamp who deprecated an orphan, and when
 * @returns {{body: object, orphans: {address: string, outcome: "dropped"|"deprecated"}[]}}
 */
export function mergeFacts(typeSchema, currentBody, facts, { by, at }) {
  const body = structuredClone(facts);
  const orphans = [];

  // This route never writes slot content. A machine replacing facts has no
  // standing to assert an interpretation — that is what `propose` is for — so
  // an address the incoming body introduces starts empty no matter what the
  // caller put there. Callers may therefore send a whole body and ignore the
  // slot positions in it entirely.
  const incoming = listSlotAddresses(typeSchema, body);
  for (const address of incoming) {
    setSlot(body, address, { text: null, tier: "scaffold" });
  }
  if (!currentBody) return { body, orphans };

  const introduced = new Set(incoming);
  for (const address of listSlotAddresses(typeSchema, currentBody)) {
    const slot = getSlot(currentBody, address);
    if (slot === undefined) continue;
    if (introduced.has(address)) {
      setSlot(body, address, slot);
      continue;
    }
    // The address itself is gone, so there is nowhere to put the value back.
    // Whether that loses anything depends on whether anyone had filled it in.
    orphans.push({
      address,
      outcome: slot.tier === "scaffold" ? "dropped" : "deprecated",
    });
    if (slot.tier === "scaffold") continue;
    const parent = parentOf(address);
    // Only reconstructible where the container survives — a deprecated slot
    // under a vanished parent has no address to live at.
    if (parent && getSlot(body, parent) === undefined) continue;
    setSlot(body, address, { ...slot, tier: "deprecated", by, at });
  }
  return { body, orphans };
}

function parentOf(address) {
  const cut = Math.max(address.lastIndexOf("."), address.lastIndexOf("["));
  return cut <= 0 ? null : address.slice(0, cut);
}
