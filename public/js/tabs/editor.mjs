// 절 편집(4-6): 원문 | 미리보기 두 칸. 원문은 절 블록(머리 · 줄 범위 · 바뀜 ·
// 접기 · 절 저장)으로 나뉘고, 미리보기도 같은 절 경계로 나뉜다. 미리보기의 절을
// 누르면 원문의 그 블록이 펼쳐진다(4-7). 왼쪽 48 띠를 펼치면 절 목록(4-8).
// 읽기 화면의 절 [편집] 은 그 블록만 펼친 채로(4-5), [전체 편집] 은 전부 펼쳐 연다.
// 저장은 절 저장도 문서 저장도 문서 전체 PUT(If-Match rev) 한 번이다.
import { allDocs, api, invalidateDocs } from "../api.mjs";
import { el, icon, toast } from "../dom.mjs";
import { mdNodes, wikiResolver } from "../md.mjs";
import { setLeaveGuard } from "../router.mjs";
import { VERIFY_KEY, dataIdConflictText, flowLib, shortRev, skillSectionsLib } from "../shared.mjs";
import { screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { TYPE_LABEL, canEdit, isMdType, typeColor } from "../state.mjs";
import { changedKeys, joinBlocks, lineRanges, splitBlocks, withBlock } from "/lib/sections.mjs";
import { docTitle, isSkillType } from "./doc-view.mjs";
import { typeLabel } from "./docs.mjs";

const enc = encodeURIComponent;
const HEAD = "__head";
const VIEW_KEY = "akg_editor_view";
const SYNC_KEY = "akg_editor_sync";
const read = (k, d) => {
  try {
    return localStorage.getItem(k) ?? d;
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage off: the choice lasts until the next screen */
  }
};

let editorTicket = 0;

export async function renderEditor(type, id, focusKey) {
  const ticket = ++editorTicket;
  const back = `#/doc/${type}/${enc(id)}`;
  if (!isSkillType(type) && !isMdType(type)) return location.replace(back);
  if (!canEdit()) {
    toast("admin 만 고칠 수 있습니다.", "error");
    return location.replace(back);
  }
  const [res, docs, lib, flow, facts] = await Promise.all([
    api(`/api/docs/${type}/${enc(id)}`),
    allDocs(),
    skillSectionsLib,
    isSkillType(type) ? flowLib : null,
    isSkillType(type) ? api("/api/flow-facts") : null,
  ]);
  if (ticket !== editorTicket) return;
  if (!res.ok) {
    toast(`문서를 불러오지 못했습니다 (${res.status})`, "error");
    return location.replace(back);
  }
  let doc = res.data.json;
  let rev = res.data.rev;
  const title = docTitle(type, doc);
  const isAgent = type === "domain-skill" && (doc.role ?? "main") === "main";
  setActiveTab(isAgent ? "agents" : "docs");
  setCrumbs([
    ...(isAgent ? [{ label: "에이전트", href: "#/agents" }] : [{ label: "문서", href: "#/docs" }, { label: typeLabel(type), href: `#/docs/${type}` }]),
    { label: title, href: back },
    { label: "편집" },
  ]);

  // The split: a skill on its known sections (when the md splits), any other
  // md on every ##.
  const skillOpts =
    isSkillType(type) && lib
      ? { skill: lib, order: isAgent ? lib.SKILL_SECTIONS : lib.SKILL_SECTIONS.filter((s) => s.key !== VERIFY_KEY) }
      : {};
  function splitOf(md) {
    try {
      return { split: splitBlocks(md, skillOpts), opts: skillOpts };
    } catch {
      return { split: splitBlocks(md), opts: {} };
    }
  }
  let { split: saved, opts } = splitOf(doc.body?.markdown ?? "");
  // Working copies: body per key, and the head (plain md only).
  const edited = new Map(saved.blocks.map((b) => [b.key, b.body]));
  let editedHead = saved.head;
  const open = new Set(focusKey ? [focusKey] : saved.blocks.map((b) => b.key));
  if (focusKey && !saved.blocks.some((b) => b.key === focusKey)) saved.blocks.forEach((b) => open.add(b.key));
  let cursorKey = focusKey ?? saved.blocks[0]?.key ?? null;
  let listOpen = false;
  let view = read(VIEW_KEY, "both");
  let sync = read(SYNC_KEY, "1") === "1";
  let conflict = false;

  const blocksNow = () => saved.blocks.map((b) => ({ ...b, body: edited.get(b.key) ?? b.body }));
  // The save's flow check run here before saving (src/flow/agent-md.mjs), on
  // the md as it would be saved: lines for the 데이터 section's flow figure.
  const registry = facts?.ok ? facts.data.mds : null;
  function flowNotes() {
    if (!flow || !registry || saved.mode !== "skill") return null;
    const md = joinBlocks({ ...saved, head: editedHead }, blocksNow(), opts);
    const mine = flow.readAgentMd(id, md);
    if (!mine.fence) return null;
    if (mine.flowErrors.length) return mine.flowErrors.map((e) => `${flow.mdLine(e, mine.fence.line)} 줄 ${e.code} ${e.message}`);
    if (mine.chartErrors.length) return mine.chartErrors.map((e) => `${e.line} 줄 ${e.code} ${e.message}`);
    if (mine.rejection) return [mine.rejection];
    return flow
      .saveCheck(registry, { type, id, markdown: md, active: true })
      .errors.map((e) => `${e.line > 0 ? `${flow.mdLine(e, mine.fence.line)} 줄 ` : ""}${e.code} ${e.message}`);
  }
  // The other agent mds the last save broke (the server's flowWarnings), for the save toast.
  let flowWarn = null;
  const savedToast = (message) => toast(flowWarn ? `${message} — ${flowWarn}` : message, flowWarn ? "error" : undefined);
  const dirtyKeys = () => changedKeys(saved.blocks, blocksNow());
  const headDirty = () => saved.mode === "plain" && editedHead !== saved.head;
  const anyDirty = () => dirtyKeys().length > 0 || headDirty();
  setLeaveGuard(() => (anyDirty() ? "저장하지 않은 절이 있습니다. 버리고 나갈까요?" : null));

  const wiki = wikiResolver(res.data.wikilinks, docs);
  const status = el("span", { class: "ed-status" });
  const cursorPos = el("span", { class: "dim ed-pos" });
  const notice = el("div", { class: "ed-notice", role: "alert", hidden: true });
  const srcList = el("div", { class: "ed-blocks" });
  const preview = el("div", { class: "ed-preview-body" });
  const bottomInfo = el("span", { class: "ed-changed" });
  const saveDocBtn = el("button", { type: "button", class: "btn primary", text: "문서 저장", onclick: () => saveDoc() });
  const sectionList = el("ul", { class: "ed-seclist" });

  // ---------- 저장 ----------
  async function put(markdown, note) {
    const r = await api(`/api/docs/${type}/${enc(id)}`, {
      method: "PUT",
      headers: { "if-match": rev, "x-akg-note": encodeURIComponent(note) },
      body: { ...doc.body, markdown },
    });
    if (r.ok) {
      doc = r.data.json;
      rev = r.data.rev;
      const broken = r.data.flowWarnings ?? [];
      flowWarn = broken.length ? `이 저장으로 플로우가 깨진 md: ${broken.map((b) => b.md).join(" · ")}` : null;
      invalidateDocs();
      return true;
    }
    const d = r.data || {};
    if (r.status === 409 && d.error !== "data_id_conflict") {
      conflict = true;
      notice.hidden = false;
      notice.replaceChildren(
        el("b", { text: "다른 사람이 먼저 저장했습니다. " }),
        el("span", { text: "지금 편집은 이 화면에 남아 있습니다. 다시 읽으면 최신 문서로 열립니다." }),
        el("button", {
          type: "button",
          class: "btn sm",
          text: "다시 읽기",
          onclick: () => {
            if (anyDirty() && !confirm("이 화면의 편집을 버리고 최신 문서를 다시 읽습니다.")) return;
            setLeaveGuard(null);
            renderEditor(type, id, focusKey);
          },
        }),
      );
      return false;
    }
    if (d.error === "data_id_conflict") toast(dataIdConflictText(d), "error");
    else if (r.status === 403) toast("admin 만 할 수 있습니다.", "error");
    else toast(`저장 실패 (${r.status})${d.message ? ` — ${d.message}` : ""}${d.details ? ` — ${[].concat(d.details).join(" · ")}` : ""}`, "error");
    return false;
  }

  async function saveSection(key, button) {
    if (conflict) return toast("먼저 다시 읽기를 하세요.", "error");
    const block = saved.blocks.find((b) => b.key === key);
    if (!block || !dirtyKeys().includes(key)) return;
    if (button) button.disabled = true;
    const md = withBlock(saved, key, edited.get(key), opts);
    const ok = await put(md, `절 저장: ${block.heading}`);
    if (button) button.disabled = false;
    if (!ok) return;
    const keep = new Map(edited);
    const keepHead = editedHead;
    ({ split: saved, opts } = splitOf(doc.body.markdown ?? ""));
    for (const b of saved.blocks) edited.set(b.key, b.key === key ? b.body : keep.get(b.key) ?? b.body);
    editedHead = keepHead;
    savedToast(`절 저장: ${block.heading}`);
    paint();
  }

  async function saveDoc() {
    if (conflict) return toast("먼저 다시 읽기를 하세요.", "error");
    if (!anyDirty()) return toast("바뀐 절이 없습니다.");
    saveDocBtn.disabled = true;
    const changed = dirtyKeys();
    const md = joinBlocks({ ...saved, head: editedHead }, blocksNow(), opts);
    const ok = await put(md, `문서 저장: 바뀐 절 ${changed.length}${headDirty() ? " · 머리" : ""}`);
    saveDocBtn.disabled = false;
    if (!ok) return;
    setLeaveGuard(null);
    savedToast("문서를 저장했습니다");
    location.hash = `#/doc/${type}/${enc(id)}`;
  }

  function close() {
    if (anyDirty() && !confirm("저장하지 않은 절이 있습니다. 버리고 닫을까요?")) return;
    setLeaveGuard(null);
    location.hash = back;
  }

  // ---------- 원문 블록 ----------
  const ranges = () => lineRanges(saved, blocksNow(), opts);
  function gutterFor(ta, gutter, mirror, firstLine) {
    const lines = ta.value.split("\n");
    mirror.style.width = `${ta.clientWidth}px`;
    mirror.replaceChildren(...lines.map((l) => el("div", { text: l || "​" })));
    gutter.replaceChildren(
      ...lines.map((_, i) => {
        const h = mirror.children[i]?.getBoundingClientRect().height || 20;
        return el("div", { text: String(firstLine + i), style: { height: `${h}px` } });
      }),
    );
    ta.style.height = `${Math.max(mirror.getBoundingClientRect().height, 40) + 12}px`;
  }

  function blockNode(b, r) {
    const isOpen = open.has(b.key);
    const changed = dirtyKeys().includes(b.key);
    const save = el("button", { type: "button", class: "btn sm primary ed-save", disabled: !changed || conflict, text: "절 저장" });
    save.addEventListener("click", () => saveSection(b.key, save));
    const revert = el("button", {
      type: "button",
      class: "btn sm ghost",
      text: "취소",
      disabled: !changed,
      onclick: () => {
        edited.set(b.key, saved.blocks.find((x) => x.key === b.key).body);
        paint();
      },
    });
    const head = el("div", { class: "ed-bh" }, [
      el("button", {
        type: "button",
        class: "ed-fold",
        "aria-expanded": String(isOpen),
        "aria-label": `${b.heading} ${isOpen ? "접기" : "펼치기"}`,
        onclick: () => {
          if (open.has(b.key)) open.delete(b.key);
          else open.add(b.key);
          paint();
        },
      }, icon(isOpen ? "down" : "right", 14)),
      el("span", { class: "ed-hash mono", text: "##" }),
      el("b", { class: "ed-bt", text: b.heading }),
      el("span", { class: "dim mono ed-range", text: r ? `줄 ${r.from}-${r.to}` : "비어 있음" }),
      changed ? el("span", { class: "chip changed-chip", text: "바뀜" }) : null,
      el("span", { class: "sp" }),
      cursorKey === b.key && isOpen ? el("span", { class: "ed-keys" }, [el("kbd", { text: "esc" }), el("kbd", { text: "⌘↩" })]) : null,
      changed ? revert : null,
      save,
    ]);
    const node = el("section", { class: `ed-block${isOpen ? " open" : ""}${changed ? " changed" : ""}${cursorKey === b.key ? " cur" : ""}`, "data-key": b.key, "aria-label": b.heading }, [head]);
    if (!isOpen) return node;
    const ta = el("textarea", { class: "ed-ta", spellcheck: "false", "aria-label": `## ${b.heading} 원문`, wrap: "soft" });
    ta.value = edited.get(b.key) ?? "";
    const gutter = el("div", { class: "ed-gutter", "aria-hidden": "true" });
    const mirror = el("div", { class: "ed-mirror", "aria-hidden": "true" });
    const first = r?.bodyFrom ?? 1;
    const refit = () => gutterFor(ta, gutter, mirror, first);
    ta.addEventListener("input", () => {
      edited.set(b.key, ta.value);
      refit();
      refreshMarks(b.key);
      paintPreview();
    });
    const where = () => {
      const before = ta.value.slice(0, ta.selectionStart).split("\n");
      cursorPos.textContent = `줄 ${first + before.length - 1} · 열 ${before[before.length - 1].length + 1}`;
      if (cursorKey !== b.key) {
        cursorKey = b.key;
        for (const n of srcList.querySelectorAll(".ed-block")) n.classList.toggle("cur", n.dataset.key === b.key);
        paintPreview();
        if (sync) preview.querySelector(`[data-key="${CSS.escape(b.key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    };
    ta.addEventListener("focus", where);
    ta.addEventListener("click", where);
    ta.addEventListener("keyup", where);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault();
        saveDoc();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        saveSection(b.key, save);
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    });
    node.append(el("div", { class: "ed-src" }, [gutter, el("div", { class: "ed-ta-wrap" }, [ta, mirror])]));
    requestAnimationFrame(refit);
    new ResizeObserver(refit).observe(ta);
    return node;
  }

  function headNode() {
    const onlyTitle = (h) => h.split("\n").every((l) => l.trim() === "" || /^#\s+/.test(l));
    if (saved.mode !== "plain" || (onlyTitle(saved.head) && editedHead === saved.head)) {
      return saved.title !== null
        ? el("div", { class: "ed-title mono" }, [el("span", { class: "dim", text: "1 " }), `# ${saved.title}`])
        : null;
    }
    const ta = el("textarea", { class: "ed-ta ed-head-ta", spellcheck: "false", "aria-label": "머리(# 제목과 첫 글)", rows: Math.max(2, editedHead.split("\n").length) });
    ta.value = editedHead;
    ta.addEventListener("input", () => {
      editedHead = ta.value;
      refreshMarks(HEAD);
      paintPreview();
    });
    return el("div", { class: `ed-block open ed-headblock${headDirty() ? " changed" : ""}` }, [
      el("div", { class: "ed-bh" }, [el("b", { class: "ed-bt", text: "머리" }), el("span", { class: "dim", text: "# 제목과 첫 ## 앞의 글 — 문서 저장으로 저장합니다" })]),
      el("div", { class: "ed-src" }, ta),
    ]);
  }

  // Marks that follow typing without a repaint (the caret stays put).
  function refreshMarks() {
    const keys = dirtyKeys();
    for (const n of srcList.querySelectorAll(".ed-block[data-key]")) {
      const changed = keys.includes(n.dataset.key);
      n.classList.toggle("changed", changed);
      const save = n.querySelector(".ed-save");
      if (save) save.disabled = !changed || conflict;
      let chip = n.querySelector(".changed-chip");
      if (changed && !chip) {
        chip = el("span", { class: "chip changed-chip", text: "바뀜" });
        n.querySelector(".ed-range")?.after(chip);
      } else if (!changed && chip) chip.remove();
    }
    paintStatus();
    paintSectionList();
  }

  function paintStatus() {
    const keys = dirtyKeys();
    const n = keys.length + (headDirty() ? 1 : 0);
    const names = keys.map((k) => saved.blocks.find((b) => b.key === k)?.heading ?? k);
    status.replaceChildren(
      el("span", { class: `chip ${n ? "warnchip" : ""}`, text: n ? `저장 안 됨 · 바뀐 절 ${n}` : "저장됨" }),
    );
    bottomInfo.replaceChildren(el("b", { text: `바뀐 절 ${n}` }), ...(names.length ? [el("span", { class: "dim", text: ` · ${names.join(" · ")}` })] : []));
    saveDocBtn.disabled = !n || conflict;
  }

  function paintSectionList() {
    const r = ranges();
    const keys = dirtyKeys();
    sectionList.replaceChildren(
      ...saved.blocks.map((b) =>
        el("li", {}, el("button", { type: "button", class: `ed-sec${cursorKey === b.key ? " on" : ""}`, onclick: () => focusBlock(b.key) }, [
          el("span", { class: "ed-sec-t", text: b.heading }),
          el("span", { class: "dim mono", text: r.get(b.key) ? `${r.get(b.key).from}-${r.get(b.key).to}` : "—" }),
          keys.includes(b.key) ? el("span", { class: "ed-dot", "aria-label": "바뀜" }) : null,
        ])),
      ),
    );
  }

  function focusBlock(key) {
    open.add(key);
    cursorKey = key;
    paint();
    const node = srcList.querySelector(`[data-key="${CSS.escape(key)}"]`);
    node?.scrollIntoView({ block: "start", behavior: "smooth" });
    node?.querySelector("textarea")?.focus({ preventScroll: true });
  }

  function paintPreview() {
    const r = ranges();
    const parts = [];
    const headText = saved.mode === "plain" ? editedHead.split("\n").filter((l) => !/^#\s+/.test(l)).join("\n").trim() : "";
    // ```mermaid figures redraw 300ms after typing stops; errors carry the
    // document line, as the gutter numbers it.
    const fig = (key, lineBase) => ({ key, lineBase, delay: 300, source: false });
    const notes = flowNotes();
    if (headText) parts.push(el("div", { class: "ed-pv-head" }, mdNodes(headText, { wiki, mermaid: fig(HEAD, null) })));
    for (const b of saved.blocks) {
      const body = edited.get(b.key) ?? "";
      const cur = cursorKey === b.key;
      parts.push(
        el("section", {
          class: `ed-pv${cur ? " cur" : ""}`,
          "data-key": b.key,
          tabindex: "0",
          role: "button",
          "aria-label": `${b.heading} — 원문에서 열기`,
          onclick: (e) => {
            if (e.target.closest("a")) return;
            focusBlock(b.key);
          },
          onkeydown: (e) => {
            if (e.key === "Enter") focusBlock(b.key);
          },
        }, [
          el("div", { class: "ed-pv-meta" }, [el("span", { class: "dim mono", text: r.get(b.key) ? `줄 ${r.get(b.key).from}-${r.get(b.key).to}` : "비어 있음" }), cur ? el("span", { class: "chip curchip", text: "커서 절" }) : null]),
          el("h2", { class: "sec-t", text: b.heading }),
          el("div", { class: "sec-b" }, body.trim() ? mdNodes(body, { wiki, mermaid: { ...fig(b.key, r.get(b.key)?.bodyFrom ?? null), flowNotes: b.key === "데이터" ? notes : null } }) : [el("p", { class: "dim", text: "비어 있습니다" })]),
        ]),
      );
    }
    preview.replaceChildren(...parts);
  }

  // ---------- 틀 ----------
  const seg = el("div", { class: "seg", role: "group", "aria-label": "보기" }, [
    ["src", "원문"],
    ["both", "나란히"],
    ["preview", "미리보기"],
  ].map(([v, label]) => el("button", { type: "button", "aria-pressed": String(view === v), text: label, onclick: () => { view = v; write(VIEW_KEY, v); paint(); } })));
  const syncBox = el("input", { type: "checkbox", checked: sync, onchange: (e) => { sync = e.currentTarget.checked; write(SYNC_KEY, sync ? "1" : "0"); } });
  const band = el("aside", { class: "panel left ed-band", "aria-label": "절 목록" });
  const panes = el("div", { class: "ed-panes" });
  const body = el("main", { class: "main ed-main", "aria-label": `${title} 편집` }, [
    el("div", { class: "ed-top" }, [
      el("h1", { class: "ed-h1", text: title }),
      el("span", { class: "chip", text: `${id}.md` }),
      el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
      status,
      el("span", { class: "sp" }),
      seg,
      el("label", { class: "ed-sync" }, [syncBox, " 스크롤 맞춤"]),
      el("span", { class: "dim ed-hint", text: "블록마다 [절 저장] · 아래 띠 [문서 저장]" }),
    ]),
    notice,
    panes,
  ]);
  const foot = el("div", { class: "ed-foot" }, [
    bottomInfo,
    el("span", { class: "ed-foot-keys" }, [
      el("kbd", { text: "⌘↩" }), " 커서 절 저장 ",
      el("kbd", { text: "⇧⌘↩" }), " 문서 저장 ",
      el("kbd", { text: "esc" }), " 닫기",
    ]),
    el("span", { class: "sp" }),
    el("button", { type: "button", class: "btn", text: "닫기", onclick: close }),
    saveDocBtn,
  ]);
  const wrap = el("div", { class: "ed-layout" }, [band, body]);
  const root = screen();
  root.append(wrap, foot);
  root.classList.add("has-foot");

  function paintBand() {
    band.classList.toggle("open", listOpen);
    wrap.classList.toggle("list-open", listOpen);
    const toggle = el("button", {
      type: "button",
      class: "icon-btn",
      "aria-expanded": String(listOpen),
      "aria-label": listOpen ? "절 목록 접기" : "절 목록 펼치기",
      title: "절 목록",
      onclick: () => { listOpen = !listOpen; paintBand(); },
    }, icon(listOpen ? "left" : "columns", 17));
    if (!listOpen) {
      band.replaceChildren(
        el("div", { class: "band" }, [
          el("span", { class: "tdot band-dot", style: { "--c": typeColor(type) }, title: TYPE_LABEL[type] ?? type }),
          toggle,
          el("button", { type: "button", class: "icon-btn", "aria-label": "찾기 (⌘K)", title: "찾기 (⌘K)", onclick: () => document.dispatchEvent(new CustomEvent("akg:cmdk")) }, icon("search", 17)),
        ]),
      );
      return;
    }
    band.replaceChildren(
      el("div", { class: "ed-band-h" }, [el("b", { text: "절" }), el("span", { class: "dim", text: `${saved.blocks.length}` }), el("span", { class: "sp" }), toggle]),
      el("div", { class: "panel-scroll" }, sectionList),
    );
    paintSectionList();
  }

  function paint() {
    const r = ranges();
    srcList.replaceChildren(...[headNode(), ...saved.blocks.map((b) => blockNode(b, r.get(b.key)))].filter(Boolean));
    paintPreview();
    paintStatus();
    paintBand();
    for (const btn of seg.children) btn.setAttribute("aria-pressed", String(btn.textContent === { src: "원문", both: "나란히", preview: "미리보기" }[view]));
    panes.className = `ed-panes view-${view}`;
    const srcPane = el("div", { class: "ed-pane ed-src-pane" }, [
      el("div", { class: "ed-pane-h" }, [el("b", { text: "md 원문 · 절 블록" }), el("span", { class: "dim mono", text: `${id}.md` }), el("span", { class: "sp" }), cursorPos]),
      el("div", { class: "ed-pane-b" }, srcList),
    ]);
    const pvPane = el("div", { class: "ed-pane ed-pv-pane" }, [
      el("div", { class: "ed-pane-h" }, [el("b", { text: "미리보기" }), el("span", { class: "dim", text: "같은 절 경계 · 커서 절이 켜짐 · 절을 누르면 원문이 열림" })]),
      el("div", { class: "ed-pane-b" }, preview),
    ]);
    panes.replaceChildren(...(view === "src" ? [srcPane] : view === "preview" ? [pvPane] : [srcPane, pvPane]));
  }
  paint();
  if (focusKey) requestAnimationFrame(() => focusBlock(focusKey));
}
