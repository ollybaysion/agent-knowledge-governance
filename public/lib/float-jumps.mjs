// The 맨 위 · 맨 아래 buttons that float at the bottom right of a long
// document's reading view. Pure: the reading view hands in the page numbers.

/** How much longer than the screen a page is before the buttons show. */
export const LONG_BY = 200;

/** How close to an end the page is when that end's button turns off. */
export const EDGE = 8;

/** The gap between the buttons and the screen edge or the right panel. */
export const GAP = 24;

/**
 * The buttons a type's reading view floats: a db-schema has a long 열 table,
 * the other types none. `where` names the end it scrolls to.
 */
export const floatJumps = (type) =>
  type === "db-schema"
    ? [
        { where: "top", label: "맨 위", aria: "문서 맨 위로", icon: "up-line" },
        {
          where: "bottom",
          label: "맨 아래",
          aria: "문서 맨 아래로",
          icon: "down-line",
        },
      ]
    : [];

/**
 * What the buttons show at a scroll spot: `show` when the page is longer than
 * the screen by LONG_BY; `top` · `bottom` are off when the page is at that end.
 */
export function jumpState({ scrollY, scrollHeight, innerHeight }) {
  return {
    show: scrollHeight > innerHeight + LONG_BY,
    top: scrollY <= EDGE,
    bottom: scrollY + innerHeight >= scrollHeight - EDGE,
  };
}

/** The page offset a jump scrolls to: 0 for the top, the last screen for the bottom. */
export const jumpTop = (where, { scrollHeight, innerHeight }) =>
  where === "top" ? 0 : Math.max(0, scrollHeight - innerHeight);

/**
 * The buttons' CSS `right`: GAP from the screen edge, or GAP left of the right
 * panel when that panel stands beside the body (`panelLeft` = its left edge).
 */
export const floatRight = ({ viewportWidth, panelLeft = null }) =>
  panelLeft == null ? GAP : Math.max(GAP, viewportWidth - panelLeft + GAP);

/**
 * Scroll `win` to one end: smooth, or at once when the reader asks for less
 * motion.
 */
export function jumpTo(where, win) {
  const doc = win.document.documentElement;
  const still = win.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const top = jumpTop(where, {
    scrollHeight: doc.scrollHeight,
    innerHeight: win.innerHeight,
  });
  win.scrollTo({ top, behavior: still ? "auto" : "smooth" });
}
