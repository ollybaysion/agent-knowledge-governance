// The reading view: a sticky doc head (type chip · title · status · role ·
// id · rev · JSON · 원본 ↗ · 타입 정하기 ▾ · 도메인으로 옮기기 · 원본 넣기 · 삭제 · 전체 편집), then the body as
// boxless sections, in one 720 column. Left: the agent list (a main skill)
// or the path column (anything else). Right: 요약 · 연결 · 이력.
import { allDocs, api, invalidateDocs } from "../api.mjs";
import { $, el, icon, toast } from "../dom.mjs";
import { inline, mdNodes, wikiResolver } from "../md.mjs";
import { scrollToNode, scrollToSec, sec, isAnswerSection } from "../sec.mjs";
import {
  evidence,
  getSlot,
  inactiveBar,
  keywordChips,
  roleChip,
  setSlot,
  shortRev,
  statusChip,
  tierBadge,
  wordDiff,
} from "../shared.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { answerSection, activeMdTypes, embed, canEdit as userCanEdit, currentUser, isAdmin, isMdType, loadTypes, setLastDoc, TYPE_LABEL, typeColor } from "../state.mjs";
import { agentPanel } from "./agents.mjs";
import { docPanel } from "./doc-panel.mjs";
import { skillBody, summaryOf, titleOf } from "./doc-skill.mjs";
import { manualBody } from "./doc-manual.mjs";
import { pathPanel, typeLabel } from "./docs.mjs";
import { deleteDraftsOf } from "../drafts.mjs";
import { refreshReviewCount } from "../review-count.mjs";
import { deleteConfirmText } from "/lib/miller.mjs";
import { openLinksDialog } from "../links-edit.mjs";
import { touch } from "../shelf.mjs";

let docTicket = 0;
const enc = encodeURIComponent;

// The right panel tab the next open starts on (the graph opens 연결).
let pendingTab = null;
export function openDocWithPanel(type, id, tab) {
  pendingTab = tab;
  location.hash = `#/doc/${type}/${enc(id)}`;
}

/** domain-skill and domain: the skill md body, editor and reading view. */
export const isSkillType = (type) => type === "domain-skill" || type === "domain";

/** The name a document is shown by. */
export function docTitle(type, doc) {
  const b = doc.body ?? {};
  if (isSkillType(type) || isMdType(type)) return titleOf(b.markdown) ?? b.name ?? doc.id;
  if (type === "db-schema" || type === "msg-format") return doc.id;
  return b.title ?? b.name ?? doc.id;
}

/**
 * Open a document. `opts.tab` = the right panel's first tab; `opts.keepScroll`
 * keeps the page where it was (a reload after a save).
 */
export async function renderDocScreen(type, id, opts = {}) {
  const ticket = ++docTicket;
  if (opts.tab === undefined && pendingTab) {
    opts = { ...opts, tab: pendingTab };
    pendingTab = null;
  }
  const [res, docs] = await Promise.all([api(`/api/docs/${type}/${enc(id)}`), allDocs()]);
  if (ticket !== docTicket) return;
  if (!res.ok) {
    setActiveTab("docs");
    setCrumbs([{ label: "문서", href: "#/docs" }, { label: id }]);
    screen().appendChild(
      cols({ main: el("main", { class: "main" }, el("p", { class: "error", text: `문서를 불러오지 못했습니다 (${res.status})` })) }),
    );
    return;
  }
  setLastDoc({ type, id });
  const data = res.data;
  touch({ type, id, title: docTitle(type, data.json) });
  let doc = data.json;
  let rev = data.rev;
  const isAgent = type === "domain-skill" && (doc.role ?? "main") === "main";
  const tab = isAgent ? "agents" : "docs";
  const title = docTitle(type, doc);
  const canEdit = userCanEdit() && doc.status !== "archived";
  setActiveTab(tab);
  setCrumbs(
    isAgent
      ? [{ label: "에이전트", href: "#/agents" }, { label: title }]
      : [{ label: "문서", href: "#/docs" }, { label: typeLabel(type), href: `#/docs/${type}` }, { label: title }],
  );

  const scrollY = opts.keepScroll ? window.scrollY : 0;
  async function reload(tabAfter) {
    invalidateDocs();
    await renderDocScreen(type, id, { tab: tabAfter ?? panel.current, keepScroll: true });
  }

  const main = el("main", { class: "main doc-main", "aria-label": title });
  const left = isAgent ? agentPanel(id) : pathPanel(type, id, docs);
  const panel = docPanel({
    type,
    id,
    doc,
    data,
    docs,
    isAgent,
    tab: opts.tab,
    onEditLinks: canEdit ? () => openLinksDialog({ type, id, data, getRev: () => rev, reload: () => reload("links") }) : null,
  });
  const layout = cols({ left: left.node ?? left, main, right: panel.node, className: left.collapsed ? "collapsed" : "" });
  left.bind?.(layout);
  screen().appendChild(layout);
  hoverSync(layout);

  const ctx = {
    type,
    id,
    get doc() {
      return doc;
    },
    get rev() {
      return rev;
    },
    data,
    docs,
    md: data.md,
    canEdit,
    reload,
    wiki: wikiResolver(data.wikilinks, docs),
    editSection: (key) => (location.hash = `#/edit/${type}/${enc(id)}${key ? `/${enc(key)}` : ""}`),
    setDocRev(d, r) {
      doc = d;
      rev = r;
    },
  };

  let jsonOpen = false;
  const head = docHead(ctx, title, isAgent, {
    toggleJson: () => {
      jsonOpen = !jsonOpen;
      paintJson();
    },
  });
  const jsonHost = el("div", { class: "json-host" });
  function paintJson() {
    jsonHost.replaceChildren(jsonOpen ? jsonBlock(`${type}/${id}.json`, doc, () => { jsonOpen = false; paintJson(); }) : document.createTextNode(""));
    head.querySelector(".json-view")?.setAttribute("aria-pressed", String(jsonOpen));
  }
  const bodyHost = el("div", { class: "doc-body" });
  main.append(head, inactiveBar(doc) ?? document.createTextNode(""), jsonHost, el("div", { id: "doc-notice" }), bodyHost);

  const built = await buildBody(ctx, bodyHost);
  if (ticket !== docTicket) return;
  panel.setSummary(built);
  stickyHead(head);
  if (scrollY) window.scrollTo(0, scrollY);
  else if (answerSection) {
    const key = built.sections.find((s) => isAnswerSection(s.title))?.key;
    if (key) requestAnimationFrame(() => scrollToSec(key, { smooth: false }));
    else if (built.answerHeading) requestAnimationFrame(() => scrollToNode(built.answerHeading, { smooth: false }));
  }
}

