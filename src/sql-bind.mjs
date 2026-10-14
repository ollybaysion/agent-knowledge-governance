// Binds values into a skill md's SQL the way the consumer (fdc-agent-be-spring
// SqlRender.render · literal · timeOf) does, so the 정답 SQL the editor fills
// is the statement the consumer runs, character for character.

const NUMERIC = /^-?\d+(\.\d+)?$/;
const DATE_TIME =
  /^(\d{4})([-/])(\d{2})\2(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;
const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{Nd}_]/u;

/** The bind names the consumer fills from the agent input's 설비, any case. */
export const EQP_BINDS = ["eqp_id", "equipment", "eqp"];
/** The bind names the 기간 answer fills, any case. */
export const START_TIME = "start_time";
export const END_TIME = "end_time";

export const isEqpBind = (name) => EQP_BINDS.includes(String(name).trim().toLowerCase());
export const isTimeBind = (name) => [START_TIME, END_TIME].includes(String(name).trim().toLowerCase());

/**
 * The SQL with string literals' contents and comments blanked, position for
 * position, newlines kept — a `:` inside 'HH24:MI' or a comment is no bind.
 */
function mask(sql) {
  const out = sql.split("");
  let i = 0;
  while (i < out.length) {
    const c = out[i];
    if (c === "'") {
      let j = i + 1;
      while (j < out.length && out[j] !== "'") out[j++] = " ";
      i = j + 1;
    } else if (c === "-" && out[i + 1] === "-") {
      while (i < out.length && out[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && out[i + 1] === "*") {
      let j = i + 2;
      while (j < out.length && !(out[j] === "*" && out[j + 1] === "/")) j++;
      const end = Math.min(out.length, j + 2);
      for (let k = i; k < end; k++) if (out[k] !== "\n") out[k] = " ";
      i = end;
    } else i++;
  }
  return out.join("");
}

/** The `:name` binds of a statement, first-seen order, each once. */
export function varsOf(sql) {
  if (!sql || !sql.trim()) return [];
  const m = mask(sql);
  const vars = [];
  for (let i = 0; i + 1 < m.length; i++) {
    if (m[i] === ":" && IDENT_START.test(m[i + 1])) {
      let end = i + 1;
      while (end < m.length && IDENT_PART.test(m[end])) end++;
      const name = m.slice(i + 1, end);
      if (!vars.includes(name)) vars.push(name);
      i = end - 1;
    }
  }
  return vars;
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * A date-time value as local {y, mo, d, h, mi, s, frac} (frac = 9 digits), or
 * null when the value is no date-time. A trailing Z or offset turns into this
 * machine's local time, as the consumer turns it into the server's.
 */
export function timeOf(value) {
  if (value == null) return null;
  const v = String(value).trim();
  const compact = DATE_COMPACT.exec(v);
  let parts;
  let zone = null;
  if (compact) {
    const year = Number(compact[1]);
    if (year < 1900 || year > 2100) return null;
    parts = { y: year, mo: +compact[2], d: +compact[3], h: +compact[4], mi: +compact[5], s: +compact[6], frac: "000000000" };
  } else {
    const m = DATE_TIME.exec(v);
    if (!m) return null;
    parts = {
      y: +m[1], mo: +m[3], d: +m[4],
      h: m[5] == null ? 0 : +m[5], mi: m[6] == null ? 0 : +m[6], s: m[7] == null ? 0 : +m[7],
      frac: ((m[8] ?? "") + "000000000").slice(0, 9),
    };
    zone = m[9] ?? null;
  }
  const { y, mo, d, h, mi, s } = parts;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12 || d < 1 || d > days || h > 23 || mi > 59 || s > 59) return null;
  if (zone === null) return parts;
  const offset = zone === "Z" ? 0 : (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60000);
  return {
    y: local.getFullYear(), mo: local.getMonth() + 1, d: local.getDate(),
    h: local.getHours(), mi: local.getMinutes(), s: local.getSeconds(), frac: parts.frac,
  };
}

const quote = (v) => `'${v.replace(/'/g, "''")}'`;

/**
 * One value as a SQL literal: a date-time as TO_DATE (TO_TIMESTAMP with a
 * fraction) in YYYY-MM-DD HH24:MI:SS, a plain number bare, anything else in
 * single quotes with ' doubled.
 */
export function literal(value) {
  const v = String(value).trim();
  const time = DATE_COMPACT.test(v) || !NUMERIC.test(v) ? timeOf(v) : null;
  if (time) {
    const second = `${time.y}-${pad(time.mo)}-${pad(time.d)} ${pad(time.h)}:${pad(time.mi)}:${pad(time.s)}`;
    if (/^0+$/.test(time.frac)) return `TO_DATE(${quote(second)}, 'YYYY-MM-DD HH24:MI:SS')`;
    const frac = time.frac.endsWith("000000") ? time.frac.slice(0, 3) : time.frac;
    return `TO_TIMESTAMP(${quote(`${second}.${frac}`)}, 'YYYY-MM-DD HH24:MI:SS.FF')`;
  }
  if (NUMERIC.test(v)) return v;
  return quote(v);
}

/**
 * The statement with each `:name` that has a value in `binds` (exact name)
 * written as its literal. A bind without a value stays as written and is
 * listed in `missing`; with `missing` empty the statement is what the
 * consumer runs.
 * @param {string} sql
 * @param {Record<string, string>} binds
 * @returns {{sql: string, missing: string[]}}
 */
export function bindSql(sql, binds = {}) {
  const text = String(sql ?? "");
  const m = mask(text);
  const missing = [];
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (m[i] !== ":" || i + 1 >= text.length || !IDENT_START.test(m[i + 1])) {
      out += text[i];
      continue;
    }
    let end = i + 1;
    while (end < text.length && IDENT_PART.test(text[end])) end++;
    const name = text.slice(i + 1, end);
    const value = Object.hasOwn(binds, name) ? binds[name] : undefined;
    if (value == null) {
      if (!missing.includes(name)) missing.push(name);
      out += text.slice(i, end);
    } else out += literal(value);
    i = end - 1;
  }
  return { sql: out, missing };
}
