// db-schema/v1 body -> md. Structure ported from
// claude-hooks/skills/db-schema-docs/render.mjs (the pre-existing dbdoc
// marker convention, §2.2 of the design doc) — adapted to source purpose /
// column descriptions / query notes from tiered values instead of a
// preserved-text map, and to drop the "## 마이그레이션 주의" slot the
// current claude-hooks renderer already no longer emits (ch PR #109).
import { renderTiered } from "./tiered.mjs";

const QUERIES_SCAFFOLD = "{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}";

function region(kind, id, body) {
  return `<!-- dbdoc:${kind}:${id} -->\n${body}\n<!-- dbdoc:end:${id} -->`;
}

// A cell can't contain a raw pipe or newline without breaking the table row.
function cell(value) {
  if (value == null) return "-";
  const s = String(value).trim();
  if (s === "") return "-";
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// A scaffold slot with an Oracle catalog comment shows the comment (a FACT,
// catalog.columns[].comment) instead of the generic placeholder — mirrors
// the pre-JSON renderer's columnDescription() fallback chain. Once a human
// annotates the slot (tier !== scaffold), the slot always wins.
function columnDescCell(col, columnDescs) {
  const tv = columnDescs[col.name] ?? { text: null, tier: "scaffold" };
  if (tv.tier !== "scaffold") return renderTiered(tv);
  if (col.comment && String(col.comment).trim()) return cell(col.comment);
  return renderTiered(tv);
}

function renderColumns(columns, columnDescs) {
  const header =
    "| 컬럼 | 타입 | 널 | 기본값 | 설명 |\n| --- | --- | --- | --- | --- |";
  const rows = columns.map((col) => {
    const nn = col.nullable ? "Y" : "N";
    return `| ${cell(col.name)} | ${cell(col.type)} | ${nn} | ${cell(col.default)} | ${columnDescCell(col, columnDescs)} |`;
  });
  return [header, ...rows].join("\n");
}

function renderKeys(catalog) {
  const lines = [
    `- PK: ${catalog.primaryKey?.length ? catalog.primaryKey.join(", ") : "-"}`,
  ];
  if (catalog.indexes?.length) {
    const idx = catalog.indexes
      .map(
        (ix) =>
          `${ix.name}(${(ix.columns ?? []).join(", ")}${ix.unique ? ", UNIQUE" : ""})`,
      )
      .join("; ");
    lines.push(`- 인덱스: ${idx}`);
  }
  if (catalog.foreignKeys?.length) {
    const fk = catalog.foreignKeys
      .map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`)
      .join("; ");
    lines.push(`- 관계: ${fk}`);
  }
  return lines.join("\n");
}

// A query row's rendered line packs note + sql into one tiered-value line
// (the md convention predates the JSON split into {sql, note}); text is
// only read for non-scaffold tiers, so the null case for scaffold notes
// never reaches string interpolation.
function renderQueryLine(q) {
  return renderTiered({
    tier: q.note.tier,
    text: q.note.tier === "scaffold" ? null : `${q.note.text}: ${q.sql}`,
    evidence: q.note.evidence,
  });
}

function renderQueries(queries) {
  if (!queries || queries.length === 0) return QUERIES_SCAFFOLD;
  return queries
    .map(renderQueryLine)
    .filter((line) => line !== "")
    .join("\n");
}

export function renderDbSchemaMd(doc) {
  const b = doc.body;
  return [
    `# ${b.owner}.${b.table}`,
    "",
    region("manual", "purpose", renderTiered(b.purpose)),
    "",
    region("auto", "columns", renderColumns(b.catalog.columns, b.columnDescs)),
    "",
    region("auto", "keys", renderKeys(b.catalog)),
    "",
    "---",
    "",
    "## 대표 쿼리",
    "",
    region("manual", "queries", renderQueries(b.queries)),
    "",
  ].join("\n");
}
