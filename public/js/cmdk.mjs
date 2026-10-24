// ⌘K · Ctrl+K · 머리 검색 아이콘 → 가운데 640 창. 묶음: 입력 → 결과(타입 칩 ·
// 이름 · 맞은 절 · 맞은 글자 굵게) → 타입으로 가기 → 즐겨찾기 → 최근 → 명령.
// 빈 창은 즐겨찾기 · 최근이 맨 위. ↑ ↓ ↩ esc, ⌘↩ 은 새 탭.
import { allDocs } from "./api.mjs";
import { el, icon } from "./dom.mjs";
import { kindTag } from "./md.mjs";
import { groupOrder, matching, rankDocs } from "/lib/cmdk.mjs";
import { liveShelf } from "/lib/shelf.mjs";
import { shelf } from "./shelf.mjs";
import { DOC_TYPES, TYPES, canEdit, canUpload, isAdmin, typeColor } from "./state.mjs";

const enc = encodeURIComponent;
// Bodies (md) read once per rev, for 맞은 절.
const bodies = new Map(); // "type/id" -> {rev, md}
let bodiesLoading = null;
const BODY_CAP = 300;

function loadBodies(docs) {
  if (bodiesLoading) return bodiesLoading;
  const want = docs.slice(0, BODY_CAP).filter((d) => bodies.get(`${d.type}/${d.id}`)?.rev !== d.rev);
  bodiesLoading = (async () => {
    const queue = [...want];
    const worker = async () => {
      for (let d = queue.shift(); d; d = queue.shift()) {
        const r = await fetch(`/api/docs/${d.type}/${enc(d.id)}?format=md`).catch(() => null);
        if (r?.ok) bodies.set(`${d.type}/${d.id}`, { rev: d.rev, md: await r.text() });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    bodiesLoading = null;
  })();
  return bodiesLoading;
}

/** Text with the query's first term in bold. */
function marked(text, q) {
  const t = String(q ?? "").trim().split(/\s+/)[0];
  const s = String(text ?? "");
  const i = t ? s.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return [document.createTextNode(s)];
  return [document.createTextNode(s.slice(0, i)), el("b", { class: "hit", text: s.slice(i, i + t.length) }), document.createTextNode(s.slice(i + t.length))];
}
const clip = (s, q, n = 54) => {
  const t = String(q ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const i = t ? s.toLowerCase().indexOf(t) : 0;
  const start = Math.max(0, i - 16);
  const out = s.slice(start, start + n);
  return `${start ? "…" : ""}${out}${start + n < s.length ? "…" : ""}`;
};

let dlg = null;
export function openCmdk() {
  if (dlg) return;
  const prevFocus = document.activeElement;
  const input = el("input", {
    type: "text",
    class: "ck-input",
    placeholder: "문서 · 타입 · 명령 찾기",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": "ck-list",
    "aria-autocomplete": "list",
    "aria-label": "찾기",
    autocomplete: "off",
    spellcheck: "false",
  });
  const count = el("span", { class: "dim ck-count" });
  const list = el("div", { class: "ck-list", id: "ck-list", role: "listbox", "aria-label": "찾은 것" });
  dlg = el("dialog", { class: "ck", "aria-label": "찾기" }, [
    el("div", { class: "ck-top" }, [icon("search", 17), input, count, el("kbd", { text: "esc" })]),
    list,
    el("div", { class: "ck-foot" }, [
      el("span", {}, [el("kbd", { text: "↑" }), el("kbd", { text: "↓" }), " 고르기"]),
      el("span", {}, [el("kbd", { text: "↩" }), " 열기"]),
      el("span", {}, [el("kbd", { text: "⌘↩" }), " 새 탭"]),
    ]),
  ]);
  let items = []; // [{node, run(newTab)}]
  let newDoc = null; // drafts.mjs while 새 문서 asks for the type
  let active = 0;
  let docs = [];
  const close = () => {
    dlg?.close();
  };
  dlg.addEventListener("close", () => {
    dlg.remove();
    dlg = null;
    prevFocus?.focus?.();
  });
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close();
  });

  const go = (hash, newTab) => {
    if (newTab) window.open(`${location.pathname}${location.search}${hash}`, "_blank", "noopener");
    else {
      close();
      location.hash = hash;
    }
  };
  function option(children, run, extra = {}) {
    const i = items.length;
    const node = el("div", { class: "ck-opt", role: "option", id: `ck-o-${i}`, "aria-selected": "false", ...extra }, children);
    node.addEventListener("mousemove", () => setActive(i));
    node.addEventListener("click", (e) => run(e.metaKey || e.ctrlKey));
    items.push({ node, run });
    return node;
  }
  function setActive(i) {
    if (!items.length) return;
    active = (i + items.length) % items.length;
    items.forEach((it, j) => it.node.setAttribute("aria-selected", String(j === active)));
    input.setAttribute("aria-activedescendant", `ck-o-${active}`);
    items[active].node.scrollIntoView({ block: "nearest" });
  }
  const groupHead = (label, ic, extra) => el("div", { class: "ck-g", role: "presentation" }, [ic ? icon(ic, 13) : null, ` ${label}`, extra ? el("span", { class: "dim", text: extra }) : null]);
  const docOption = (d, q, meta) =>
    option([
      el("span", { class: "chip ck-type" }, [el("span", { class: "tdot", style: { "--c": typeColor(d.type) } }), ` ${d.type === "domain-skill" ? "스킬 문서" : TYPES.find((t) => t.id === d.type)?.label ?? d.type}`]),
      el("span", { class: `ck-name${d.type === "db-schema" || d.type === "msg-format" || d.type === "domain-skill" ? " mono" : ""}` }, marked(d.type === "db-schema" || d.type === "msg-format" || d.type === "domain-skill" ? d.id : d.title ?? d.id, q)),
      meta?.section ? el("span", { class: "dim ck-sec", text: `› ${meta.section}` }) : null,
      el("span", { class: "sp" }),
      meta?.line ? el("span", { class: "dim ck-line" }, marked(clip(meta.line, q), q)) : meta?.when ? el("span", { class: "dim", text: meta.when }) : null,
    ], (newTab) => go(`#/doc/${d.type}/${enc(d.id)}`, newTab));
  const shelfRow = (x) =>
    option([
      el("span", { class: "kind-badge", style: { "--c": typeColor(x.doc.type) }, text: kindTag(x.doc.type, x.doc.role) }),
      el("span", { class: "ck-name mono", text: x.doc.id }),
    ], (newTab) => go(`#/doc/${x.doc.type}/${enc(x.doc.id)}`, newTab));

  function paint() {
    const q = input.value;
    items = [];
    const sh = liveShelf(shelf(), docs);
    const parts = [];
    const commands = [
      canEdit() ? { label: "새 문서", hint: "타입 고르기", icon: "plus", run: async () => { newDoc = (await import("./drafts.mjs")); paint(); input.focus(); } } : null,
      canUpload() ? { label: "타입 없이 올리기", hint: "md 한 장 → 미분류", icon: "upload", run: async () => { close(); (await import("./drafts.mjs")).openUploadDialog(); } } : null,
      isAdmin() ? { label: "타입 관리", hint: "admin", icon: "admin", run: (n) => go("#/types", n) } : null,
      { label: "그래프", hint: "문서 관계", icon: "graph", run: (n) => go("#/graph", n) },
    ].filter(Boolean);
    const typeRows = TYPES.filter((t) => t.status === "active").map((t) => ({ t, n: docs.filter((d) => d.type === t.id).length }));
    if (newDoc) {
      const opts = matching(newDoc.newDocOpts(), q, (o) => `${o.label} ${o.desc}`);
      parts.push(groupHead("새 문서 · 타입 고르기", "plus"));
      parts.push(el("div", {}, opts.map((o) =>
        option([el("span", { class: "tdot", style: { "--c": o.color } }), el("span", { class: "ck-name", text: o.label }), el("span", { class: "dim", text: o.desc })], () => {
          close();
          newDoc.startDraft(o.type);
        }))));
      list.replaceChildren(...parts);
      setActive(0);
      return;
    }
    for (const g of groupOrder(q)) {
      if (g === "results") {
        const results = rankDocs(docs, q, { order: DOC_TYPES, bodies: new Map([...bodies].map(([k, v]) => [k, v.md])) });
        count.textContent = `문서 ${results.length}`;
        parts.push(groupHead(`결과 · 문서 ${results.length}`, null, "이름 · 본문 절"));
        parts.push(results.length ? el("div", {}, results.map((r) => docOption(r.doc, q, r))) : el("p", { class: "dim ck-none", text: bodiesLoading ? "본문을 읽는 중…" : "찾는 문서가 없습니다." }));
      } else if (g === "types") {
        const rows = matching(typeRows, q, (r) => `${r.t.label} ${r.t.id}`);
        if (!rows.length) continue;
        parts.push(groupHead("타입으로 가기", null, "타입 관리 순서"));
        parts.push(el("div", { class: "ck-types" }, rows.map((r) =>
          option([el("span", { class: "tdot", style: { "--c": r.t.color } }), ` ${r.t.id === "domain-skill" ? "스킬 문서" : r.t.label} `, el("span", { class: "dim", text: String(r.n) })], (n) => go(r.t.id === "domain-skill" ? "#/agents" : `#/docs/${r.t.id}`, n), { class: "ck-opt ck-typechip" }))));
      } else if (g === "shelf") {
        count.textContent = `문서 ${docs.length}`;
        parts.push(el("div", { class: "ck-shelf" }, [
          el("div", {}, [groupHead("즐겨찾기", "star"), sh.fav.length ? el("div", {}, sh.fav.map(shelfRow)) : el("p", { class: "dim ck-none", text: "없음 — 문서 탭 미리보기에서 ☆" })]),
          el("div", {}, [groupHead("최근", "clock"), sh.recent.length ? el("div", {}, sh.recent.slice(0, 5).map(shelfRow)) : el("p", { class: "dim ck-none", text: "없음" })]),
        ]));
      } else if (g === "favorites" || g === "recent") {
        const list = matching(g === "favorites" ? sh.fav : sh.recent.slice(0, 5), q, (x) => `${x.doc.id} ${x.doc.title ?? ""}`);
        if (!list.length) continue;
        parts.push(groupHead(g === "favorites" ? "즐겨찾기" : "최근", g === "favorites" ? "star" : "clock"));
        parts.push(el("div", {}, list.map(shelfRow)));
      } else if (g === "commands") {
        const rows = matching(commands, q, (c) => `${c.label} ${c.hint}`);
        if (!rows.length) continue;
        parts.push(groupHead("명령"));
        parts.push(el("div", {}, rows.map((c) => option([icon(c.icon, 15), el("span", { class: "ck-name", text: c.label }), el("span", { class: "dim", text: c.hint })], c.run))));
      }
    }
    list.replaceChildren(...parts);
    setActive(0);
  }

  input.addEventListener("input", () => {
    paint();
    if (input.value.trim() && !bodiesLoading && docs.some((d) => !bodies.has(`${d.type}/${d.id}`))) loadBodies(docs).then(() => dlg && paint());
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run(e.metaKey || e.ctrlKey);
    }
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  input.focus();
  paint();
  allDocs().then((d) => {
    docs = d;
    if (dlg) paint();
  });
}

/** ⌘K · Ctrl+K anywhere, and the head's search button. */
export function bindCmdk() {
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dlg) dlg.close();
      else openCmdk();
    }
  });
  document.addEventListener("akg:cmdk", () => openCmdk());
}

