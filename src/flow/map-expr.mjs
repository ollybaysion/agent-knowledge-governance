// A map fence's lines read — `이름 = 식`, the 식 a subset of Java's
// expressions. Grammar and names only: BE computes the values. No node
// imports: the dashboard runs this file as it is.

/** A map line's left name — a column name. */
export const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The special variable: the eqp scope. */
export const EQP = "$eqp";

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER = /[0-9]+(?:\.[0-9]+)?/y;
const INDEX = /^[0-9]+$/;
const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "(", ")", "<", ">", "!", "?", ":", "[", "]", "."];
const BIT = ["<<", ">>", "&", "|", "^", "~"];
const WORDS = new Set(["null", "true", "false"]);

class Bad extends Error {}

const at = (pos, what) => `${pos + 1} 번째 글자 ${what}`;

/**
 * `이름 = 식` split on its first `=` that is no part of `==` · `!=` · `<=` · `>=`.
 * @returns {{name: string, expr: string}|null} null when the line is not of that form
 *   (no such `=`, the left side no name, the right side empty)
 */
export function splitMapLine(line) {
  const s = String(line ?? "");
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "=" || "=!<>".includes(s[i - 1] ?? "") || s[i + 1] === "=") continue;
    const name = s.slice(0, i).trim();
    const expr = s.slice(i + 1).trim();
    return NAME.test(name) && expr !== "" ? { name, expr } : null;
  }
  return null;
}

// Tokens: {t: "num" | "str" | "word" | "name" | "eqp" | op, pos}.
function tokens(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "$") {
      IDENT.lastIndex = i + 1;
      const m = IDENT.exec(src);
      const word = `$${m ? m[0] : ""}`;
      if (word !== EQP) throw new Bad(`${word} 는 없다 — 특수 변수는 ${EQP} 하나다`);
      out.push({ t: "eqp", pos: i });
      i += word.length;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] !== "\\") continue;
        if (src[j + 1] !== '"' && src[j + 1] !== "\\") throw new Bad(`${at(j, "\\")}: 글 안의 이스케이프는 \\" · \\\\ 둘이다`);
        j++;
      }
      if (j >= src.length) throw new Bad(`${at(i, '"')}: 글이 닫히지 않았다`);
      out.push({ t: "str", pos: i });
      i = j + 1;
      continue;
    }
    if (c === "'") throw new Bad(`${at(i, "'")}: 글은 "…" 로 적는다`);
    NUMBER.lastIndex = i;
    let m = NUMBER.exec(src);
    if (m) {
      out.push({ t: "num", pos: i, v: m[0] });
      i += m[0].length;
      continue;
    }
    IDENT.lastIndex = i;
    m = IDENT.exec(src);
    if (m) {
      if (m[0] === "new") throw new Bad("new 는 받지 않는다");
      out.push({ t: WORDS.has(m[0]) ? "word" : "name", pos: i, v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    const bit = BIT.find((o) => src.startsWith(o, i));
    if (bit && (!op || bit.length > op.length)) throw new Bad("비트 연산은 받지 않는다");
    if (op) {
      out.push({ t: op, pos: i });
      i += op.length;
      continue;
    }
    if (c === "=") throw new Bad("대입은 받지 않는다");
    throw new Bad(`${at(i, c)}: 쓸 수 없는 글자다`);
  }
  return out;
}

const BINARY = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]];

/**
 * One 식 read. Precedence is Java's: `?:` (right) · `||` · `&&` · `== !=` ·
 * `< <= > >=` · `+ -` · `* / %` · unary `- !`.
 * @returns {{names: string[], eqp: {n: number, name: string}[]} | {error: string}}
 *   names: the flowing names the 식 reads, first-seen order; eqp: its
 *   `$eqp[n].이름`, first-seen order; error: why the 식 does not read (토큰 자리 or 뜻)
 */
export function parseExpr(text) {
  const src = String(text ?? "");
  const names = [];
  const eqp = [];
  let ts;
  try {
    ts = tokens(src);
  } catch (err) {
    if (err instanceof Bad) return { error: err.message };
    throw err;
  }
  let k = 0;
  const peek = () => ts[k] ?? null;
  const unexpected = () => {
    const t = peek();
    return new Bad(t ? at(t.pos, t.v ?? { str: '"', eqp: EQP }[t.t] ?? t.t) : "식이 덜 끝났다");
  };
  const take = (t) => {
    if (peek()?.t !== t) throw unexpected();
    return ts[k++];
  };
  // `(` · `[` · `.` after a value: a call, an index, a field — not taken.
  const after = () => {
    const t = peek()?.t;
    if (t === "(") throw new Bad("메서드 호출은 받지 않는다");
    if (t === "[") throw new Bad(`${EQP} 밖의 대괄호는 받지 않는다`);
    if (t === ".") throw new Bad(`. 는 ${EQP} 뒤에만 쓴다`);
  };
  const scope = () => {
    const how = `${EQP} 뒤에는 .index · .size · [n].이름 이 온다`;
    const t = peek()?.t;
    if (t === ".") {
      k++;
      const w = peek();
      if (w?.t !== "name" || (w.v !== "index" && w.v !== "size")) throw new Bad(how);
      k++;
      return;
    }
    if (t !== "[") throw new Bad(how);
    k++;
    const n = peek();
    if (n?.t !== "num" || !INDEX.test(n.v)) throw new Bad(`${EQP}[n] 의 n 은 0 이상 정수다`);
    k++;
    take("]");
    if (peek()?.t !== ".") throw new Bad(how);
    k++;
    const w = peek();
    if (w?.t !== "name" && w?.t !== "word") throw new Bad(how);
    k++;
    const index = Number(n.v);
    if (!eqp.some((e) => e.n === index && e.name === w.v)) eqp.push({ n: index, name: w.v });
  };
  const primary = () => {
    const t = peek();
    if (!t) throw unexpected();
    if (t.t === "num" || t.t === "str" || t.t === "word") k++;
    else if (t.t === "name") {
      k++;
      if (peek()?.t === "(") throw new Bad("메서드 호출은 받지 않는다");
      if (!names.includes(t.v)) names.push(t.v);
    } else if (t.t === "eqp") {
      k++;
      scope();
    } else if (t.t === "(") {
      k++;
      ternary();
      take(")");
    } else throw unexpected();
    after();
  };
  const unary = () => {
    const t = peek()?.t;
    if (t === "-" || t === "!") {
      k++;
      unary();
    } else primary();
  };
  const binary = (level) => {
    if (level === BINARY.length) return unary();
    binary(level + 1);
    while (BINARY[level].includes(peek()?.t)) {
      k++;
      binary(level + 1);
    }
  };
  const ternary = () => {
    binary(0);
    if (peek()?.t !== "?") return;
    k++;
    ternary();
    take(":");
    ternary();
  };
  try {
    if (!ts.length) throw new Bad("식이 없다");
    ternary();
    if (k < ts.length) throw unexpected();
  } catch (err) {
    if (err instanceof Bad) return { error: err.message };
    throw err;
  }
  return { names, eqp };
}