async function buildBody(ctx, host) {
  const { type, doc } = ctx;
  if (isSkillType(type)) {
    const r = await skillBody(ctx);
    host.replaceChildren(...r.nodes);
    return r;
  }
  if (isMdType(type)) return mdBody(ctx, host);
  if (type === "manual") return manualBody(ctx, host);
  if (type === "screen-map") return screenBody(ctx, host);
  if (type === "db-schema" || type === "msg-format") return slotBody(ctx, host);
  return factsBody(ctx, host, doc);
}

// ---------- 머리 ----------
function docHead(ctx, title, isAgent, { toggleJson }) {
  const { type, doc, rev, canEdit, reload } = ctx;
  const admin = isAdmin() && !embed;
  const role = type === "domain-skill" ? doc.role ?? "main" : null;
  const sub = isSkillType(type) ? summaryOf(doc.body?.markdown) : type === "db-schema" || type === "msg-format" ? doc.body?.purpose?.text ?? "" : type === "screen-map" ? [doc.body?.program, ...(doc.body?.menuPath ?? [])].filter(Boolean).join(" › ") : "";
  async function statusAction() {
    const target = doc.status === "active" ? "deactivate" : "activate";
    const r = await api(`/api/docs/${type}/${enc(doc.id)}/${target}`, { method: "POST", headers: { "if-match": ctx.rev } });
    if (!r.ok) {
      toast(r.status === 409 ? "다른 사람이 먼저 고쳤습니다 — 다시 읽은 뒤 바꾸세요." : `상태 변경 실패 (${r.status})`, "error");
      return;
    }
    toast(target === "activate" ? "활성 — 다음 동기화부터 주입됩니다." : "비활성 — 미러에서 빠집니다.");
    reload();
  }
  const metaRow = el("div", { class: "doc-meta-row" });
  const chips = [
    statusChip(doc, admin && doc.status !== "archived" ? statusAction : null),
    role ? roleChip(doc, rev, canEdit, () => reload()) : null,
    el("span", { class: "chip idc", text: doc.id }),
    el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
    admin
      ? el("button", { type: "button", class: "chip json-view", "aria-pressed": "false", title: "원본 store JSON", onclick: toggleJson, text: "JSON" })
      : null,
    doc.origin?.url
      ? el("a", { class: "chip linkchip", href: doc.origin.url, target: "_blank", rel: "noopener noreferrer", title: doc.origin.title || doc.origin.url }, ["원본 ", icon("external", 12)])
      : null,
    admin && isMdType(type) ? retypeMenu(ctx) : null,
    admin && role === "sub" && doc.status !== "archived"
      ? el("button", { type: "button", class: "chip menuchip", title: "도메인 타입으로 옮깁니다. id 는 그대로이고, 이 문서를 가리키는 연결도 같이 고칩니다.", onclick: () => retypeTo(ctx, "domain") }, "도메인으로 옮기기")
      : null,
    admin && doc.status !== "archived"
      ? el("button", { type: "button", class: "chip ghostchip", text: doc.origin ? "원본 고치기" : "원본 넣기", onclick: () => originForm(ctx, metaRow) })
      : null,
    admin
      ? el("button", { type: "button", class: "chip ghostchip delchip", text: "삭제", title: "저장소에서 이 문서 파일을 지웁니다. git 이력에만 남습니다.", onclick: () => deleteDoc(ctx, title, isAgent) })
      : null,
    ...keywordChips((doc.keywords || []).filter((k) => k.kw !== doc.id)),
  ];
  const fullEdit =
    canEdit && (isSkillType(type) || isMdType(type))
      ? el("button", { type: "button", class: "btn sm doc-full-edit", onclick: () => ctx.editSection(null) }, [icon("pencil", 14), "전체 편집"])
      : null;
  return el("header", { class: "doc-head" }, [
    el("p", { class: "doc-eyebrow" }, [
      el("span", { class: "tdot", style: { "--c": typeColor(type) }, "aria-hidden": "true" }),
      el("span", { text: type }),
      el("span", { class: "dim", text: ` · ${isAgent ? "에이전트" : typeLabel(type)}${role ? ` · ${role}` : ""}` }),
    ]),
    el("h1", { class: `doc-title${type === "db-schema" || type === "msg-format" ? " mono" : ""}`, text: title }),
    sub ? el("p", { class: "doc-sub", text: sub }) : null,
    el("div", { class: "doc-bar" }, [
      el("span", { class: "doc-bar-title", text: title, "aria-hidden": "true" }),
      el("div", { class: "doc-chips" }, chips.filter(Boolean)),
      fullEdit,
    ]),
    metaRow,
  ]);
}

