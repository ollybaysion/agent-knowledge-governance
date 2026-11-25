// 표 보기 (#/table): 문서 전부를 한 표로. 왼쪽 패싯(타입 · 상태 · 수정 · 연결 ·
// 크기 · 제목)으로 거르고 열 머리로 정렬한다. 보기 상태는 주소 해시에 담겨서
// 주소를 건네면 같은 보기가 열린다. 개요 탭의 문서 표도 같은 표(docTable)를 쓴다.
// admin 은 줄을 골라 한 번에 활성화 · 비활성화 · 태그 붙이기를 한다. 결과는 표 아래
// 줄(role=status)에 서고, 그 줄의 [되돌리기] 가 방금 한 일을 되돌린다(lib/table-bulk.mjs).
import { api, everyDoc, invalidateDocs } from "../api.mjs";
import { docLink, freshBadge, idNote, num, sizeText, typeTag, viewSwitch } from "../doc-bits.mjs";
import { el, icon } from "../dom.mjs";
import { STATUS_LABEL, statusBadge, tierMeter } from "../shared.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { DOC_TYPES, TYPE_LABEL, canEdit, mdTypeIds, typeColor } from "../state.mjs";
import { dialogNames, rowKey, typeCounts } from "/lib/doc-bulk.mjs";
import { FACETS, activeCount, emptyState, facetCounts, filterRows, parseState, sortRows, tableHash, toggleFacet, toggleSort } from "/lib/doc-table.mjs";
import { BROKEN_LABEL, docFacts } from "/lib/health.mjs";
import { UNDO, VERB, cleanTag, headOf, keepVisible, outcome, plan, requests, runToast } from "/lib/table-bulk.mjs";

// 한 번에 그리는 줄 수. 다음 줄들은 마지막 줄이 보일 때 더 그린다.
const PAGE = 200;

const COLUMNS = [
  { id: "title", label: "문서" },
  { id: "type", label: "타입" },
  { id: null, label: "검토 상태" },
  { id: "status", label: "상태" },
  { id: "updated", label: "수정" },
  { id: "size", label: "크기", num: true, title: "본문 글자 수" },
  { id: "links", label: "연결", num: true, title: "가리켜지는 수 ← · → 가리키는 수" },
];

const brokenTitle = (row) => row.broken.map((b) => `${BROKEN_LABEL[b.kind]}: ${b.target}`).join("\n");

