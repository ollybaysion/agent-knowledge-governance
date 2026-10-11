// manual/v1 body -> md. The captures stay in the asset store; the md names
// each by the first 8 hex of its sha256, enough for a reader to match a step
// to its file without the line turning into a hash dump.
export function renderManualMd(doc) {
  const b = doc.body;
  const screen = (doc.links ?? []).find((l) => l.rel === "screen");
  const lines = [`# ${b.title}`, ""];
  if (screen) lines.push(`화면: ${screen.id}`, "");
  b.steps.forEach((s, i) => lines.push(`${i + 1}. ${s.text} (${s.asset.slice(0, 8)})`));
  lines.push("");
  return lines.join("\n");
}
