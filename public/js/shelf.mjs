// 즐겨찾기 · 최근 for the signed-in person (localStorage, /lib/shelf.mjs).
import { currentUser } from "./state.mjs";
import { readShelf, toggleFavorite, touchRecent, writeShelf, isFavorite } from "/lib/shelf.mjs";

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
export const shelf = () => readShelf(storage(), currentUser?.id ?? "-");
export function touch(item) {
  writeShelf(storage(), currentUser?.id ?? "-", touchRecent(shelf(), item));
}
export function toggleFav(item) {
  const next = toggleFavorite(shelf(), item);
  writeShelf(storage(), currentUser?.id ?? "-", next);
  return isFavorite(next, item);
}
export const isFav = (item) => isFavorite(shelf(), item);
