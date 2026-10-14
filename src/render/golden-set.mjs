// golden-set/v1 body { name, markdown } -> GOLDEN.md: the text as written. The
// scorer reads the md itself, so there is no frontmatter to add.
export function renderGoldenSetMd(doc) {
  return doc.body.markdown;
}