// The chip row sticks under the head; once the title has scrolled away the
// row shows the title too.
function stickyHead(head) {
  const h1 = head.querySelector(".doc-title");
  const bar = head.querySelector(".doc-bar");
  if (!h1 || !bar || typeof IntersectionObserver === "undefined") return;
  const offset = embed ? 44 : 110;
  new IntersectionObserver(([e]) => bar.classList.toggle("stuck", !e.isIntersecting), { rootMargin: `-${offset}px 0px 0px 0px` }).observe(h1);
}

/** DELETE with If-Match after a confirm, then the type's list (an agent: the 에이전트 tab). */
async function deleteDoc(ctx, title, isAgent) {
  const { type, doc, data } = ctx;
  if (!confirm(deleteConfirmText(title, isAgent ? "에이전트" : typeLabel(type), (data.backlinks || []).length))) return;
  const r = await api(`/api/docs/${type}/${enc(doc.id)}`, { method: "DELETE", headers: { "if-match": ctx.rev } });
  if (!r.ok) {
    toast(r.status === 409 ? "다른 사람이 먼저 고쳤습니다 — 먼저 다시 읽기를 하세요." : `삭제 실패 (${r.status})`, "error");
    return;
  }
  deleteDraftsOf(type, doc.id);
  toast("삭제했습니다");
  invalidateDocs();
  refreshReviewCount();
  location.hash = isAgent ? "#/agents" : `#/docs/${type}`;
}

/** POST …/retype to `to` with If-Match, then open the moved document. */
async function retypeTo(ctx, to) {
  const { type, doc } = ctx;
  const from = typeLabel(type);
  if (!confirm(`${from} → ${TYPE_LABEL[to] ?? to} 로 옮깁니다. id 는 그대로이고, 이 문서를 가리키는 연결도 같이 고칩니다.`)) return;
  const r = await api(`/api/docs/${type}/${enc(doc.id)}/retype`, { method: "POST", headers: { "if-match": ctx.rev }, body: { type: to } });
  if (!r.ok) {
    const d = r.data || {};
    toast(
      d.error === "already_exists"
        ? `${TYPE_LABEL[to] ?? to} 에 같은 id 의 문서가 있습니다.`
        : d.error === "type_archived"
          ? "닫힌 타입으로는 옮기지 않습니다."
          : r.status === 409
            ? "다른 사람이 먼저 고쳤습니다 — 다시 읽은 뒤 옮기세요."
            : `옮기기 실패 (${r.status})${d.message ? ` — ${d.message}` : ""}`,
      "error",
    );
    return;
  }
  toast(`${TYPE_LABEL[to] ?? to} 로 옮겼습니다`);
  invalidateDocs();
  await loadTypes();
  location.hash = `#/doc/${to}/${enc(doc.id)}`;
}

function retypeMenu(ctx) {
  const { type } = ctx;
  const targets = activeMdTypes().filter((t) => t.id !== type && t.id !== "unclassified");
  if (!targets.length) return null;
  const btn = el("button", { type: "button", class: "chip menuchip", "aria-haspopup": "menu", "aria-expanded": "false" }, ["타입 정하기 ", icon("down", 12)]);
  const wrap = el("span", { class: "menu-wrap" }, btn);
  const close = () => {
    wrap.querySelector(".menu")?.remove();
    btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  function pick(to) {
    close();
    retypeTo(ctx, to);
  }
  btn.addEventListener("click", () => {
    if (wrap.querySelector(".menu")) return close();
    const menu = el("ul", { class: "menu", role: "menu", "aria-label": "옮길 타입" }, targets.map((t) =>
      el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", onclick: () => pick(t.id) }, [
        el("span", { class: "tdot", style: { "--c": t.color }, "aria-hidden": "true" }),
        t.label,
      ])),
    ));
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
      else if (e.key === "Escape") {
        close();
        btn.focus();
      } else return;
      e.preventDefault();
    });
    wrap.appendChild(menu);
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector("button")?.focus();
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  });
  return wrap;
}

