// S6: "충돌 판정 단위는 슬롯" — If-Match mismatch doesn't automatically mean
// 409. It means: diff the two edits at slot (or slot-owning row) granularity
// against their common base; if they touched different units, auto-rebase
// onto the current doc; only a genuine overlap is a 409.
import { listSlotAddresses, getSlot, setSlot } from "./slots.mjs";
import {
  parentRowAddress,
  rowFactsChanged,
  resolveWrittenSlot,
} from "./edit.mjs";

// The unit two edits are compared at: a bare slot address ("purpose",
// "columnDescs.X") or, for row-nested slots, the whole row ("queries[0]") —
// editing a row's sql and editing its note text are the same unit (§3.1).
function changedUnits(typeSchema, baseBody, otherBody) {
  const units = new Set();
  const addrs = new Set([
    ...listSlotAddresses(typeSchema, baseBody),
    ...listSlotAddresses(typeSchema, otherBody),
  ]);
  for (const addr of addrs) {
    const rowAddr = parentRowAddress(addr);
    const unit = rowAddr ?? addr;
    if (units.has(unit)) continue;
    const textChanged =
      JSON.stringify(getSlot(baseBody, addr)) !==
      JSON.stringify(getSlot(otherBody, addr));
    const rowChanged = rowAddr
      ? rowFactsChanged(
          getSlot(baseBody, rowAddr),
          getSlot(otherBody, rowAddr),
          addr.slice(rowAddr.length + 1),
        )
      : false;
    if (textChanged || rowChanged) units.add(unit);
  }
  return units;
}

function tieredKeyOfRow(typeSchema, rowAddr, body) {
  // The one property of the row whose schema is a tiered-value $ref.
  const addrs = listSlotAddresses(typeSchema, body).filter(
    (a) => parentRowAddress(a) === rowAddr,
  );
  return addrs[0]?.slice(rowAddr.length + 1) ?? null;
}

/**
 * @returns {{conflict: true, overlap: string[]} | {conflict: false, rebased: boolean, mergedBody: object}}
 */
export function resolveConflict(
  typeSchema,
  baseBody,
  currentBody,
  clientBody,
  actor,
  now,
) {
  const clientUnits = changedUnits(typeSchema, baseBody, clientBody);
  if (JSON.stringify(baseBody) === JSON.stringify(currentBody)) {
    // No-rebase fast path: nobody else wrote since the client's base rev.
    return { conflict: false, rebased: false, mergedBody: null, clientUnits };
  }
  const serverUnits = changedUnits(typeSchema, baseBody, currentBody);
  const overlap = [...clientUnits].filter((u) => serverUnits.has(u));
  if (overlap.length > 0) return { conflict: true, overlap };

  // Rebase: start from the server's current body (keeps its own newer
  // changes), then re-apply only the units the CLIENT actually touched.
  const merged = structuredClone(currentBody);
  for (const unit of clientUnits) {
    const isRow = /\[\d+\]$/.test(unit);
    if (!isRow) {
      const cur = getSlot(currentBody, unit);
      const client = getSlot(clientBody, unit);
      setSlot(
        merged,
        unit,
        resolveWrittenSlot(unit, cur, client, actor, now, true),
      );
      continue;
    }
    // Row unit: carry the client's fact fields wholesale, but the tiered
    // sub-field still goes through resolveWrittenSlot (never trust a
    // client-claimed tier).
    const tieredKey =
      tieredKeyOfRow(typeSchema, unit, clientBody) ??
      tieredKeyOfRow(typeSchema, unit, currentBody);
    const clientRow = getSlot(clientBody, unit);
    const currentRow = getSlot(currentBody, unit);
    const mergedRow = { ...clientRow };
    if (tieredKey) {
      mergedRow[tieredKey] = resolveWrittenSlot(
        `${unit}.${tieredKey}`,
        currentRow?.[tieredKey],
        clientRow?.[tieredKey],
        actor,
        now,
        true,
      );
    }
    setSlot(merged, unit, mergedRow);
  }
  return { conflict: false, rebased: true, mergedBody: merged, clientUnits };
}
