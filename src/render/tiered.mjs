// A tiered-value's md representation is ONE convention used everywhere a
// slot appears — purpose, a column's 설명 cell, a query's note, a
// msg-format field's desc. json-spec §5.2 fixes it per tier:
//   scaffold   -> "{{설명}}" (generic — the field itself is typed by the
//                 schema now, so no per-field scaffold prose is needed)
//   inferred   -> "추정) <text> [근거: <evidence; joined>]"
//   confirmed  -> "<text> [근거: <evidence; joined>]"
//   deprecated -> "" (excluded from render entirely — not injected)
// parseTiered is the inverse, used by migrate-md.

export const SCAFFOLD_CELL = "{{설명}}";
export const INFERRED_PREFIX = "추정) ";

export function renderTiered(tv) {
  if (tv.tier === "scaffold") return SCAFFOLD_CELL;
  if (tv.tier === "deprecated") return "";
  const evidence = tv.evidence?.length
    ? ` [근거: ${tv.evidence.join("; ")}]`
    : "";
  const prefix = tv.tier === "inferred" ? INFERRED_PREFIX : "";
  return `${prefix}${tv.text}${evidence}`;
}

/** @returns {{text: string|null, tier: string, evidence?: string[]}} */
export function parseTiered(raw) {
  const s = raw.trim();
  if (s === SCAFFOLD_CELL) return { text: null, tier: "scaffold" };

  const m = s.match(/^([\s\S]*?)\s*\[근거:\s*([\s\S]*?)\]\s*$/);
  const body = m ? m[1] : s;
  const evidence = m
    ? m[2]
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [];

  if (body.startsWith(INFERRED_PREFIX)) {
    return {
      text: body.slice(INFERRED_PREFIX.length).trim(),
      tier: "inferred",
      evidence,
    };
  }
  return { text: body.trim(), tier: "confirmed", evidence };
}
