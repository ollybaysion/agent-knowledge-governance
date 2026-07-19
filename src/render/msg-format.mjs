// msg-format/v1 body -> md. Unlike db-schema, there is no pre-existing
// hand-authored convention to match byte-for-byte (design §2.2: "msg-format
// / domain 문서... 실 인스턴스 0건") — this is akg's own house style, built
// for a clean migrate<->render inverse rather than to match any legacy file.
import { renderTiered } from "./tiered.mjs";

function directionLabel(direction) {
  return direction === "host->equipment"
    ? "Host → Equipment"
    : "Equipment → Host";
}

function requiredMark(required) {
  return required ? "✓" : "-";
}

function renderFieldsTable(fields) {
  const header =
    "| # | 필드 | 타입 | 필수 | 설명 |\n| --- | --- | --- | --- | --- |";
  const rows = fields.map(
    (f) =>
      `| ${f.seq} | ${f.name} | ${f.type} | ${requiredMark(f.required)} | ${renderTiered(f.desc)} |`,
  );
  return [header, ...rows].join("\n");
}

function renderExamples(examples) {
  if (!examples?.length) return null;
  return examples
    .map((ex) => `**${ex.label}**\n\n\`\`\`\n${ex.payload}\n\`\`\``)
    .join("\n\n");
}

export function renderMsgFormatMd(doc) {
  const b = doc.body;
  const lines = [
    `# ${b.command}`,
    "",
    `${directionLabel(b.direction)}. ${renderTiered(b.purpose)}`,
    "",
    renderFieldsTable(b.fields),
  ];
  const examplesBlock = renderExamples(b.examples);
  if (examplesBlock) lines.push("", "## 예시 페이로드", "", examplesBlock);
  lines.push("");
  return lines.join("\n");
}
