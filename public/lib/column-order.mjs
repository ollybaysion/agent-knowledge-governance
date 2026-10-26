// The db-schema 열 table's row order, as plain data: body.columnOrder (the
// order a person set on screen) over catalog.columns (the collector's DB
// order). No DOM here, node tests it.

/**
 * Columns in screen order: the ones `columnOrder` names, in that order, then
 * the catalog's others in catalog order. A name the catalog lacks is dropped.
 */
export function orderColumns(columns = [], columnOrder = []) {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const placed = new Set();
  const out = [];
  for (const name of columnOrder ?? []) {
    const col = byName.get(name);
    if (!col || placed.has(name)) continue;
    placed.add(name);
    out.push(col);
  }
  for (const col of columns) if (!placed.has(col.name)) out.push(col);
  return out;
}

/** `names` with the item at `from` moved to `to`; out-of-range gives a copy. */
export function moveName(names, from, to) {
  const out = names.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [name] = out.splice(from, 1);
  out.splice(to, 0, name);
  return out;
}