function originForm(ctx, row) {
  const { type, doc } = ctx;
  const url = el("input", { type: "url", class: "fld mono", placeholder: "원본 URL (https://…, 비우면 지움)", "aria-label": "원본 URL" });
  url.value = doc.origin?.url || "";
  const title = el("input", { type: "text", class: "fld", placeholder: "원본 제목 (선택)", "aria-label": "원본 제목" });
  title.value = doc.origin?.title || "";
  const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
  save.addEventListener("click", async () => {
    const u = url.value.trim();
    const t = title.value.trim();
    save.disabled = true;
    const r = await api(`/api/docs/${type}/${enc(doc.id)}/origin`, {
      method: "PUT",
      headers: { "if-match": ctx.rev },
      body: { origin: u ? { url: u, ...(t ? { title: t } : {}) } : null },
    });
    if (r.ok) {
      toast("원본을 저장했습니다");
      ctx.reload();
      return;
    }
    save.disabled = false;
    const d = r.data || {};
    toast(r.status === 409 ? "다른 사람이 먼저 고쳤습니다 — 다시 읽은 뒤 저장하세요." : `저장 실패 (${r.status})${d.details ? ` — ${d.details.join(" · ")}` : ""}`, "error");
  });
  row.replaceChildren(url, title, save, el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: () => row.replaceChildren() }));
  url.focus();
}

function jsonBlock(title, obj, onClose) {
  const pretty = JSON.stringify(obj, null, 2);
  return el("section", { class: "json-sec", "aria-label": "원본 JSON" }, [
    el("div", { class: "json-h" }, [
      el("span", { class: "mono", text: title }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        text: "복사",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            toast("JSON 을 복사했습니다.");
          } catch {
            toast("복사하지 못했습니다 — 글을 직접 골라 복사하세요.", "error");
          }
        },
      }),
      el("button", { type: "button", class: "btn ghost sm", "aria-label": "JSON 닫기", text: "닫기", onclick: onClose }),
    ]),
    el("pre", { class: "json-pre", text: pretty }),
  ]);
}

// Chips in the body, dots in the ring and rows in the lists that name the
// same doc light up together.
function hoverSync(root) {
  let on = null;
  const set = (key) => {
    if (on === key) return;
    for (const n of root.querySelectorAll(".hl")) n.classList.remove("hl");
    on = key;
    if (key) for (const n of root.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) n.classList.add("hl");
  };
  root.addEventListener("mouseover", (e) => set(e.target.closest?.("[data-key]")?.dataset.key ?? null));
  root.addEventListener("focusin", (e) => set(e.target.closest?.("[data-key]")?.dataset.key ?? null));
  root.addEventListener("mouseleave", () => set(null));
}

