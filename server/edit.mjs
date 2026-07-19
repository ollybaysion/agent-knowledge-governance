// PUT-time slot resolution (design D4, json-spec §3.1): a human edit or an
// adopted proposal can only ever land a slot on `inferred` (or `scaffold` if
// cleared) — confirmed is promote-only, and re-submitting unchanged text
// must NOT reset a confirmed slot's tier/evidence/by/at.
import { listSlotAddresses, getSlot, setSlot } from "./slots.mjs";

export class EditError extends Error {}

// "queries[0].note" -> "queries[0]" (the row); "purpose" / "columnDescs.X" -> null (no row).
export function parentRowAddress(address) {
  const m = address.match(/^(.*\[\d+\])\.[^.[\]]+$/);
  return m ? m[1] : null;
}

export function rowFactsChanged(currentRow, clientRow, tieredKey) {
  if (!currentRow || !clientRow) return true; // row added/removed — always counts as a change
  const strip = (row) => {
    const { [tieredKey]: _omit, ...rest } = row;
    return rest;
  };
  return JSON.stringify(strip(currentRow)) !== JSON.stringify(strip(clientRow));
}

export function resolveWrittenSlot(
  address,
  current,
  client,
  actor,
  now,
  forceChanged,
) {
  const currentText = current?.text ?? null;
  const clientText = client?.text ?? null;
  if (!forceChanged && currentText === clientText) {
    return current ?? { text: null, tier: "scaffold" };
  }
  if (clientText === null) return { text: null, tier: "scaffold" };
  // No fallback to the old evidence here: it justified the OLD text, not
  // this one — the client must (re-)submit evidence whenever content moves.
  const evidence = Array.isArray(client?.evidence) ? client.evidence : [];
  if (evidence.length === 0) {
    throw new EditError(
      `${address}: 변경된 슬롯은 evidence가 최소 1개 필요합니다`,
    );
  }
  return {
    text: clientText,
    tier: "inferred",
    evidence,
    by: `edit:${actor}`,
    at: now,
  };
}

/**
 * Merge a client-submitted body onto the current stored body: every
 * tiered-value slot is resolved through resolveWrittenSlot (so PUT can never
 * fabricate `confirmed`), `catalog` (if present) is always taken from the
 * CURRENT body (machine-owned, PUT never touches it — catalog-push does),
 * every other field is taken verbatim from the client body.
 */
export function applyEdit(typeSchema, currentBody, clientBody, actor, now) {
  const merged = structuredClone(clientBody);
  if (currentBody && "catalog" in currentBody)
    merged.catalog = currentBody.catalog;

  const addrs = new Set([
    ...listSlotAddresses(typeSchema, currentBody ?? {}),
    ...listSlotAddresses(typeSchema, clientBody),
  ]);
  for (const addr of addrs) {
    const current = getSlot(currentBody ?? {}, addr);
    const client = getSlot(clientBody, addr);
    const rowAddr = parentRowAddress(addr);
    let forceChanged = false;
    if (rowAddr) {
      const tieredKey = addr.slice(rowAddr.length + 1);
      forceChanged = rowFactsChanged(
        getSlot(currentBody ?? {}, rowAddr),
        getSlot(clientBody, rowAddr),
        tieredKey,
      );
    }
    setSlot(
      merged,
      addr,
      resolveWrittenSlot(addr, current, client, actor, now, forceChanged),
    );
  }
  return merged;
}
