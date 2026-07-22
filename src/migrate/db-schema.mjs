// db-schema md (dbdoc-marker convention) -> db-schema/v1 JSON. One-shot
// migration tool (design §9.1). `by`/`at` on tiered values are NOT
// reconstructed here — the md never carried them ("md로 렌더하지 않는다",
// json-spec §5.2), so a migrated slot legitimately has no author/timestamp
// until it's next touched through the (future) server API.
import {
  parseTiered,
  SCAFFOLD_CELL,
  INFERRED_PREFIX,
} from "../render/tiered.mjs";

const QUERIES_SCAFFOLD = "{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}";
const MIGRATION_SCAFFOLD =
  "{{선택 — 변경 이력, 함부로 바꾸면 안 되는 컬럼과 이유}}";

function regionRe(id) {
  return new RegExp(
    `<!-- dbdoc:(?:auto|manual):${id} -->\\n([\\s\\S]*?)\\n<!-- dbdoc:end:${id} -->`,
  );
}

function extractRegion(md, id) {
  const m = md.match(regionRe(id));
  return m ? m[1] : null;
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t
    .slice(1, t.endsWith("|") ? -1 : undefined)
    .split("|")
    .map((s) => s.trim());
}

function uncell(s) {
  if (s === "-") return null;
  return s.replace(/\\\|/g, "|");
}

// A desc cell with no "추정)"/"[근거:" marker at all is the pre-existing
// renderer's raw Oracle-comment passthrough (columnDescription() in the
// claude-hooks renderer) — a FACT that belongs in catalog.columns[].comment,
// not a human-reviewed slot. Only text carrying the tiering convention
// becomes a columnDescs tiered value; everything else stays scaffold there.
function classifyDescCell(raw) {
  const s = raw.trim();
  if (s === SCAFFOLD_CELL)
    return { comment: null, desc: { text: null, tier: "scaffold" } };
  if (s.startsWith(INFERRED_PREFIX))
    return { comment: null, desc: parseTiered(s) };
  return { comment: s, desc: { text: null, tier: "scaffold" } };
}

function parseColumns(regionBody) {
  const columns = [];
  const columnDescs = {};
  for (const line of regionBody.split("\n")) {
    const cells = splitRow(line);
    if (!cells || cells.length < 5) continue;
    const [name, type, nn, def, descRaw] = cells;
    if (name === "컬럼" || /^-+$/.test(name)) continue;
    const { comment, desc } = classifyDescCell(descRaw);
    columns.push({
      name,
      type,
      nullable: nn === "Y",
      default: uncell(def),
      comment,
    });
    columnDescs[name] = desc;
  }
  return { columns, columnDescs };
}

function parseIndexEntry(entry) {
  const m = entry.match(/^(\S+)\((.*)\)$/);
  if (!m) throw new Error(`인덱스 표기를 해석하지 못했습니다: ${entry}`);
  const parts = m[2].split(",").map((s) => s.trim());
  const unique = parts[parts.length - 1] === "UNIQUE";
  return { name: m[1], unique, columns: unique ? parts.slice(0, -1) : parts };
}

function parseForeignKeyEntry(entry) {
  const m = entry.match(/^(\S+)\s*→\s*(\S+)\.(\S+)$/);
  if (!m) throw new Error(`관계 표기를 해석하지 못했습니다: ${entry}`);
  return { column: m[1], refTable: m[2], refColumn: m[3] };
}

function parseKeys(regionBody) {
  const catalog = { primaryKey: [] };
  for (const line of regionBody.split("\n")) {
    const pk = line.match(/^- PK: (.*)$/);
    if (pk) {
      catalog.primaryKey =
        pk[1].trim() === "-" ? [] : pk[1].split(",").map((s) => s.trim());
      continue;
    }
    const ix = line.match(/^- 인덱스: (.*)$/);
    if (ix) {
      catalog.indexes = ix[1]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseIndexEntry);
      continue;
    }
    const fk = line.match(/^- 관계: (.*)$/);
    if (fk) {
      catalog.foreignKeys = fk[1]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(parseForeignKeyEntry);
    }
  }
  return catalog;
}

function parseQueries(regionBody) {
  const body = regionBody.trim();
  if (body === QUERIES_SCAFFOLD) return undefined;
  return body
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const tv = parseTiered(line);
      const m = (tv.text ?? "").match(/^([\s\S]*?):\s*(SELECT[\s\S]*)$/i);
      if (!m)
        throw new Error(
          `대표 쿼리 행을 note/sql로 분리하지 못했습니다: ${line}`,
        );
      return {
        sql: m[2].trim(),
        note: { text: m[1].trim(), tier: tv.tier, evidence: tv.evidence },
      };
    });
}

/**
 * @param {string} md
 * @param {{fetchedAt?: string}} [opts] fetchedAt is metadata the md never
 *   carried and never renders back out, so any value round-trips cleanly —
 *   callers migrating real data should pass the source file's mtime or a
 *   fresh catalog-push timestamp.
 * @returns {{doc: object, warnings: string[]}}
 */
export function migrateDbSchemaMd(
  md,
  { fetchedAt = "1970-01-01T00:00:00Z" } = {},
) {
  const warnings = [];
  const h1 = md.match(/^#\s+(\S+)\.(\S+)\s*$/m);
  if (!h1) throw new Error("H1(# OWNER.TABLE)을 찾지 못했습니다");
  const [, owner, table] = h1;

  const purposeBody = extractRegion(md, "purpose");
  const columnsBody = extractRegion(md, "columns");
  const keysBody = extractRegion(md, "keys");
  const queriesBody = extractRegion(md, "queries");
  if (
    purposeBody == null ||
    columnsBody == null ||
    keysBody == null ||
    queriesBody == null
  ) {
    throw new Error(
      "dbdoc 마커 4종(purpose/columns/keys/queries) 중 일부가 없습니다",
    );
  }

  // §2.4 / §9.1: the deprecated migration-note slot must never be dropped
  // silently — report it (empty scaffold: safe to drop; real content: a
  // human decision, not migrated automatically).
  const migrationBody = extractRegion(md, "migration");
  if (migrationBody != null) {
    if (migrationBody.trim() === MIGRATION_SCAFFOLD) {
      warnings.push(
        `${owner}.${table}: ## 마이그레이션 주의 절 감지(빈 scaffold) — 폐지된 슬롯(ch PR #109)이라 버립니다.`,
      );
    } else {
      warnings.push(
        `${owner}.${table}: ## 마이그레이션 주의 절에 내용이 있어 자동 이전하지 않았습니다 — purpose/queries로 수동 이전하거나 폐기를 결정하세요.\n    내용: ${migrationBody.trim()}`,
      );
    }
  }

  const { columns, columnDescs } = parseColumns(columnsBody);
  const catalog = { columns, ...parseKeys(keysBody), fetchedAt };
  const queries = parseQueries(queriesBody);
  // id = lower(table) — the H1's owner survives only as a body attribute.
  const id = table.toLowerCase();

  const doc = {
    schema: "db-schema/v1",
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "active",
    body: {
      owner,
      table,
      catalog,
      purpose: parseTiered(purposeBody),
      columnDescs,
      ...(queries ? { queries } : {}),
    },
  };
  return { doc, warnings };
}
