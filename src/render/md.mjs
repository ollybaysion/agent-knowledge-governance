// voc/v1 body { name, markdown } -> VOC.md: the text as written. The note is
// the author's md, stored verbatim like a skill, and nothing reads it as a
// skill — so there is no frontmatter to add.
export function renderVocMd(doc) {
  return doc.body.markdown;
}
