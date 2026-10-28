// SQL as the reading view draws it: tokens (keyword · string · number ·
// comment · bind · identifier), the tables a statement names, and which
// identifiers are columns of those tables. No DOM here; node tests it.

export const KEYWORDS = new Set(
  `SELECT FROM WHERE JOIN LEFT RIGHT INNER OUTER FULL CROSS ON USING AND OR NOT IN IS NULL AS BETWEEN LIKE
  GROUP BY ORDER HAVING LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY ASC DESC DISTINCT ALL ANY EXISTS
  CASE WHEN THEN ELSE END WITH UNION INTERSECT EXCEPT MINUS INSERT INTO VALUES UPDATE SET DELETE MERGE
  CREATE ALTER DROP TABLE VIEW INDEX OVER PARTITION COUNT SUM MAX MIN AVG NVL COALESCE CAST TRUE FALSE
  ROWNUM SYSDATE INTERVAL`.split(/\s+/),
);

// Words after which a table name comes.
const TABLE_LEAD = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);

const TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("[^"]*"?)|((?<!:):[A-Za-z_]\w*)|(\d+(?:\.\d+)?)|([A-Za-z_][\w$#]*)|(\s+)|(.)/gy;

/**
 * @returns {{t: "cmt"|"str"|"bind"|"num"|"kw"|"id"|"ws"|"op", v: string}[]}
 * Joined, the values give the text back unchanged.
 */
export function tokenize(sql) {
  const s = String(sql ?? "");
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < s.length && (m = TOKEN.exec(s))) {
    let t;
    if (m[1]) t = "cmt";
    else if (m[2]) t = "str";
    else if (m[3]) t = "id";
    else if (m[4]) t = "bind"; // not after a colon: a::int is a cast
    else if (m[5]) t = "num";
    else if (m[6]) t = KEYWORDS.has(m[6].toUpperCase()) ? "kw" : "id";
    else if (m[7]) t = "ws";
    else t = "op";
    out.push({ t, v: m[0] });
  }
  return out;
}

/** The bare name of an identifier: quotes off, upper case. */
const bare = (v) => v.replace(/^"|"$/g, "").toUpperCase();

/** The index of the next token that is not space or comment, from i. */
function next(tokens, i) {
  while (i < tokens.length && (tokens[i].t === "ws" || tokens[i].t === "cmt")) i++;
  return i;
}

/**
 * The tables a statement names after FROM · JOIN · UPDATE · INTO, with the
 * alias each takes. `OWNER.TABLE` keeps the last part.
 * @returns {{table: string, alias: string|null, at: number}[]} table and alias
 * upper case; `at` is the token index of the table name.
 */
export function tableRefs(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t !== "kw" || !TABLE_LEAD.has(tokens[i].v.toUpperCase())) continue;
    let j = next(tokens, i + 1);
    for (;;) {
      if (tokens[j]?.t !== "id") break;
      let at = j;
      let k = next(tokens, j + 1);
      while (tokens[k]?.v === "." && tokens[next(tokens, k + 1)]?.t === "id") {
        at = next(tokens, k + 1);
        k = next(tokens, at + 1);
      }
      let alias = null;
      if (tokens[k]?.t === "kw" && tokens[k].v.toUpperCase() === "AS") k = next(tokens, k + 1);
      if (tokens[k]?.t === "id") {
        alias = bare(tokens[k].v);
        k = next(tokens, k + 1);
      }
      out.push({ table: bare(tokens[at].v), alias, at });
      if (tokens[k]?.v !== ",") break;
      j = next(tokens, k + 1);
    }
  }
  return out;
}

/**
 * The schema index read by table name: `index` is GET /api/schema-index
 * ({id: {table, columns: {COL: {text}}}}). A name matches a document id
 * (lower case) or its table.
 */
export function tableLookup(index) {
  const byName = new Map();
  for (const [id, entry] of Object.entries(index ?? {})) {
    if (entry?.table) byName.set(String(entry.table).toUpperCase(), id);
    byName.set(id.toUpperCase(), id);
  }
  return (name) => byName.get(String(name).toUpperCase()) ?? null;
}

/**
 * The tooltip of a table name: {head: the table, count: "열 n", text: the
 * table description (purpose) or "설명 없음"}; null for a table the index
 * lacks.
 */
export function tableTip(index, id) {
  const entry = index?.[id];
  if (!entry) return null;
  return {
    head: entry.table ?? id.toUpperCase(),
    count: `열 ${Object.keys(entry.columns ?? {}).length}`,
    text: entry.purpose || "설명 없음",
  };
}

/**
 * The tokens with what they point at: a table name that is a db-schema
 * document gets `table: id`; an identifier that is a column of a table the
 * statement names gets `column: {id, name, text}` — `alias.COL` through its
 * alias, a bare `COL` through the first named table that has it.
 */
export function sqlPlan(sql, index) {
  const tokens = tokenize(sql);
  if (!index) return tokens;
  const lookup = tableLookup(index);
  const refs = tableRefs(tokens);
  const named = new Set(refs.map((r) => r.at));
  const byAlias = new Map();
  const ids = [];
  for (const r of refs) {
    const id = lookup(r.table);
    if (id) tokens[r.at].table = id;
    if (!id) continue;
    if (!ids.includes(id)) ids.push(id);
    byAlias.set(r.table, id);
    if (r.alias) byAlias.set(r.alias, id);
  }
  const column = (id, name) => {
    const col = index[id]?.columns?.[name];
    return col ? { id, name, text: col.text ?? null } : null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.t !== "id" || named.has(i)) continue;
    const name = bare(tok.v);
    const dot = tokens[i - 1]?.v === "." ? tokens[i - 2] : null;
    if (tokens[i + 1]?.v === ".") continue; // an alias or owner before a dot
    let hit = null;
    if (dot?.t === "id") {
      const id = byAlias.get(bare(dot.v));
      hit = id ? column(id, name) : null;
    } else for (const id of ids) if ((hit = column(id, name))) break;
    if (hit) tok.column = hit;
  }
  return tokens;
}
