// A db-schema document's 분류: 주요 when an active skill's or domain's 조회
// SQL reads its table (FROM · JOIN), and its 확정 커버리지.
import { skillDataIds } from "./skill-data-ids.mjs";

// Words after which an identifier is not a table, and before "(" not a function.
const KEYWORDS = new Set(
  "SELECT FROM JOIN WHERE ON AS AND OR NOT IN EXISTS INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING GROUP ORDER BY HAVING UNION ALL ANY SOME MINUS INTERSECT EXCEPT WITH LATERAL CONNECT START PARTITION OVER FETCH OFFSET LIMIT WHEN THEN ELSE CASE END DISTINCT VALUES INTO SET".split(" "),
);

const unquote = (name) => name.replace(/"/g, "");

/** SQL → its tokens: names (OWNER.TABLE, "Q"."T"), "(", ")", ","; comments and strings dropped. */
function tokens(sql) {
  const text = String(sql ?? "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " ");
  const out = [];
  const re = /((?:"[^"]+"|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z_][\w$#]*))*)|([(),])/g;
  for (let m; (m = re.exec(text)); ) out.push(m[1] ? { name: m[1].replace(/\s+/g, "") } : { p: m[2] });
  return out;
}

const word = (t) => (t?.name && !t.name.includes(".") && !t.name.includes('"') ? t.name.toUpperCase() : null);
const isKeyword = (t) => KEYWORDS.has(word(t));

/**
 * The tables a query reads: the name after FROM or JOIN (and after each comma
 * of a FROM list), upper case, the OWNER. prefix cut. A subquery's own FROM
 * counts; a CTE name, an alias and a FROM inside a function call
 * (EXTRACT(DAY FROM t)) do not.
 * @returns {string[]} unique, in order of appearance
 */
export function tablesOfSql(sql) {
  const ts = tokens(sql);
  const ctes = new Set();
  for (let i = 0; i + 2 < ts.length; i++)
    if (ts[i].name && word(ts[i + 1]) === "AS" && ts[i + 2].p === "(") ctes.add(unquote(ts[i].name).toUpperCase());
  const found = [];
  const add = (t) => {
    const name = unquote(t.name).split(".").pop().toUpperCase();
    if (!ctes.has(name) && !found.includes(name)) found.push(name);
  };
  const parens = []; // true = a function call's parenthesis
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t.p === "(") parens.push(!!ts[i - 1]?.name && !isKeyword(ts[i - 1]));
    else if (t.p === ")") parens.pop();
    const kw = word(t);
    if ((kw !== "FROM" && kw !== "JOIN") || parens[parens.length - 1]) continue;
    let j = i + 1;
    while (ts[j]?.name && !isKeyword(ts[j])) {
      add(ts[j]);
      if (kw === "JOIN") break;
      j++;
      if (word(ts[j]) === "AS") j++;
      if (ts[j]?.name && !isKeyword(ts[j])) j++; // the alias
      if (ts[j]?.p !== ",") break;
      j++;
    }
  }
  return found;
}

/**
 * Table → the 조회 that read it, over skill-md documents {type, id, markdown}
 * (the caller passes the active domain-skill and domain ones).
 * @returns {Map<string, {type: string, id: string, query: string}[]>}
 */
export function tableUses(docs) {
  const uses = new Map();
  for (const d of docs) {
    if (typeof d.markdown !== "string") continue;
    for (const item of skillDataIds(d.markdown)) {
      if (!item.sql) continue;
      for (const table of tablesOfSql(item.sql)) {
        if (!uses.has(table)) uses.set(table, []);
        uses.get(table).push({ type: d.type, id: d.id, query: item.id });
      }
    }
  }
  return uses;
}

/**
 * 확정 커버리지 of a db-schema body: confirmed slots over the live ones
 * (scaffold · inferred · confirmed) among purpose, columnDescs.* and
 * queries[].note. A deprecated slot and the slot of an unusedColumns column
 * count on neither side.
 * @returns {{confirmed: number, total: number, ratio: number}}
 */
export function coverageOf(body) {
  const unused = new Set(body?.unusedColumns ?? []);
  const descs = Object.entries(body?.columnDescs ?? {}).filter(([name]) => !unused.has(name)).map(([, s]) => s);
  const slots = [body?.purpose, ...descs, ...(body?.queries ?? []).map((q) => q?.note)];
  let confirmed = 0;
  let total = 0;
  for (const s of slots) {
    if (s?.tier !== "scaffold" && s?.tier !== "inferred" && s?.tier !== "confirmed") continue;
    total += 1;
    if (s.tier === "confirmed") confirmed += 1;
  }
  return { confirmed, total, ratio: total ? confirmed / total : 0 };
}
