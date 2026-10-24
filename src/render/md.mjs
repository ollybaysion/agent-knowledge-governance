// An md type's body { name, markdown } -> its md: the text as written. The
// note is the author's md, stored verbatim like a skill, and nothing reads it
// as a skill — so there is no frontmatter to add. voc, unclassified and every
// registered type render this way.
export function renderMdDoc(doc) {
  return doc.body.markdown;
}
