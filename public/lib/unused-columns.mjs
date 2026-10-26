// The db-schema 열 table's 미사용 marks, as plain data: body.unusedColumns
// (the columns a person unchecked; BE leaves them out of the prompt). No DOM
// here, node tests it.

/** Whether `name` is marked 미사용 in `list`. */
export const isUnused = (list, name) => (list ?? []).includes(name);

/**
 * `list` with `name` marked (`on` = 미사용) or unmarked; the input is left
 * alone and a name is never repeated.
 */
export function toggleUnused(list, name, on) {
  const rest = (list ?? []).filter((n) => n !== name);
  return on ? [...rest, name] : rest;
}

/** "열 n · 미사용 m" over the catalog's columns; a name the catalog lacks is not counted. */
export function unusedSummary(columns = [], list = []) {
  const unused = columns.filter((c) => isUnused(list, c.name)).length;
  return `열 ${columns.length} · 미사용 ${unused}`;
}
