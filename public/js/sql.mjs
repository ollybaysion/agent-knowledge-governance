// SQL drawn for reading: colours (sql-kw · sql-str · sql-num · sql-cmt ·
// sql-bind), a table name that is a db-schema document as a link with its
// description and column count in a tooltip, and the columns of the named
// tables as links with their description in the same tooltip.
// The index comes once (GET /api/schema-index) and again after a write; until
// it comes, the colours come alone and the links follow.
import { api, docsVersion } from "./api.mjs";
import { el } from "./dom.mjs";
import { sqlPlan, tableTip } from "/lib/sql-tokens.mjs";

let index = null;
let indexVersion = -1;
let loading = null;

function loadIndex() {
  if (loading && indexVersion === docsVersion) return loading;
  indexVersion = docsVersion;
  loading = api("/api/schema-index").then((r) => {
    if (r.ok && r.data && typeof r.data === "object") index = r.data;
    return index;
  });
  return loading;
}

const docHref = (id) => `#/doc/db-schema/${encodeURIComponent(id)}`;

function nodesOf(sql, idx) {
  return sqlPlan(sql, idx).map((tok) => {
    if (tok.table) {
      const tip = tableTip(idx, tok.table);
      return el("a", {
        class: "sql-tbl",
        href: docHref(tok.table),
        "data-tip-h": tip?.head,
        "data-tip-n": tip?.count,
        "data-tip": tip?.text,
        text: tok.v,
      });
    }
    if (tok.column)
      return el("a", {
        class: "sql-col",
        href: docHref(tok.column.id),
        "data-tip-h": `${tok.column.name} · ${idx[tok.column.id]?.table ?? tok.column.id}`,
        "data-tip": tok.column.text || "설명 없음",
        text: tok.v,
      });
    if (tok.t === "ws" || tok.t === "op" || tok.t === "id") return document.createTextNode(tok.v);
    return el("span", { class: `sql-${tok.t}`, text: tok.v });
  });
}

/** A <code> with one SQL text drawn: colours now, links once the index is in. */
export function sqlCode(sql) {
  const code = el("code", { class: "sql" });
  const paint = (idx) => code.replaceChildren(...nodesOf(String(sql ?? ""), idx));
  paint(index);
  if (!index || indexVersion !== docsVersion) loadIndex().then((idx) => idx && paint(idx));
  return code;
}

// ---------- table · column tooltip: one element, 150ms after hover or focus ----------
let tip = null;
let timer = null;
let owner = null;

function hideTip() {
  clearTimeout(timer);
  if (owner) owner.removeAttribute("aria-describedby");
  owner = null;
  if (tip) tip.hidden = true;
}

function showTip(a) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!a.isConnected) return;
    if (!tip) {
      tip = el("div", { class: "sql-tip", id: "sql-tip", role: "tooltip", hidden: true });
      document.body.append(tip);
    }
    tip.replaceChildren(
      el("b", { class: "sql-tip-h" }, [a.dataset.tipH, a.dataset.tipN ? el("span", { class: "tip-n", text: a.dataset.tipN }) : null]),
      el("span", { class: "sql-tip-t", text: a.dataset.tip }),
    );
    tip.hidden = false;
    const r = a.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const top = r.bottom + 6 + h > innerHeight ? r.top - h - 6 : r.bottom + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    owner = a;
    a.setAttribute("aria-describedby", "sql-tip");
  }, 150);
}

// A table the index lacks has no data-tip: no tooltip.
const colOf = (e) => (e.target instanceof Element ? e.target.closest("a.sql-col, a.sql-tbl[data-tip]") : null);
document.addEventListener("mouseover", (e) => {
  const a = colOf(e);
  if (a && a !== owner) showTip(a);
});
document.addEventListener("mouseout", (e) => {
  const a = colOf(e);
  if (a && !a.contains(e.relatedTarget)) hideTip();
});
document.addEventListener("focusin", (e) => {
  const a = colOf(e);
  if (a) showTip(a);
});
document.addEventListener("focusout", (e) => {
  if (colOf(e)) hideTip();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && owner) hideTip();
});
addEventListener("hashchange", hideTip);
