// Inverse of render/msg-format.mjs. There's no legacy md to migrate (0 real
// instances, design §2.2) — this exists so the "템플릿 예제 왕복" golden
// (Phase 0 acceptance, design §9.2) exercises the same round-trip discipline
// db-schema does, and so a future real msg-format corpus has an import path.
import { parseTiered } from "../render/tiered.mjs";

const EXAMPLES_MARKER = "\n\n## 예시 페이로드\n\n";

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t
    .slice(1, t.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((s) => s.trim());
}

function parseDirectionPurpose(line) {
  const m = line.match(/^(Host → Equipment|Equipment → Host)\.\s+([\s\S]*)$/);
  if (!m) throw new Error(`방향+용도 줄을 해석하지 못했습니다: ${line}`);
  return {
    direction:
      m[1] === "Host → Equipment" ? "host->equipment" : "equipment->host",
    purpose: parseTiered(m[2]),
  };
}

function parseFieldsTable(block) {
  const fields = [];
  for (const line of block.split("\n")) {
    const cells = splitRow(line);
    if (!cells || cells.length < 5) continue;
    if (cells[0] === "#" || /^-+$/.test(cells[0])) continue;
    const [seq, name, type, req, desc] = cells;
    fields.push({
      seq: Number(seq),
      name,
      type,
      required: req === "✓",
      desc: parseTiered(desc),
    });
  }
  return fields;
}

function parseExamples(raw) {
  return raw.split(/\n\n(?=\*\*)/).map((block) => {
    const m = block.match(/^\*\*(.+)\*\*\n\n```\n([\s\S]*)\n```$/);
    if (!m) throw new Error(`예시 블록을 해석하지 못했습니다: ${block}`);
    return { label: m[1], payload: m[2] };
  });
}

export function migrateMsgFormatMd(md) {
  let head = md;
  let examplesRaw = null;
  const idx = md.indexOf(EXAMPLES_MARKER);
  if (idx !== -1) {
    head = md.slice(0, idx);
    examplesRaw = md.slice(idx + EXAMPLES_MARKER.length).replace(/\n$/, "");
  } else {
    head = md.replace(/\n$/, "");
  }

  const m = head.match(/^# (\S+)\n\n(.+)\n\n([\s\S]+)$/);
  if (!m)
    throw new Error(
      "msg-format 문서 구조(H1 / 방향+용도 / 필드표)를 해석하지 못했습니다",
    );
  const [, command, dpLine, tableBlock] = m;
  const { direction, purpose } = parseDirectionPurpose(dpLine);
  const fields = parseFieldsTable(tableBlock);
  const examples = examplesRaw ? parseExamples(examplesRaw) : undefined;
  const id = command.toLowerCase().replace(/_/g, "-");

  return {
    schema: "msg-format/v1",
    id,
    keywords: [{ kw: command.toLowerCase(), inject: "full" }],
    status: "active",
    body: {
      command,
      direction,
      purpose,
      fields,
      ...(examples ? { examples } : {}),
    },
  };
}
