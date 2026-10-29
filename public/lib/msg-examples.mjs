// A msg-format doc's 예시 페이로드 section as plain data, in the order and the
// words src/render/msg-format.mjs renderExamples writes. No DOM here; node tests it.

const KEY = "예시 페이로드";

/**
 * The reading view's 예시 페이로드 section: every examples[] entry once, in order,
 * label and payload as stored. Null without any.
 * @returns {{key: string, title: string, items: {label: string, payload: string}[]} | null}
 */
export function examplesSection(examples) {
  if (!examples?.length) return null;
  return { key: KEY, title: KEY, items: examples.map(({ label, payload }) => ({ label, payload })) };
}

/** The msg-format reading view's right-hand 목차: 설명 · 필드, then 예시 페이로드 when the body has examples. */
export function msgFormatSections(body) {
  const ex = examplesSection(body?.examples);
  return [{ key: "설명", title: "설명" }, { key: "필드", title: "필드" }, ...(ex ? [{ key: ex.key, title: ex.title }] : [])];
}