// ---------- md 타입(voc · 등록 · 미분류) ----------
async function mdBody(ctx, host) {
  const { doc, canEdit, wiki } = ctx;
  const { splitBlocks } = await import("/lib/sections.mjs");
  const md = doc.body?.markdown ?? "";
  const split = splitBlocks(md);
  const sections = [];
  const nodes = [];
  const intro = split.head
    .split("\n")
    .filter((l) => !/^#\s+/.test(l))
    .join("\n")
    .trim();
  if (intro) nodes.push(el("div", { class: "doc-intro" }, mdNodes(intro, { wiki })));
  if (!split.blocks.length) {
    sections.push({ key: "본문", title: "본문" });
    nodes.push(
      sec({
        key: "본문",
        title: "본문",
        onEdit: canEdit ? () => ctx.editSection(null) : null,
        children: md.trim() && !intro ? mdNodes(md.replace(/^#\s+.*$/m, ""), { wiki }) : intro ? [] : [el("p", { class: "dim", text: "아직 본문이 없습니다." })],
      }),
    );
  }
  for (const b of split.blocks) {
    sections.push({ key: b.key, title: b.heading });
    nodes.push(
      sec({
        key: b.key,
        title: b.heading,
        onEdit: canEdit ? () => ctx.editSection(b.key) : null,
        children: b.body.trim() ? mdNodes(b.body, { wiki }) : [el("p", { class: "dim", text: "비어 있습니다" })],
      }),
    );
  }
  host.replaceChildren(...nodes);
  return { sections, nodes };
}

// ---------- screen-map ----------
function screenBody(ctx, host) {
  const b = ctx.doc.body ?? {};
  const cols = b.expectedColumns || {};
  const list = (items) =>
    items && items.length ? el("ul", { class: "md-list" }, items.map((t) => el("li", { text: t }))) : el("p", { class: "dim", text: "없음" });
  const sections = [
    { key: "보이는 모습", title: "보이는 모습" },
    { key: "컬럼", title: "표에 있어야 할 컬럼" },
  ];
  host.replaceChildren(
    sec({ key: "보이는 모습", title: "보이는 모습", children: [list(b.hints)] }),
    sec({
      key: "컬럼",
      title: "표에 있어야 할 컬럼",
      children: [
        el("dl", { class: "kv" }, [
          el("dt", { text: "필수" }), el("dd", { class: "mono", text: (cols.required || []).join(" · ") || "없음" }),
          el("dt", { text: "선택" }), el("dd", { class: "mono", text: (cols.optional || []).join(" · ") || "없음" }),
        ]),
      ],
    }),
  );
  return { sections };
}

// ---------- 그 밖 구조 타입(fab-line …): 몸의 칸을 그대로 ----------
function factsBody(ctx, host, doc) {
  const b = doc.body ?? {};
  const rows = Object.entries(b).filter(([, v]) => typeof v !== "object" || v === null);
  host.replaceChildren(
    sec({
      key: "설명",
      title: "설명",
      children: [
        el("dl", { class: "kv" }, rows.flatMap(([k, v]) => [el("dt", { class: "mono", text: k }), el("dd", { text: String(v ?? "—") })])),
      ],
    }),
  );
  return { sections: [{ key: "설명", title: "설명" }] };
}

// ---------- db-schema · msg-format: 슬롯 단위 클릭-투-편집 ----------
// A slot's text is clicked to edit in place (evidence chips, tier preview,
// word diff); saves are one PUT of the body with If-Match, and a 409 on the
// same slot opens the side-by-side reconcile card.
function slotBody(ctx, host) {
  const { type, id, canEdit, reload } = ctx;
  const canApprove = isAdmin() && !embed;
  const slots = ctx.data.slots;
  let editingAddr = null;
  let editBuf = null;
  let reconcileFor = null;
  const live = {};
  const slotByAddr = (addr) => slots.find((s) => s.address === addr);
  const notice = () => $("doc-notice");

  async function slotAction(verb, address, endpoint) {
    const r = await api(`/api/docs/${type}/${enc(id)}/${endpoint}`, { method: "POST", headers: { "if-match": ctx.rev }, body: { slots: [address] } });
    if (!r.ok) {
      toast(`${verb} 실패 (${r.status})`, "error");
      return;
    }
    reload();
  }
  function slotReadActions(slot) {
    const acts = [];
    if (canApprove && slot.tier === "inferred")
      acts.push(el("button", { type: "button", class: "btn promote sm", onclick: () => slotAction("확정", slot.address, "promote") }, ["확정", el("span", { class: "role", text: "admin" })]));
    if (canEdit && (slot.tier === "inferred" || slot.tier === "confirmed"))
      acts.push(el("button", { type: "button", class: "btn danger sm", onclick: () => slotAction("폐기", slot.address, "deprecate"), text: "폐기" }));
    if (slot.tier === "deprecated" && canEdit) acts.push(el("button", { type: "button", class: "btn ghost sm", onclick: () => startEdit(slot.address), text: "복원" }));
    return acts;
  }
  const tierTextClass = { scaffold: "t-sc", inferred: "t-inf", confirmed: "t-conf", deprecated: "t-conf" };
  function slotDirty() {
    if (!editingAddr || !editBuf) return false;
    const s = slotByAddr(editingAddr);
    if (!s) return false;
    return editBuf.text.trim() !== (s.text || "").trim() || editBuf.evidence.join(" ") !== (s.evidence || []).join(" ");
  }
  function startEdit(address) {
    if (editingAddr && editingAddr !== address && slotDirty()) {
      const open = host.querySelector(".slot-edit");
      if (open) {
        open.classList.remove("dirtyflash");
        void open.offsetWidth;
        open.classList.add("dirtyflash");
      }
      toast("저장하지 않은 편집이 있습니다 — 저장하거나 취소한 뒤 옮기세요.");
      return;
    }
    const slot = slotByAddr(address);
    editingAddr = address;
    reconcileFor = null;
    editBuf = { text: (slot && slot.text) || "", evidence: ((slot && slot.evidence) || []).slice() };
    paint();
  }
  function cancelEdit() {
    editingAddr = null;
    editBuf = null;
    reconcileFor = null;
    paint();
  }
  function slotReadText(slot) {
    const editable = canEdit && slot.tier !== "deprecated";
    // A [[ ]] chip inside the text is a link: its click and Enter move, not edit.
    const onChip = (e) => !!e.target.closest?.("a");
    const common = editable ? { title: "눌러서 편집", onclick: (e) => { if (!onChip(e)) startEdit(slot.address); }, tabindex: "0", role: "button", onkeydown: (e) => { if (e.key === "Enter" && !onChip(e)) startEdit(slot.address); } } : {};
    if (slot.tier === "scaffold") return el("span", { class: editable ? "t-sc editable" : "t-sc", text: "{{설명}}", ...common });
    // db-schema reads [[ ]] from these texts (src/wikilinks.mjs), so they draw
    // as md inline with chips. The \n stay lines (.slot-text, white-space).
    const text = slot.text || "";
    return el(
      "span",
      { class: `slot-text ${tierTextClass[slot.tier]}${slot.tier === "deprecated" ? " strike" : ""}${editable ? " editable" : ""}`, ...common },
      type === "db-schema" ? inline(text, { wiki: ctx.wiki }) : text,
    );
  }
  function nextTier(slot, text, textChanged) {
    if (!text.trim()) return "scaffold";
    if (!textChanged) return slot.tier;
    if (slot.tier === "confirmed" || slot.tier === "scaffold") return "inferred";
    return slot.tier;
  }
  function renderChips() {
    const box = live.chipBox;
    if (!box) return;
    for (const c of box.querySelectorAll(".evchip")) c.remove();
    const known = slotByAddr(editingAddr)?.evidence || [];
    editBuf.evidence.forEach((ev, idx) => {
      box.insertBefore(
        el("span", { class: `evchip${known.includes(ev) ? "" : " new"}` }, [
          ev,
          el("button", { type: "button", "aria-label": `근거 지우기: ${ev}`, text: "✕", onclick: () => { editBuf.evidence.splice(idx, 1); renderChips(); updateLive(); } }),
        ]),
        live.chipInput,
      );
    });
  }
  function commitChip() {
    const v = live.chipInput.value.trim().replace(/[;,]+$/, "").trim();
    if (v && !editBuf.evidence.includes(v)) editBuf.evidence.push(v);
    live.chipInput.value = "";
    renderChips();
    updateLive();
  }
  function updateLive() {
    const slot = slotByAddr(editingAddr);
    if (!slot || !live.tierLive) return;
    const textChanged = editBuf.text.trim() !== (slot.text || "").trim();
    const evChanged = editBuf.evidence.join(" ") !== (slot.evidence || []).join(" ");
    const changed = textChanged || evChanged;
    const to = nextTier(slot, editBuf.text, textChanged);
    live.tierLive.replaceChildren();
    if (to !== slot.tier) {
      const demote = slot.tier === "confirmed";
      live.tierLive.append(el("span", { class: `from ${demote ? "demote" : "keep"}` }, [tierBadge(slot.tier)]), el("span", { class: "arrow", text: "→" }), tierBadge(to));
      live.sealCap.hidden = false;
      live.sealCap.className = demote || to === "scaffold" ? "seal-cap" : "seal-cap promote";
      live.sealCap.textContent = to === "scaffold" ? "글을 비우면 이 슬롯은 빈칸으로 돌아갑니다." : demote ? "저장하면 확정이 풀립니다 — 다시 확정하려면 검토가 있어야 합니다." : "빈칸을 채우면 추정으로 들어갑니다.";
    } else {
      live.tierLive.appendChild(tierBadge(slot.tier));
      live.sealCap.hidden = true;
    }
    if (!changed) {
      live.save.disabled = true;
      live.save.title = "바뀐 것이 없습니다";
    } else if (textChanged && editBuf.evidence.length === 0) {
      live.save.disabled = true;
      live.save.title = "근거를 하나 이상 넣으세요 — 근거가 있어야 다음 사람이 확정합니다.";
    } else {
      live.save.disabled = false;
      live.save.title = "";
    }
    const body = live.diffBody;
    body.replaceChildren();
    if (!changed) {
      body.appendChild(el("span", { class: "dim", text: "아직 바뀐 것이 없습니다" }));
      return;
    }
    if (textChanged) {
      const wd = el("span", { class: "wd" });
      for (const p of wordDiff(slot.text || "", editBuf.text)) wd.appendChild(p.t === "eq" ? document.createTextNode(`${p.w} `) : el("span", { class: p.t, text: `${p.w} ` }));
      body.appendChild(el("div", { class: "diffline" }, [el("span", { class: "k", text: "글" }), wd]));
    }
    if (to !== slot.tier) body.appendChild(el("div", { class: "diffline" }, [el("span", { class: "k", text: "티어" }), el("span", {}, [tierBadge(slot.tier), document.createTextNode(" → "), tierBadge(to)])]));
    if (evChanged) {
      const evd = el("span", { class: "evd" });
      for (const e of slot.evidence || []) if (!editBuf.evidence.includes(e)) evd.appendChild(el("span", { class: "del", text: e }));
      for (const e of editBuf.evidence) if (!(slot.evidence || []).includes(e)) evd.appendChild(el("span", { class: "add", text: `+${e}` }));
      if (evd.childNodes.length) body.appendChild(el("div", { class: "diffline" }, [el("span", { class: "k", text: "근거" }), evd]));
    }
  }
  function editBlock(slot) {
    if (!editBuf) editBuf = { text: slot.text || "", evidence: (slot.evidence || []).slice() };
    const textArea = el("textarea", { spellcheck: "false", "aria-label": "슬롯 글" });
    textArea.value = editBuf.text;
    const chipInput = el("input", { type: "text", placeholder: "근거 file:line — 넣고 ; 또는 Enter", "aria-label": "근거" });
    Object.assign(live, {
      tierLive: el("span", { class: "tier-live" }),
      sealCap: el("div", { class: "seal-cap", hidden: true }),
      save: el("button", { type: "button", class: "btn primary sm", text: "저장", onclick: () => saveEdit(slot.address) }),
      diffBody: el("div", { class: "diffbody" }),
      chipInput,
      chipBox: el("div", { class: "chipfield" }, chipInput),
    });
    const grow = () => {
      textArea.style.height = "auto";
      textArea.style.height = `${textArea.scrollHeight}px`;
    };
    textArea.addEventListener("input", () => {
      editBuf.text = textArea.value;
      grow();
      updateLive();
    });
    chipInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ";" || e.key === ",") {
        e.preventDefault();
        commitChip();
      } else if (e.key === "Backspace" && !chipInput.value && editBuf.evidence.length) {
        editBuf.evidence.pop();
        renderChips();
        updateLive();
      }
    });
    chipInput.addEventListener("blur", () => {
      if (chipInput.value.trim()) commitChip();
    });
    const block = el("div", { class: "slot-edit" }, [
      el("div", { class: "toprow" }, live.tierLive),
      textArea,
      el("div", { class: "fieldlab", text: "근거 (evidence)" }),
      live.chipBox,
      live.sealCap,
      el("div", { class: "editacts" }, [
        live.save,
        el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: cancelEdit }),
        el("span", { class: "kbd" }, [el("b", { text: "esc" }), " 취소 · ", el("b", { text: "⌘/Ctrl+↵" }), " 저장"]),
      ]),
      el("details", { class: "diffbox" }, [el("summary", { text: "무엇이 바뀌나" }), live.diffBody]),
    ]);
    block.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!live.save.disabled) saveEdit(slot.address);
      }
    });
    setTimeout(() => {
      grow();
      renderChips();
      updateLive();
      textArea.focus();
      textArea.setSelectionRange(textArea.value.length, textArea.value.length);
    }, 0);
    return block;
  }
  function reconcileCard(address) {
    const theirs = getSlot(reconcileFor.doc.body, address) || {};
    const mineText = (editBuf && editBuf.text) || "";
    const mineEv = editBuf ? editBuf.evidence.slice() : [];
    const theirEv = theirs.evidence || [];
    const union = theirEv.concat(mineEv.filter((e) => !theirEv.includes(e)));
    const mergeTA = el("textarea", { spellcheck: "false", "aria-label": "합친 글" });
    mergeTA.value = theirs.text || "";
    const resolveWith = (text, ev) => commitSlot(address, text, ev, reconcileFor.doc.body, reconcileFor.rev);
    return el("div", { class: "reconcile" }, [
      el("div", { class: "rhead" }, ["충돌 — 같은 슬롯을 두 사람이 같이 고쳤습니다 ", el("span", { class: "addr", text: address })]),
      el("div", { class: "panes" }, [
        el("div", { class: "pane mine" }, [
          el("div", { class: "plab" }, [el("span", { text: "내 편집" }), el("span", { class: "who", text: currentUser.id })]),
          el("div", { class: "ptext", text: mineText }),
          el("div", { class: "pev", text: mineEv.join(" · ") || "근거 없음" }),
          el("button", { type: "button", class: "btn sm", text: "내 것으로", onclick: () => resolveWith(mineText, mineEv) }),
        ]),
        el("div", { class: "pane" }, [
          el("div", { class: "plab" }, [el("span", { text: "지금 저장본" }), el("span", { class: "who", text: theirs.by || "" })]),
          el("div", { class: "ptext", text: theirs.text || "" }),
          el("div", { class: "pev", text: theirEv.join(" · ") || "근거 없음" }),
          el("button", { type: "button", class: "btn sm", text: "상대 것으로", onclick: () => { editingAddr = null; editBuf = null; reconcileFor = null; reload(); } }),
        ]),
      ]),
      el("details", { class: "merge" }, [
        el("summary", { text: "직접 합치기 — 두 해석을 읽고 하나로" }),
        mergeTA,
        el("div", { class: "pev", text: `근거(합집합): ${union.join(" · ") || "없음"}` }),
        el("button", { type: "button", class: "btn primary sm", text: "이걸로 저장", onclick: () => { if (!mergeTA.value.trim()) return toast("글이 비었습니다."); resolveWith(mergeTA.value, union); } }),
      ]),
      el("div", { class: "rcancel" }, el("button", { type: "button", class: "btn ghost sm", text: "취소(내 편집 둠)", onclick: () => { reconcileFor = null; paint(); } })),
    ]);
  }
  function slotRow(slot, cls) {
    if (!slot) return el("div", { class: cls }, el("span", { class: "dim", text: "—" }));
    if (reconcileFor && reconcileFor.address === slot.address) return el("div", { class: cls, "data-addr": slot.address }, [reconcileCard(slot.address)]);
    if (editingAddr === slot.address) return el("div", { class: `${cls} editing`, "data-addr": slot.address }, [editBlock(slot)]);
    return el("div", { class: cls, "data-addr": slot.address }, [
      tierBadge(slot.tier),
      el("span", { class: cls === "ps" ? "txt2" : "txt3" }, [slotReadText(slot), ...evidence(slot.evidence)]),
      el("span", { class: "acts" }, slotReadActions(slot)),
    ]);
  }
  async function commitSlot(address, text, ev, baseBody, ifMatch) {
    const clientBody = structuredClone(baseBody);
    const existing = getSlot(clientBody, address) || {};
    setSlot(clientBody, address, { text: text.trim() || null, tier: existing.tier, evidence: ev.slice() });
    const r = await api(`/api/docs/${type}/${enc(id)}`, { method: "PUT", headers: { "if-match": ifMatch }, body: clientBody });
    await handleEditResult(r, address);
  }
  const saveEdit = (address) => editBuf && commitSlot(address, editBuf.text, editBuf.evidence, ctx.doc.body, ctx.rev);
  async function handleEditResult(r, address) {
    if (r.ok) {
      editingAddr = null;
      editBuf = null;
      reconcileFor = null;
      if (r.data.rebased) {
        await reload();
        toast("자동으로 합쳤습니다 — 다른 사람이 다른 슬롯을 고쳐서 두 편집이 다 남았습니다.");
        return;
      }
      ctx.setDocRev(r.data.json, r.data.rev);
      const entry = slots.find((s) => s.address === address);
      const saved = getSlot(ctx.doc.body, address) || {};
      // A [[ ]] added or dropped changed links[] and the chips: read the doc again.
      if (type === "db-schema" && /\[\[/.test(`${entry?.text ?? ""}${saved.text ?? ""}`)) {
        await reload();
        toast(saved.tier === "confirmed" ? "저장했습니다" : "저장했습니다 · 추정으로 들어감");
        return;
      }
      if (entry) Object.assign(entry, { text: saved.text ?? null, tier: saved.tier, evidence: saved.evidence || [] });
      notice()?.replaceChildren();
      paint();
      setTimeout(() => {
        const row = host.querySelector(`[data-addr="${CSS.escape(address)}"]`);
        row?.classList.add("shimmer");
        setTimeout(() => row?.classList.remove("shimmer"), 1000);
      }, 0);
      toast(saved.tier === "confirmed" ? "저장했습니다" : "저장했습니다 · 추정으로 들어감");
      invalidateDocs();
      return;
    }
    if (r.status === 409 && r.data?.error === "slot_conflict") {
      reconcileFor = { address, doc: r.data.current, rev: r.data.currentRev, overlap: r.data.overlap || [address] };
      paint();
      return;
    }
    if (r.status === 409) {
      notice()?.replaceChildren(
        el("div", { class: "notice" }, [
          el("strong", { text: "문서가 그 사이 바뀌었습니다 " }),
          el("span", { text: "— 다시 읽은 뒤 편집하세요." }),
          el("button", { type: "button", class: "btn ghost sm", onclick: () => reload(), text: "다시 읽기" }),
        ]),
      );
      return;
    }
    if (r.status === 400 && r.data?.error === "edit_rejected") {
      toast(r.data.message || "저장을 거절했습니다 (근거가 있어야 합니다).", "error");
      return;
    }
    toast(`저장 실패 (${r.status})${r.data?.message ? ` — ${r.data.message}` : ""}`, "error");
  }

  const b = () => ctx.doc.body;
  function paint() {
    const parts = [];
    if (type === "db-schema") {
      parts.push(sec({ key: "설명", title: "설명", children: [slotRow(slotByAddr("purpose"), "ps")] }));
      const pk = new Set(b().catalog?.primaryKey ?? []);
      const known = new Set((b().catalog?.columns || []).map((c) => c.name));
      const rows = (b().catalog?.columns || []).map((col) =>
        el("tr", {}, [
          el("td", { class: "mono nowrap" }, [col.name, pk.has(col.name) ? el("span", { class: "keychip", text: "키" }) : null]),
          el("td", { class: "mono dim nowrap", text: col.type }),
          el("td", { class: "dim nowrap", text: col.nullable ? "가능" : "—" }),
          el("td", {}, slotRow(slotByAddr(`columnDescs.${col.name}`), "cslot")),
        ]),
      );
      for (const s of slots) {
        const m = s.address.match(/^columnDescs\.(.+)$/);
        if (m && !known.has(m[1]))
          rows.push(el("tr", { class: "dep-row" }, [el("td", { class: "mono strike", text: m[1] }), el("td", { class: "dim", text: "—" }), el("td", { class: "dim", text: "열 사라짐" }), el("td", {}, slotRow(s, "cslot"))]));
      }
      const fk = (b().catalog?.foreignKeys || []).map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`).join(" · ");
      parts.push(
        sec({
          key: "열",
          title: "열",
          children: [
            el("div", { class: "tbl-wrap" }, el("table", { class: "cols-tbl" }, [
              el("thead", {}, el("tr", {}, ["열", "타입", "빈칸", "설명"].map((t) => el("th", { scope: "col", text: t })))),
              el("tbody", {}, rows),
            ])),
            el("p", { class: "dim small", text: `${fk ? `FK: ${fk} · ` : ""}수집 ${b().catalog?.fetchedAt ?? "—"} — 열 · 타입 · 빈칸은 catalog-push 로만 바뀝니다.` }),
          ],
        }),
      );
      if (b().queries?.length)
        parts.push(
          sec({
            key: "쓰는 법",
            title: "쓰는 법",
            children: b().queries.flatMap((q, i) => [slotRow(slotByAddr(`queries[${i}].note`), "ps"), el("pre", { class: "md-code lang-sql" }, el("code", { text: q.sql }))]),
          }),
        );
    } else {
      parts.push(sec({ key: "설명", title: "설명", children: [el("p", { class: "dim", text: b().direction === "host->equipment" ? "Host → Equipment" : "Equipment → Host" }), slotRow(slotByAddr("purpose"), "ps")] }));
      parts.push(
        sec({
          key: "필드",
          title: "필드",
          children: [
            el("div", { class: "tbl-wrap" }, el("table", { class: "cols-tbl" }, [
              el("thead", {}, el("tr", {}, ["#", "필드", "타입", "필수", "설명"].map((t) => el("th", { scope: "col", text: t })))),
              el("tbody", {}, (b().fields || []).map((f, i) =>
                el("tr", {}, [
                  el("td", { class: "dim", text: String(f.seq) }),
                  el("td", { class: "mono", text: f.name }),
                  el("td", { class: "mono dim", text: f.type }),
                  el("td", { text: f.required ? "✓" : "—" }),
                  el("td", {}, slotRow(slotByAddr(`fields[${i}].desc`), "cslot")),
                ]),
              )),
            ])),
          ],
        }),
      );
    }
    parts.push(
      el("p", { class: "rnote", text: canEdit ? "설명 글을 누르면 그 자리에서 고칩니다 · 확정을 고치면 추정으로 내려갑니다 · 흐름: 빈칸 → 추정 → 확정" : "확정 · 폐기는 슬롯마다 합니다" }),
    );
    host.replaceChildren(...parts);
  }
  paint();
  const sections = type === "db-schema"
    ? [{ key: "설명", title: "설명" }, { key: "열", title: "열" }, ...(b().queries?.length ? [{ key: "쓰는 법", title: "쓰는 법" }] : [])]
    : [{ key: "설명", title: "설명" }, { key: "필드", title: "필드" }];
  return { sections };
}

