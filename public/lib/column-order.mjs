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

/**
 * The catalog column a ?col=… names, as the catalog spells it (case ignored),
 * or null when the catalog no longer has it: the 열 row to scroll to.
 */
export function findColumn(columns = [], col) {
  if (!col) return null;
  const names = (columns ?? []).map((c) => c.name);
  if (names.includes(col)) return col;
  const want = String(col).toLowerCase();
  return names.find((n) => n.toLowerCase() === want) ?? null;
}

/**
 * The cells of a slot table (db-schema 열 · msg-format 필드), left to right:
 * {key, label}. `acts` (확정 · 폐기 · 복원) leads, so a long 설명 never pushes
 * the buttons out of sight; a db-schema puts 타입 last. `use` · `order` are
 * the admin's. An open slot's own row spans every cell, so its colspan is the
 * length of this list.
 */
export function slotTableColumns(type, { canOrder = false } = {}) {
  if (type === "db-schema")
    return [
      { key: "acts", label: "" },
      ...(canOrder
        ? [
            { key: "use", label: "사용" },
            { key: "order", label: "순서" },
          ]
        : []),
      { key: "name", label: "열" },
      { key: "nullable", label: "빈칸" },
      { key: "desc", label: "설명" },
      { key: "type", label: "타입" },
    ];
  return [
    { key: "acts", label: "" },
    { key: "seq", label: "#" },
    { key: "name", label: "필드" },
    { key: "type", label: "타입" },
    { key: "required", label: "필수" },
    { key: "desc", label: "설명" },
  ];
}

/**
 * One slot's rows in a slot table. → {cells, editColspan}: `cells` are the
 * keys of its row, left to right — an open slot (edit · reconcile) has an
 * empty `acts` cell and a `mark` where its 설명 was; `editColspan` is the
 * span of the row the open slot moves to (every cell), or null when closed.
 */
export function slotRowPlan(columns, { open = false } = {}) {
  const cells = columns.map((c) => (open && c.key === "acts" ? "empty" : open && c.key === "desc" ? "mark" : c.key));
  return { cells, editColspan: open ? columns.length : null };
}

/**
 * The move buttons beside the grip of row `i` of `n`, left to right:
 * 맨 위로 · 위로 · 아래로 · 맨 아래로. `to` is the index the row moves to;
 * `off` = already there. `key` is the grip's Alt+ key that does the same.
 */
export function orderSteps(i, n) {
  return [
    { label: "맨 위로", icon: "up-line", to: 0, off: i === 0, key: "Home" },
    { label: "위로", icon: "up", to: i - 1, off: i === 0, key: "ArrowUp" },
    { label: "아래로", icon: "down", to: i + 1, off: i === n - 1, key: "ArrowDown" },
    { label: "맨 아래로", icon: "down-line", to: n - 1, off: i === n - 1, key: "End" },
  ];
}
