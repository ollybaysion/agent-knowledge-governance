// 즐겨찾기 · 최근: one list pair per user, kept in the browser. The 문서 탭's
// first column and ⌘K read the same pair. No DOM here; node tests it with a
// stand-in storage.

export const RECENT_CAP = 8;
export const FAVORITE_CAP = 50;

const keyOf = (userId) => `akg_shelf:${userId}`;
const same = (a, b) => a.type === b.type && a.id === b.id;
const clean = (list) =>
  (Array.isArray(list) ? list : []).filter((x) => x && typeof x.type === "string" && typeof x.id === "string");

/** {fav, recent} for the user; empty lists when storage is off or holds junk. */
export function readShelf(storage, userId) {
  try {
    const raw = JSON.parse(storage?.getItem(keyOf(userId)) ?? "null");
    return { fav: clean(raw?.fav), recent: clean(raw?.recent) };
  } catch {
    return { fav: [], recent: [] };
  }
}

export function writeShelf(storage, userId, shelf) {
  try {
    storage?.setItem(keyOf(userId), JSON.stringify({ fav: shelf.fav, recent: shelf.recent }));
    return true;
  } catch {
    return false;
  }
}

/** The shelf with `item` first in 최근 (once), stamped `at`, at most `cap`. */
export function touchRecent(shelf, item, at = new Date().toISOString(), cap = RECENT_CAP) {
  const entry = { type: item.type, id: item.id, ...(item.title ? { title: item.title } : {}), at };
  return { ...shelf, recent: [entry, ...shelf.recent.filter((x) => !same(x, item))].slice(0, cap) };
}

export const isFavorite = (shelf, item) => shelf.fav.some((x) => same(x, item));

/** The shelf with `item` added to 즐겨찾기 (last) or taken out. */
export function toggleFavorite(shelf, item, cap = FAVORITE_CAP) {
  if (isFavorite(shelf, item)) return { ...shelf, fav: shelf.fav.filter((x) => !same(x, item)) };
  const entry = { type: item.type, id: item.id, ...(item.title ? { title: item.title } : {}) };
  return { ...shelf, fav: [...shelf.fav, entry].slice(-cap) };
}

/** Entries whose document is gone are dropped; titles follow the doc list. */
export function liveShelf(shelf, docs) {
  const byKey = new Map(docs.map((d) => [`${d.type}/${d.id}`, d]));
  const live = (list) =>
    list.filter((x) => byKey.has(`${x.type}/${x.id}`)).map((x) => ({ ...x, doc: byKey.get(`${x.type}/${x.id}`) }));
  return { fav: live(shelf.fav), recent: live(shelf.recent) };
}
