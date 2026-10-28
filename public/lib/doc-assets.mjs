// A document's pictures as plain data: the figure one picture draws (an md
// ![글](asset:<sha256>) or an assets[] entry). No DOM here; node tests it.

/** Where the store hands out a picture's bytes. */
export const assetSrc = (sha256) => `/api/assets/${sha256}`;

/**
 * One figure. `alt` = the md's ![글] or the entry's alt; the entry
 * (assets[] of the same sha256) gives the size and stands in for an empty alt.
 * @returns {{sha256: string, src: string, alt: string, width: number|null, height: number|null}}
 */
export function figureOf(sha256, { alt = "", entry = null } = {}) {
  return {
    sha256,
    src: assetSrc(sha256),
    alt: alt || entry?.alt || "",
    width: entry?.width ?? null,
    height: entry?.height ?? null,
  };
}

/** sha256 → its assets[] entry. */
export const assetIndex = (assets) => new Map((assets ?? []).map((a) => [a.sha256, a]));

/**
 * The reading view's 그림 section under the body: every attached picture once,
 * in assets[] order, the ones the md shows too. Null without any.
 */
export function assetsSection(assets) {
  if (!assets?.length) return null;
  return {
    key: "첨부 그림",
    title: `그림 ${assets.length}`,
    figures: assets.map((a) => figureOf(a.sha256, { entry: a })),
  };
}