/** A row; `pick` (admin's table) adds the box in front: { has(key), toggle(key, box) }. */
function rowOf(row, pick) {
  const d = row.doc;
  const open = (e) => {
    if (e.target.closest("a, button, input, label")) return;
    location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`;
  };
  const key = rowKey(d);
  const on = !!pick?.has(key);
  return el("tr", { class: `nav-doc${on ? " picked" : ""}`, onclick: open }, [
    pick
      ? el("td", { class: "dt-pick" }, el("label", { class: "dt-box" }, el("input", {
          type: "checkbox",
          checked: on,
          "data-pick": key,
          "aria-label": `${d.title ?? d.id} 고르기`,
          onchange: (e) => pick.toggle(key, e.currentTarget),
        })))
      : null,
    el("td", { class: "dt-doc" }, el("span", { class: "dt-name" }, [docLink(d), idNote(d, "dt-id")])),
    el("td", {}, typeTag(d.type)),
    // 슬롯이 없는 문서(md 타입)는 검토할 티어가 없다.
    el("td", { class: "dt-tier" }, Object.values(d.tiers ?? {}).some(Boolean) ? tierMeter(d.tiers) : el("span", { class: "dim", title: "티어를 매기는 슬롯이 없는 문서입니다", text: "—" })),
    el("td", {}, statusBadge(d.status)),
    el("td", {}, freshBadge(d.updatedAt)),
    el("td", { class: "num", text: sizeText(row.size), title: row.size == null ? "크기가 없습니다" : `${num(row.size)}자` }),
    el("td", { class: "num dt-links" }, [
      el("span", { class: row.in + row.out ? "" : "dim", title: `가리켜짐 ${row.in} · 가리킴 ${row.out}`, text: `← ${row.in} · → ${row.out}` }),
      row.broken.length ? el("span", { class: "dt-broken", title: brokenTitle(row), text: `끊김 ${row.broken.length}` }) : null,
    ]),
  ]);
}

/**
 * 정렬되는 문서 표. rows = 이미 거르고 정렬한 줄, state = {sort, dir},
 * onSort(열 id) = 열 머리를 눌렀을 때. pick = 고르기 칸(admin 의 표 보기):
 * { has(key), toggle(key, box), head: { state: "none" | "some" | "all", toggle(box) } }.
 * → 표를 든 노드.
 */
export function docTable({ rows, state, onSort, empty, pick = null }) {
  if (!rows.length) return el("div", { class: "dt-empty" }, empty ?? el("p", { class: "loading", text: "문서가 없습니다." }));
  const headBox = pick
    ? el("input", { type: "checkbox", "data-pick-all": "", "aria-label": `거른 문서 ${num(rows.length)} 개 전부 고르기`, onchange: (e) => pick.head.toggle(e.currentTarget) })
    : null;
  if (headBox) {
    headBox.checked = pick.head.state === "all";
    headBox.indeterminate = pick.head.state === "some";
  }
  const head = el("tr", {}, [pick ? el("th", { scope: "col", class: "dt-pick" }, el("label", { class: "dt-box" }, headBox)) : null, ...COLUMNS.map((c) => {
    if (!c.id) return el("th", { scope: "col", class: "dt-tier", text: c.label });
    const on = state.sort === c.id;
    return el("th", { scope: "col", class: c.num ? "num" : "", "aria-sort": on ? (state.dir === "asc" ? "ascending" : "descending") : "none" },
      el("button", { type: "button", class: `th-sort${on ? " on" : ""}`, "data-fk": `sort:${c.id}`, title: c.title ?? null, onclick: () => onSort(c.id) }, [
        c.label,
        on ? icon(state.dir === "asc" ? "up" : "down", 12) : null,
      ]));
  })]);
  const rowOfPick = (r) => rowOf(r, pick);
  let drawn = Math.min(PAGE, rows.length);
  const tbody = el("tbody", {}, rows.slice(0, drawn).map(rowOfPick));
  const table = el("table", { class: "dt" }, [el("thead", {}, head), tbody]);
  if (drawn < rows.length) {
    if (typeof IntersectionObserver === "undefined") tbody.append(...rows.slice(drawn).map(rowOfPick));
    else {
      const watch = el("tr", { "aria-hidden": "true" });
      tbody.appendChild(watch);
      const observer = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (!watch.isConnected) return observer.disconnect();
        watch.before(...rows.slice(drawn, drawn + PAGE).map(rowOfPick));
        drawn = Math.min(drawn + PAGE, rows.length);
        observer.unobserve(watch);
        if (drawn < rows.length) observer.observe(watch);
        else {
          watch.remove();
          observer.disconnect();
        }
      }, { rootMargin: "0px 0px 800px 0px" });
      observer.observe(watch);
    }
  }
  return el("div", { class: "dt-wrap" }, table);
}

/** 패싯 값의 화면 글: 타입은 타입 이름, 상태는 상태 이름, 그 밖은 패싯에 적힌 글. */
function valueLabel(facet, value) {
  if (facet.id === "type") return TYPE_LABEL[value] ?? value;
  if (facet.id === "status") return STATUS_LABEL[value] ?? value;
  return facet.values?.find(([v]) => v === value)?.[1] ?? value;
}

export async function renderDocTable() {
  setActiveTab("docs");
  setCrumbs([{ label: "문서", href: "#/docs" }, { label: "표 보기" }]);
  const facetsHost = el("div", { class: "panel-scroll fct" });
  const tableHost = el("div", { class: "dt-host" });
  const countEl = el("span", { class: "dim dt-count", role: "status" });
  const chipsEl = el("div", { class: "dt-active" });
  const input = el("input", { type: "search", class: "dt-q", placeholder: "id · 제목 · 키워드", "aria-label": "문서 찾기", autocomplete: "off", spellcheck: "false" });
  // 고른 문서 띠와 방금 한 일(되돌리기): 표 아래에 붙고, 표가 길면 화면 아래에 떠 있다.
  const bandEl = el("div", { class: "dt-bulk", role: "group", "aria-label": "고른 문서", hidden: true });
  const undoEl = el("div", { class: "dt-undo", role: "status", hidden: true });
  const card = el("section", { class: "page-card dtable", "aria-label": "문서 표" }, [
    el("div", { class: "dt-bar" }, [viewSwitch("table"), el("label", { class: "dt-find" }, [icon("search", 14), input]), countEl]),
    chipsEl,
    tableHost,
    el("div", { class: "dt-dock" }, [undoEl, bandEl]),
  ]);
  screen().appendChild(cols({
    left: panel("left facets", [el("div", { class: "fct-head" }, [el("b", { text: "거르기" }), el("span", { class: "sp" })]), facetsHost], "거르기"),
    main: el("main", { class: "main wide" }, card),
    className: "wide",
  }));
  tableHost.replaceChildren(el("p", { class: "loading", text: "불러오는 중…" }));

  let all = docFacts(await everyDoc(), Date.now(), { mdTypes: mdTypeIds() });
  if (!card.isConnected) return;
  const admin = canEdit();
  let picked = new Set(); // 고른 줄의 key: 거르기가 숨긴 줄은 빠진다
  let shownRows = []; // 표가 지금 보이는 줄(거르고 정렬한 것)
  let last = null; // 방금 한 일 { action, keys, tag, text, error } — keys 가 되돌리기의 대상
  let state = parseState(location.hash.split("?")[1] ?? "");
  input.value = state.q;

  const values = (f) => {
    if (f.id === "type") {
      const have = new Set(all.map((r) => r.doc.type));
      return [...DOC_TYPES.filter((t) => have.has(t) || state.type.includes(t)), ...[...have].filter((t) => !DOC_TYPES.includes(t)).sort()];
    }
    if (f.id === "status") return ["active", "inactive"];
    return f.values.map(([v]) => v);
  };

  function set(next, { keepInput = false } = {}) {
    state = next;
    history.replaceState(null, "", `${location.pathname}${location.search}${tableHash(state)}`);
    if (!keepInput) input.value = state.q;
    paint();
  }

  function paintFacets() {
    const counts = facetCounts(all, state);
    facetsHost.replaceChildren(...FACETS.map((f) =>
      el("fieldset", { class: "fct-g" }, [
        el("legend", {}, [f.label, state[f.id].length ? el("span", { class: "count-pill", text: String(state[f.id].length) }) : null]),
        ...values(f).map((v) => {
          const n = counts[f.id].get(v) ?? 0;
          const on = state[f.id].includes(v);
          return el("label", { class: `fct-v${n || on ? "" : " zero"}` }, [
            el("input", { type: "checkbox", checked: on, "data-fk": `f:${f.id}:${v}`, onchange: () => set(toggleFacet(state, f.id, v)) }),
            f.id === "type" ? el("span", { class: "tdot", style: { "--c": typeColor(v) } }) : null,
            el("span", { class: "fct-l", text: valueLabel(f, v) }),
            el("span", { class: "fct-n", text: num(n) }),
          ]);
        }),
      ]),
    ));
  }

  function paint() {
    // 다시 그린 뒤에도 초점은 누른 그 단추 · 체크 칸에 남는다.
    const fk = document.activeElement?.dataset?.fk;
    draw();
    if (fk) [...card.parentNode.parentNode.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === fk)?.focus();
  }

  function draw() {
    paintFacets();
    const rows = sortRows(filterRows(all, state), state.sort, state.dir, DOC_TYPES);
    countEl.textContent = rows.length === all.length ? `문서 ${num(all.length)}` : `문서 ${num(rows.length)} / ${num(all.length)}`;
    const facetPicks = FACETS.flatMap((f) => state[f.id].map((v) => ({ f, v })));
    chipsEl.hidden = !activeCount(state);
    chipsEl.replaceChildren(...[
      ...facetPicks.map(({ f, v }) =>
        el("button", { type: "button", class: "chip dt-chip", "aria-label": `${f.label} ${valueLabel(f, v)} 거르기 끄기`, onclick: () => set(toggleFacet(state, f.id, v)) }, [
          el("span", { class: "dim", text: f.label }), valueLabel(f, v), icon("x", 11),
        ])),
      state.q ? el("button", { type: "button", class: "chip dt-chip", "aria-label": "찾는 글 지우기", onclick: () => set({ ...state, q: "" }) }, [el("span", { class: "dim", text: "찾기" }), state.q, icon("x", 11)]) : null,
      el("button", { type: "button", class: "btn ghost sm", text: "모두 지우기", onclick: () => set({ ...emptyState(), sort: state.sort, dir: state.dir }) }),
    ].filter(Boolean));
    shownRows = rows;
    picked = keepVisible(rows, picked);
    tableHost.replaceChildren(docTable({
      rows,
      state,
      onSort: (id) => set(toggleSort(state, id)),
      empty: el("p", { class: "loading" }, [all.length ? "이 조건에 맞는 문서가 없습니다. 왼쪽에서 고른 값을 줄여 보세요." : "문서가 없습니다."]),
      pick: admin ? pick : null,
    }));
    paintBand();
    paintUndo();
  }

  // ---------- 고르기 · 일괄 동작 · 되돌리기 (admin) ----------
  const pick = {
    has: (key) => picked.has(key),
    toggle(key, box) {
      if (picked.has(key)) picked.delete(key);
      else picked.add(key);
      box.closest("tr").classList.toggle("picked", picked.has(key));
      syncHead();
      paintBand();
    },
    head: {
      get state() {
        return headOf(shownRows, picked);
      },
      toggle() {
        picked = headOf(shownRows, picked) === "all" ? new Set() : new Set(shownRows.map((r) => rowKey(r.doc)));
        for (const b of tableHost.querySelectorAll("[data-pick]")) {
          b.checked = picked.has(b.dataset.pick);
          b.closest("tr").classList.toggle("picked", b.checked);
        }
        syncHead();
        paintBand();
      },
    },
  };
  function syncHead() {
    const box = tableHost.querySelector("[data-pick-all]");
    if (!box) return;
    const st = headOf(shownRows, picked);
    box.checked = st === "all";
    box.indeterminate = st === "some";
  }
  const pickedDocs = () => shownRows.filter((r) => picked.has(rowKey(r.doc))).map((r) => r.doc);
  function paintBand() {
    bandEl.hidden = !admin || !picked.size;
    if (bandEl.hidden) return bandEl.replaceChildren();
    const docs = pickedDocs();
    const n = (action) => plan(docs, action).change.length;
    const act = (action, cls) => {
      const count = n(action);
      return el("button", { type: "button", class: `btn sm ${cls}`.trim(), "data-bulk": action, disabled: !count, title: count ? null : `고른 문서 가운데 ${VERB[action]}할 문서가 없습니다`, onclick: () => confirmRun(action) }, `${VERB[action]} ${num(count)}`);
    };
    bandEl.replaceChildren(
      el("span", {}, [el("b", { text: num(picked.size) }), " 골라짐"]),
      el("span", { class: "sp" }),
      act("activate", "primary"),
      act("deactivate", ""),
      el("button", { type: "button", class: "btn sm", "data-bulk": "tag", onclick: () => confirmRun("tag") }, [icon("plus", 13), "태그 붙이기"]),
      el("button", { type: "button", class: "btn sm ghost", text: "풀기", onclick: () => {
        picked = new Set();
        draw();
      } }),
    );
  }
  function paintUndo() {
    undoEl.hidden = !last;
    if (!last) return undoEl.replaceChildren();
    undoEl.classList.toggle("error", last.error);
    undoEl.replaceChildren(
      icon(last.error ? "x" : "check", 14),
      el("span", { class: "dt-undo-t", text: last.text }),
      ...(last.keys.length ? [el("button", { type: "button", class: "btn sm", "data-undo": "", onclick: undo }, [icon("back", 13), `되돌리기 · ${num(last.keys.length)}`])] : []),
      el("button", { type: "button", class: "btn sm ghost", "aria-label": "알림 닫기", onclick: () => {
        last = null;
        paintUndo();
      } }, icon("x", 13)),
    );
  }
  /** One request after another (the server's write queue is serial anyway); `stop()` ends it between two. */
  async function send(action, docs, { tag = null, onStep = () => {}, stop = () => false } = {}) {
    const responses = [];
    let sent = 0;
    for (const req of requests(action, docs, { tag })) {
      if (stop()) break;
      const r = await api(req.path, { method: req.method, body: req.body, headers: req.ifMatch ? { "if-match": req.ifMatch } : {} });
      responses.push({ req, status: r.status, data: r.data });
      sent += req.keys.length;
      onStep(sent);
    }
    return { res: outcome(responses), left: docs.length - sent };
  }
  async function reload() {
    invalidateDocs();
    all = docFacts(await everyDoc(), Date.now(), { mdTypes: mdTypeIds() });
  }
  /** 되돌리기: the opposite action on the docs the last run changed, with their revs as they are now. */
  async function undo(e) {
    e.currentTarget.disabled = true;
    const { action, keys, tag } = last;
    const back = UNDO[action];
    const byKey = new Map(all.map((r) => [rowKey(r.doc), r.doc]));
    const p = plan(keys.map((k) => byKey.get(k)).filter(Boolean), back, { tag });
    const { res } = await send(back, p.change, { tag });
    await reload();
    const t = runToast(back, res, { tag, undo: true });
    last = { action: back, keys: [], tag, text: t.text, error: t.error };
    paint();
    undoEl.querySelector("button")?.focus();
  }
  // 띠의 단추 → 이 창: 몇 개 · 어느 타입 · 이름 · 건너뛰는 문서와 까닭, 그다음 보낸다.
  function confirmRun(action) {
    const docs = pickedDocs();
    const known = [...new Set(all.flatMap((r) => r.doc.tags ?? []))].sort();
    const tagInput = action === "tag" ? el("input", { type: "text", class: "dt-tag-in", list: "dt-tag-list", placeholder: "예: rf-power", "aria-label": "붙일 태그", "aria-describedby": "dt-tag-note", autocomplete: "off", spellcheck: "false" }) : null;
    const tagNote = el("p", { class: "dlg-p dim", id: "dt-tag-note", text: "영문 소문자 · 숫자 · - 로 1 ~ 32 자. 주입 · 색인에는 닿지 않고 화면에서 문서를 묶습니다." });
    const title = el("h3", { id: "dt-bulk-h" });
    const body = el("div", {});
    const progress = el("span", { class: "dim", "aria-live": "polite" });
    const cancel = el("button", { type: "button", class: "btn ghost", text: "취소" });
    const go = el("button", { type: "button", class: "btn primary", "data-bulk-go": "" });
    const how = {
      activate: "활성 — 다음 동기화부터 주입됩니다. 타입마다 커밋 하나로 보냅니다.",
      deactivate: "비활성 — 다음 동기화부터 주입 · 색인에서 빠집니다. 문서는 남고 API 로 읽힙니다. 문서마다 커밋 하나로, 하나씩 보냅니다.",
      tag: "문서마다 커밋 하나로, 하나씩 보냅니다.",
    }[action];
    let tag = null;
    let p = plan(docs, action);
    let running = false;
    let stopped = false;
    let finished = false;
    function paintPlan() {
      if (tagInput) tag = cleanTag(tagInput.value);
      p = plan(docs, action, { tag });
      const n = p.change.length;
      title.textContent = action === "tag" ? `문서 ${num(n)} 개에 태그를 붙입니다` : `문서 ${num(n)} 개를 ${VERB[action]}합니다`;
      const kinds = typeCounts(p.change);
      const { names, more } = dialogNames(p.change);
      const why = new Map();
      for (const s of p.skip) why.set(s.why, (why.get(s.why) ?? 0) + 1);
      body.replaceChildren(
        kinds.length > 1 ? el("p", { class: "dlg-p dim", text: kinds.map(({ type, n: k }) => `${TYPE_LABEL[type] ?? type} ${num(k)}`).join(" · ") }) : document.createTextNode(""),
        n ? el("ul", { class: "bulk-dlg-docs", "aria-label": "바뀌는 문서" }, [...names.map((x) => el("li", { text: x })), more ? el("li", { class: "more", text: `… 외 ${num(more)}` }) : null]) : el("p", { class: "dlg-p", text: "바뀌는 문서가 없습니다." }),
        p.skip.length ? el("p", { class: "dlg-p dim", text: `건너뜀 ${num(p.skip.length)} — ${[...why].map(([w, k]) => `${w} ${num(k)}`).join(" · ")}` }) : document.createTextNode(""),
      );
      if (tagInput) {
        const bad = tagInput.value.trim() && !tag;
        tagNote.classList.toggle("dt-bad", !!bad);
        tagNote.textContent = bad ? "태그는 영문 소문자 · 숫자 · - 로 1 ~ 32 자입니다." : "영문 소문자 · 숫자 · - 로 1 ~ 32 자. 주입 · 색인에는 닿지 않고 화면에서 문서를 묶습니다.";
        tagInput.setAttribute("aria-invalid", String(!!bad));
      }
      go.textContent = action === "tag" ? (tag ? `#${tag} 붙이기 · ${num(n)}` : "태그를 적으세요") : `${num(n)} 개 ${VERB[action]}`;
      go.disabled = running || !n || (action === "tag" && !tag);
    }
    const dlg = el("dialog", { class: "dlg bulk-dlg", "aria-labelledby": "dt-bulk-h" }, [
      el("div", { class: "dlg-h" }, title),
      el("p", { class: "dlg-p", text: how }),
      tagInput ? el("label", { class: "dt-tag-row" }, [el("span", { class: "dt-tag-k", text: "#" }), tagInput]) : null,
      tagInput ? tagNote : null,
      tagInput ? el("datalist", { id: "dt-tag-list" }, known.map((t) => el("option", { value: t }))) : null,
      body,
      el("div", { class: "dlg-foot" }, [el("span", { class: "dim", text: "admin 결정 · 문서마다 rev 를 맞춰 봅니다" }), progress, el("span", { class: "sp" }), cancel, go]),
    ]);
    tagInput?.addEventListener("input", paintPlan);
    tagInput?.addEventListener("keydown", (e) => e.key === "Enter" && !go.disabled && (e.preventDefault(), go.click()));
    cancel.addEventListener("click", () => {
      if (!running) return dlg.close();
      stopped = true;
      cancel.disabled = true;
      cancel.textContent = "멈추는 중…";
    });
    // Esc and a press on the backdrop close the dialog — not while it sends.
    dlg.addEventListener("cancel", (e) => running && e.preventDefault());
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg || running) return;
      const b = dlg.getBoundingClientRect();
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) dlg.close();
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (!finished) bandEl.querySelector(`[data-bulk="${action}"]`)?.focus();
    });
    go.addEventListener("click", async () => {
      running = true;
      go.disabled = true;
      if (tagInput) tagInput.disabled = true;
      cancel.textContent = "멈추기";
      const total = p.change.length;
      const { res, left } = await send(action, p.change, { tag, onStep: (i) => (progress.textContent = ` · ${num(i)} / ${num(total)}`), stop: () => stopped });
      running = false;
      await reload();
      const t = runToast(action, res, { tag });
      const text = left ? `${t.text} · 멈춤 — ${num(left)} 개는 보내지 않았습니다` : t.text;
      last = { action, keys: res.done, tag, text, error: t.error || left > 0 };
      finished = true;
      dlg.close();
      paint();
      (undoEl.querySelector("[data-undo]") ?? undoEl.querySelector("button"))?.focus();
    });
    paintPlan();
    document.body.appendChild(dlg);
    dlg.showModal();
    (tagInput ?? go).focus();
  }

  input.addEventListener("input", () => set({ ...state, q: input.value.trim() }, { keepInput: true }));
  paint();
}
