// 새 문서: [새 문서] → 타입 플라이아웃(타입 목록 순서) → 로컬 드래프트(서버에
// 아직 없음) → 이름과 팩트를 채우고 저장 = 비활성 문서 하나. 맨 아래
// [타입 없이 올리기] 는 md 한 장을 미분류로 올린다(쓰기 사용자 모두).
import { allDocs, api, invalidateDocs } from "./api.mjs";
import { el, icon, toast } from "./dom.mjs";
import { dataIdConflictText } from "./shared.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "./shell.mjs";
import { TYPES, TYPE_LABEL, canUpload as userCanUpload, isAdmin, isMdType, loadTypes, typeColor } from "./state.mjs";
import { agentPanel } from "./tabs/agents.mjs";
import { pathPanel } from "./tabs/docs.mjs";

export function canCreate() {
  return isAdmin();
}
export function canUpload() {
  return userCanUpload();
}
export const nowIso = () => new Date().toISOString();

// ---- 로컬 드래프트 저장소 (localStorage) — 여러 개 동시 보관 ----
// akg_drafts = { <localId>: { type, body } }. localId 는 단조 증가(d1, d2 …).
export const DRAFTS_KEY = "akg_drafts";
export function loadDrafts() {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) || "{}");
  } catch {
    return {};
  }
}
export function saveDrafts(all) {
  localStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
}
export function nextDraftId() {
  const n = Number(localStorage.getItem("akg_draft_seq") || "0") + 1;
  localStorage.setItem("akg_draft_seq", String(n));
  return `d${n}`;
}
export function createDraft(type) {
  const all = loadDrafts();
  const localId = nextDraftId();
  all[localId] = { type, body: {} };
  saveDrafts(all);
  return localId;
}
export function getDraftBody(localId) {
  return loadDrafts()[localId]?.body ?? null;
}
export function saveDraftBody(localId, body) {
  const all = loadDrafts();
  if (!all[localId]) return;
  all[localId].body = body;
  saveDrafts(all);
}
export function deleteDraft(localId) {
  const all = loadDrafts();
  delete all[localId];
  saveDrafts(all);
}
// 한 타입의 드래프트 목록(생성 순서 = localId 숫자 순서)
export function draftsOfType(type) {
  return Object.entries(loadDrafts())
    .filter(([, v]) => v.type === type)
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([localId, v]) => ({ localId, body: v.body }));
}

// id 는 서버 deriveId 와 동일 규칙으로 미리보기 (db-schema=lower(table),
// msg-format=kebab(command), domain-skill=name). owner 는 id 에 안 들어간다.
export function deriveDraftId(type, body) {
  if (type === "db-schema")
    return body.table ? String(body.table).toLowerCase() : "";
  if (type === "msg-format")
    return body.command
      ? String(body.command).toLowerCase().replace(/_/g, "-")
      : "";
  if (type === "domain-skill")
    return body.name ? String(body.name).toLowerCase() : "";
  if (type === "manual") return body.id ? String(body.id).toLowerCase() : "";
  if (isMdType(type)) return body.name ? String(body.name).toLowerCase() : "";
  return "";
}


// ---- 새 문서 단추 + 플라이아웃 ----
// Structured types with a draft form, in the type list's order; every open md
// type; last, 타입 없이 올리기 for anyone who writes.
const FORM_TYPES = { "db-schema": "테이블 · 컬럼", "msg-format": "설비 커맨드", "domain-skill": "스킬 문서(md)", manual: "화면 매뉴얼(캡처)" };
export function newDocOpts() {
  if (!canCreate()) return [];
  return TYPES.filter((t) => t.status === "active" && t.id !== "unclassified" && (FORM_TYPES[t.id] || t.kind === "md")).map((t) => ({
    type: t.id,
    label: t.id === "domain-skill" ? "스킬 문서" : t.label,
    desc: FORM_TYPES[t.id] ?? t.description ?? `${t.label}(md)`,
    color: t.color,
  }));
}

let openFly = null;
function closeFlyout() {
  if (!openFly) return;
  openFly.menu.remove();
  openFly.btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", openFly.outside, true);
  openFly = null;
}

/** [새 문서] and its flyout: types in order, then 타입 없이 올리기. */
export function newDocButton({ compact = false } = {}) {
  if (!canUpload()) return document.createTextNode("");
  const btn = el("button", { type: "button", class: `btn primary${compact ? " sm" : ""} newdoc-btn`, "aria-haspopup": "menu", "aria-expanded": "false" }, [icon("plus", 15), "새 문서"]);
  btn.addEventListener("click", () => {
    if (openFly?.btn === btn) return closeFlyout();
    closeFlyout();
    const opts = newDocOpts();
    const item = (attrs, children) => el("li", { role: "none" }, el("button", { type: "button", role: "menuitem", class: "nd-opt", ...attrs }, children));
    const menu = el("div", { class: "nd-flyout", role: "menu", "aria-label": "새 문서 종류" }, [
      el("div", { class: "nd-h", text: "새 문서" }),
      el("ul", {}, [
        ...opts.map((o) =>
          item({ onclick: () => { closeFlyout(); startDraft(o.type); } }, [
            el("span", { class: "tdot", style: { "--c": o.color }, "aria-hidden": "true" }),
            el("span", { class: "nd-l", text: o.label }),
            el("span", { class: "nd-d", text: o.desc }),
          ])),
        item({ class: "nd-opt nd-upload", onclick: () => { closeFlyout(); openUploadDialog(); } }, [
          icon("upload", 15),
          el("span", { class: "nd-l", text: "타입 없이 올리기" }),
          el("span", { class: "nd-d", text: "md 한 장 → 미분류" }),
        ]),
      ]),
    ]);
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") items[(i + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus();
      else if (e.key === "Escape") {
        closeFlyout();
        btn.focus();
      } else return;
      e.preventDefault();
    });
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const w = 300;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
    menu.style.left = `${Math.round(left)}px`;
    if (r.top > window.innerHeight / 2) menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    else menu.style.top = `${Math.round(r.bottom + 6)}px`;
    btn.setAttribute("aria-expanded", "true");
    const outside = (e) => {
      if (!menu.contains(e.target) && !btn.contains(e.target)) closeFlyout();
    };
    openFly = { btn, menu, outside };
    setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
    menu.querySelector("button")?.focus();
  });
  return btn;
}

// Each pick makes one more empty draft.
export function startDraft(type, preset = {}) {
  const localId = createDraft(type);
  if (Object.keys(preset).length) saveDraftBody(localId, { ...preset });
  location.hash = `#/draft/${type}/${localId}`;
}

export function idSourceField(type, body, onIdChange) {
  if (type === "db-schema")
    return eField(() => body.table, (v) => (body.table = v), {
      mono: true,
      upper: true,
      title: true,
      placeholder: "테이블명 클릭해서 입력 (예: FDC_SENSOR)",
      onChange: onIdChange,
    });
  if (type === "msg-format")
    return eField(() => body.command, (v) => (body.command = v), {
      mono: true,
      upper: true,
      title: true,
      placeholder: "커맨드명 클릭해서 입력 (예: CMD_START_LOT)",
      onChange: onIdChange,
    });
  // A manual's id is written, not derived: the body has only a prose title.
  if (type === "manual")
    return eField(() => body.id, (v) => (body.id = v ? v.toLowerCase() : v), {
      mono: true,
      title: true,
      placeholder: "매뉴얼 id 클릭해서 입력 (예: spc-chart-limit-setup)",
      onChange: onIdChange,
    });
  return eField(() => body.name, (v) => (body.name = v ? v.toLowerCase() : v), {
    mono: true,
    title: true,
    placeholder: isMdType(type)
      ? `${TYPE_LABEL[type] ?? type} 이름 클릭해서 입력 (예: line-a-rf-power-drift)`
      : "스킬명 클릭해서 입력 (예: fdc-explain-sensor)",
    onChange: onIdChange,
  });
}


// ---- 드래프트 화면 ----
export async function renderDraftScreen(type, localId) {
  const body = getDraftBody(localId);
  if (!TYPES.some((t) => t.id === type) || body == null) {
    location.replace("#/docs");
    return;
  }
  const isAgent = type === "domain-skill" && (body.role ?? "main") === "main";
  setActiveTab(isAgent ? "agents" : "docs");
  setCrumbs(
    isAgent
      ? [{ label: "에이전트", href: "#/agents" }, { label: "새 문서" }]
      : [{ label: "문서", href: "#/docs" }, { label: TYPE_LABEL[type] ?? type, href: `#/docs/${type}` }, { label: "새 문서" }],
  );
  const docs = await allDocs();
  const main = el("main", { class: "main draft-main" });
  const left = isAgent ? { node: agentPanel(null, localId) } : pathPanel(type, null, docs, localId);
  const layout = cols({ left: left.node, main, className: left.collapsed ? "collapsed" : "" });
  left.bind?.(layout);
  screen().appendChild(layout);
  paintDraft(main, type, localId, body);
}

function paintDraft(section, type, localId, body) {
  const persist = () => saveDraftBody(localId, body);
  const rerender = () => {
    persist();
    paintDraft(section, type, localId, body);
  };
  const saveBtn = el("button", { type: "button", class: "btn primary", text: "저장 (비활성)", onclick: () => saveDraft(type, localId, body) });
  function updateSave() {
    const id = deriveDraftId(type, body);
    saveBtn.disabled = !id;
    saveBtn.title = id ? "이 드래프트를 비활성 문서로 저장합니다." : "제목(테이블 · 커맨드 · 스킬 이름)을 먼저 넣어야 저장합니다.";
  }
  const onIdChange = () => {
    persist();
    updateSave();
  };
  const head = el("div", { class: "dfhead" }, [
    el("p", { class: "doc-eyebrow" }, [
      el("span", { class: "tdot", style: { "--c": typeColor(type) } }),
      ` ${type} · ${TYPE_LABEL[type] ?? type}`,
      el("span", { class: "df-badge", text: "드래프트 · 저장 안 됨" }),
    ]),
    el("div", { class: "dftitle-wrap" }, idSourceField(type, body, onIdChange)),
    el("div", { class: "dfacts" }, [
      el("button", {
        type: "button",
        class: "btn ghost",
        text: "버리기",
        onclick: () => {
          deleteDraft(localId);
          toast("드래프트를 버렸습니다.");
          location.hash = type === "domain-skill" ? "#/agents" : `#/docs/${type}`;
        },
      }),
      saveBtn,
    ]),
  ]);
  const note = el("p", { class: "df-note" }, [
    el("b", { text: "이 브라우저에만 있는 드래프트입니다." }),
    " 이름과 팩트를 채우고 저장하면 비활성 문서로 올라갑니다. 설명은 저장 뒤 문서 화면에서 채우고, 다 되면 활성으로 바꾸세요.",
  ]);
  const fields =
    type === "db-schema"
      ? draftDbSchema(body, onIdChange, persist, rerender)
      : type === "msg-format"
        ? draftMsgFormat(body, onIdChange, persist, rerender)
        : type === "manual"
          ? draftManual(body, persist)
          : isMdType(type)
            ? draftVoc(body, persist)
            : draftDomainSkill(body, onIdChange, persist, rerender);
  section.replaceChildren(head, note, fields);
  updateSave();
}

export function eField(get, set, opts = {}) {
  const wrap = el("span", { class: "df-v" });
  function showRead() {
    const val = get();
    const has = val != null && String(val) !== "";
    const btn = el("button", {
      type: "button",
      class: `df-click${opts.mono ? " mono" : ""}${opts.title ? " df-title" : ""}${has ? "" : " empty"}`,
      text: has ? String(val) : opts.placeholder || "클릭해서 입력",
      onclick: showEdit,
    });
    wrap.replaceChildren(btn);
  }
  function showEdit() {
    const val = get();
    const has = val != null && String(val) !== "";
    const inp = el(opts.area ? "textarea" : "input", {
      class: `df-inp${opts.mono ? " mono" : ""}${opts.title ? " df-title" : ""}`,
      ...(opts.area ? { rows: 2 } : { type: "text" }),
      placeholder: opts.placeholder || "",
    });
    inp.value = has ? String(val) : "";
    const commit = () => {
      let v = inp.value.trim();
      if (opts.upper) v = v.toUpperCase();
      set(v);
      opts.onChange?.();
      showRead();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !opts.area) {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        showRead();
      }
    });
    inp.addEventListener("blur", commit);
    wrap.replaceChildren(inp);
    inp.focus();
  }
  showRead();
  return wrap;
}
export function eSelect(get, set, options, onChange) {
  const sel = el("select", { class: "df-inp" });
  for (const o of options) sel.appendChild(el("option", { value: o.value }, o.label));
  sel.value = get() || options[0].value;
  sel.addEventListener("change", () => {
    set(sel.value);
    onChange?.();
  });
  return sel;
}
export function eCheck(get, set) {
  const inp = el("input", { type: "checkbox" });
  inp.checked = !!get();
  inp.addEventListener("change", () => set(inp.checked));
  return inp;
}
export function dfRow(label, required, control) {
  return el("div", { class: "df-row" }, [
    el("span", { class: "df-k" }, [
      label,
      required ? el("span", { class: "req", text: "*" }) : null,
    ]),
    control,
  ]);
}

// ---- db-schema 드래프트 폼 ----
export function draftDbSchema(body, onIdChange, persist, rerender) {
  body.columns = body.columns || [];
  const wrap = el("div", { class: "dfwrap" });
  wrap.append(
    dfRow(
      "owner",
      false,
      eField(() => body.owner, (v) => (body.owner = v || undefined), {
        mono: true,
        upper: true,
        placeholder: "선택 (예: TESTUSER)",
        onChange: persist,
      }),
    ),
  );
  wrap.append(el("div", { class: "df-sec", text: "컬럼" }));
  const table = el("table", { class: "df-tbl" }, [
    el(
      "thead",
      {},
      el("tr", {}, [
        el("th", { text: "컬럼명" }),
        el("th", { text: "타입" }),
        el("th", { class: "df-cell-check", text: "NULL" }),
        el("th", { class: "df-cell-check", text: "PK" }),
        el("th", { text: "" }),
      ]),
    ),
    el(
      "tbody",
      {},
      body.columns.map((c, i) =>
        el("tr", {}, [
          el("td", {}, eField(() => c.name, (v) => (c.name = v), { mono: true, upper: true, placeholder: "이름", onChange: persist })),
          el("td", {}, eField(() => c.type, (v) => (c.type = v), { mono: true, upper: true, placeholder: "타입", onChange: persist })),
          el("td", { class: "df-cell-check" }, eCheck(() => c.nullable, (v) => { c.nullable = v; persist(); })),
          el("td", { class: "df-cell-check" }, eCheck(() => c.pk, (v) => { c.pk = v; persist(); })),
          el("td", {}, el("button", { type: "button", class: "df-rm", text: "✕", title: "행 삭제", onclick: () => { body.columns.splice(i, 1); rerender(); } })),
        ]),
      ),
    ),
  ]);
  wrap.append(table);
  wrap.append(
    el("button", {
      type: "button",
      class: "btn ghost sm df-add",
      text: "+ 컬럼",
      onclick: () => {
        body.columns.push({ name: "", type: "", nullable: false, pk: false });
        rerender();
      },
    }),
  );
  wrap.append(
    el("p", { class: "fhint", text: "타입·NULL·PK 는 팩트입니다. 컬럼 설명·용도(purpose)는 저장 후 문서 화면에서 채웁니다." }),
  );
  return wrap;
}

// ---- msg-format 드래프트 폼 ----
export function draftMsgFormat(body, onIdChange, persist, rerender) {
  body.fields = body.fields || [];
  const wrap = el("div", { class: "dfwrap" });
  wrap.append(
    dfRow(
      "direction",
      true,
      eSelect(
        () => body.direction,
        (v) => (body.direction = v),
        [
          { value: "host->equipment", label: "host → equipment" },
          { value: "equipment->host", label: "equipment → host" },
        ],
        persist,
      ),
    ),
  );
  wrap.append(el("div", { class: "df-sec", text: "필드" }));
  const table = el("table", { class: "df-tbl" }, [
    el(
      "thead",
      {},
      el("tr", {}, [
        el("th", { text: "#" }),
        el("th", { text: "필드명" }),
        el("th", { text: "타입" }),
        el("th", { class: "df-cell-check", text: "필수" }),
        el("th", { text: "" }),
      ]),
    ),
    el(
      "tbody",
      {},
      body.fields.map((f, i) =>
        el("tr", {}, [
          el("td", { class: "df-cell-check", text: String(i + 1) }),
          el("td", {}, eField(() => f.name, (v) => (f.name = v), { mono: true, placeholder: "이름", onChange: persist })),
          el("td", {}, eField(() => f.type, (v) => (f.type = v), { mono: true, placeholder: "타입", onChange: persist })),
          el("td", { class: "df-cell-check" }, eCheck(() => f.required, (v) => { f.required = v; persist(); })),
          el("td", {}, el("button", { type: "button", class: "df-rm", text: "✕", onclick: () => { body.fields.splice(i, 1); rerender(); } })),
        ]),
      ),
    ),
  ]);
  wrap.append(table);
  wrap.append(
    el("button", {
      type: "button",
      class: "btn ghost sm df-add",
      text: "+ 필드",
      onclick: () => {
        body.fields.push({ name: "", type: "", required: false });
        rerender();
      },
    }),
  );
  wrap.append(
    el("p", { class: "fhint", text: "필드 설명·용도(purpose)는 저장 후 문서 화면에서 채웁니다." }),
  );
  return wrap;
}

// ---- domain-skill 드래프트 폼 — 스킬은 md 한 장이라 붙여 넣는 칸 하나 ----
export function draftDomainSkill(body, onIdChange, persist, rerender) {
  const wrap = el("div", { class: "dfwrap" });
  wrap.append(
    dfRow(
      "role",
      true,
      eSelect(
        () => body.role || "main",
        (v) => (body.role = v),
        [
          { value: "main", label: "main — 에이전트가 될 스킬" },
          { value: "sub", label: "sub — main 이 가리키는 지식 (## 도메인 지식 필수)" },
        ],
        persist,
      ),
    ),
  );
  wrap.append(
    dfRow(
      "markdown",
      false,
      eField(() => body.markdown, (v) => (body.markdown = v), {
        area: true,
        mono: true,
        placeholder: "스킬 md 를 여기에 — # 이름 / ## 한 줄 설명 / ## 언제 호출되는가? / ## 도메인 지식 / ## 데이터 / ## 답변 품질 검증 Set",
        onChange: persist,
      }),
    ),
  );
  wrap.append(
    el("p", { class: "fhint", text: "본문은 저장 후 문서 화면에서도 고칠 수 있습니다. 절 제목은 다섯만 허용되고(## 한 줄 설명 · ## 언제 호출되는가? · ## 도메인 지식 · ## 데이터 · main 만 ## 답변 품질 검증 Set), 모르는 ## 절은 저장이 거절됩니다. 활성화하려면 본문이 있어야 합니다." }),
  );
  return wrap;
}

export function draftManual(body, persist) {
  const wrap = el("div", { class: "dfwrap" });
  wrap.append(
    dfRow(
      "제목",
      true,
      eField(() => body.title, (v) => (body.title = v), {
        placeholder: "매뉴얼 제목 (예: SPC 관리 한계 설정)",
        onChange: persist,
      }),
    ),
    el("p", { class: "fhint", text: "단계와 캡처, 화면 연결(관계 screen)은 저장 후 문서 화면에서 넣습니다. 활성화하려면 화면 연결 하나와 단계마다 캡처가 있어야 합니다." }),
  );
  return wrap;
}
export function draftVoc(body, persist) {
  const wrap = el("div", { class: "dfwrap" });
  wrap.append(
    dfRow(
      "markdown",
      false,
      eField(() => body.markdown, (v) => (body.markdown = v), {
        area: true,
        mono: true,
        placeholder: "md 를 여기에 — # 이름 으로 시작해 자유롭게. [[문서 id]] 는 연결이 됩니다.",
        onChange: persist,
      }),
    ),
    el("p", { class: "fhint", text: "본문은 저장 후 문서 화면에서도 고칠 수 있습니다. 활성화하려면 본문이 있어야 합니다." }),
  );
  return wrap;
}
export function finalizeDraftBody(type, body) {
  if (type === "db-schema") {
    const columns = (body.columns || [])
      .filter((c) => c.name)
      .map((c) => ({ name: c.name, type: c.type || "", nullable: !!c.nullable }));
    const columnDescs = {};
    for (const c of columns) columnDescs[c.name] = { text: null, tier: "scaffold" };
    return {
      ...(body.owner ? { owner: body.owner } : {}),
      table: body.table,
      catalog: {
        columns,
        primaryKey: (body.columns || []).filter((c) => c.name && c.pk).map((c) => c.name),
        fetchedAt: nowIso(),
      },
      purpose: { text: null, tier: "scaffold" },
      columnDescs,
    };
  }
  if (type === "msg-format") {
    const fields = (body.fields || [])
      .filter((f) => f.name)
      .map((f, i) => ({
        seq: i + 1,
        name: f.name,
        type: f.type || "",
        required: !!f.required,
        desc: { text: null, tier: "scaffold" },
      }));
    return {
      command: body.command,
      direction: body.direction || "host->equipment",
      purpose: { text: null, tier: "scaffold" },
      fields,
    };
  }
  if (type === "manual") return body.title ? { title: body.title } : {};
  if (isMdType(type)) {
    const b = { name: body.name };
    if (body.markdown && body.markdown.trim() !== "") b.markdown = body.markdown;
    return b;
  }
  // domain-skill: { name, markdown } — 본문이 비었으면 칸 자체를 안 보낸다
  // (드래프트는 required 가 풀린 스키마로 검증되니 name 만으로 저장된다).
  const b = { name: body.name };
  if (body.markdown && body.markdown.trim() !== "") b.markdown = body.markdown;
  return b;
}


export async function saveDraft(type, localId, body) {
  const id = deriveDraftId(type, body);
  if (!id) {
    toast("제목(테이블 · 커맨드 · 스킬 이름)을 먼저 넣으세요.", "error");
    return;
  }
  const doc = {
    schema: `${type}/v1`,
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "inactive",
    ...(type === "domain-skill" ? { role: body.role || "main" } : {}),
    body: finalizeDraftBody(type, body),
  };
  const r = await api(`/api/docs/${type}`, { method: "POST", body: doc });
  if (r.status === 201) {
    deleteDraft(localId);
    toast("저장했습니다 — 비활성 문서입니다. 이어서 채우고 다 되면 활성으로 바꾸세요.");
    invalidateDocs();
    await loadTypes();
    location.hash = `#/doc/${type}/${encodeURIComponent(id)}`;
    return;
  }
  if ((r.data || {}).error === "data_id_conflict") return toast(dataIdConflictText(r.data), "error");
  if (r.status === 409) return toast(`같은 이름(${id})의 문서가 이미 있습니다.`, "error");
  if (r.status === 400) {
    const d = r.data || {};
    const msg = d.error === "validation_failed" ? (d.details || []).join(" · ") : d.error === "edit_rejected" ? d.message : d.error || "";
    return toast(`저장 실패: ${msg}`, "error");
  }
  toast(`저장 실패 (${r.status || "네트워크"})`, "error");
}

// 타입 없이 올리기: md 한 장을 미분류 문서로. 쓰는 사람 누구나 올리고, 타입은
// admin 이 나중에 정한다(문서 머리 [타입 정하기 ▾]).
const slugOf = (name) =>
  name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");

export function openUploadDialog() {
  const fileBox = el("div", { class: "up-drop", tabindex: "0", role: "button", "aria-label": "md 파일 고르기 — 끌어 놓거나 눌러서 고릅니다" }, [
    icon("file", 18),
    el("span", { class: "up-drop-t", text: "md 파일 하나를 여기에 끌어 놓거나 눌러서 고릅니다" }),
  ]);
  const picker = el("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain", hidden: true });
  const name = el("input", { type: "text", class: "fld", placeholder: "이름 (예: 설비 점검 메모)", "aria-label": "이름" });
  const id = el("input", { type: "text", class: "fld mono", placeholder: "id (예: eqp-check-memo)", "aria-label": "id" });
  const text = el("textarea", { class: "fld mono up-md", rows: 10, spellcheck: "false", placeholder: "md 를 붙여 넣습니다 — # 제목 으로 시작해 자유롭게", "aria-label": "md 본문" });
  const url = el("input", { type: "url", class: "fld mono", placeholder: "https://… (선택)", "aria-label": "원본 URL" });
  const send = el("button", { type: "submit", class: "btn primary", text: "저장" });
  const dlg = el("dialog", { class: "dlg up-dialog", "aria-labelledby": "up-title" });
  let idTouched = false;
  id.addEventListener("input", () => (idTouched = true));
  name.addEventListener("input", () => {
    if (!idTouched) id.value = slugOf(name.value);
  });
  async function takeFile(f) {
    if (!f) return;
    if (!/\.(md|markdown|txt)$/i.test(f.name)) {
      toast(".md 파일 하나만 받습니다", "error");
      return;
    }
    if (f.size > 400 * 1024) {
      toast("md 는 400KB 까지 받습니다", "error");
      return;
    }
    text.value = await f.text();
    const base = f.name.replace(/\.[^.]+$/, "");
    if (!name.value.trim()) name.value = base;
    if (!idTouched) id.value = slugOf(base) || id.value;
    fileBox.replaceChildren(
      icon("file", 18),
      el("b", { class: "mono", text: f.name }),
      el("span", { class: "dim", text: `${(f.size / 1024).toFixed(1)} KB · ${text.value.split("\n").length}줄 — 다른 파일을 놓으면 바뀝니다` }),
    );
  }
  fileBox.addEventListener("click", () => picker.click());
  fileBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      picker.click();
    }
  });
  picker.addEventListener("change", () => takeFile(picker.files[0]));
  for (const target of [fileBox, text]) {
    target.addEventListener("dragover", (e) => {
      e.preventDefault();
      fileBox.classList.add("over");
    });
    target.addEventListener("dragleave", () => fileBox.classList.remove("over"));
    target.addEventListener("drop", (e) => {
      const files = e.dataTransfer?.files;
      fileBox.classList.remove("over");
      if (!files?.length) return;
      e.preventDefault();
      if (files.length > 1) return toast(".md 파일 하나만 받습니다", "error");
      takeFile(files[0]);
    });
  }
  const row = (label, control, hint) =>
    el("label", { class: "up-row" }, [
      el("span", { class: "up-k", text: label }),
      el("span", { class: "up-v" }, [control, hint ? el("span", { class: "dim up-hint", text: hint }) : null]),
    ]);
  const form = el("form", { method: "dialog" }, [
    el("div", { class: "dlg-h" }, [
      el("h3", { id: "up-title", text: "타입 없이 올리기" }),
      el("span", { class: "tag", text: "쓰기 사용자 모두" }),
      el("span", { class: "sp" }),
      el("button", { type: "button", class: "icon-btn", "aria-label": "닫기", onclick: () => dlg.close() }, icon("x", 16)),
    ]),
    el("p", { class: "dim", text: "md 파일을 끌어다 놓거나 글을 붙입니다. 문서는 미분류에 들어가고, 타입은 admin 이 나중에 정합니다." }),
    fileBox,
    picker,
    row("이름", name, "파일 이름에서 가져옵니다"),
    row("id", id, "영문 소문자 · 숫자 · 하이픈. 타입을 정해도 그대로입니다"),
    row("md 본문", text),
    row("원본 URL", url, "선택 — 문서 머리에 원본 ↗ 로 보입니다"),
    el("div", { class: "dlg-foot" }, [
      el("span", { class: "dim", text: "저장하면 미분류에 커밋 하나를 남깁니다" }),
      el("span", { class: "sp" }),
      el("button", { type: "button", class: "btn ghost", text: "취소", onclick: () => dlg.close() }),
      send,
    ]),
  ]);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const docId = id.value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(docId)) return toast("id 는 영문 소문자로 시작하고 소문자 · 숫자 · - 만 씁니다", "error");
    if (!text.value.trim()) return toast("md 본문이 비었습니다", "error");
    const u = url.value.trim();
    if (u && !/^https?:\/\//i.test(u)) return toast("원본 URL 은 http(s):// 로 시작합니다", "error");
    let markdown = text.value;
    const label = name.value.trim();
    if (label && !/^#\s+/m.test(markdown)) markdown = `# ${label}\n\n${markdown}`;
    send.disabled = true;
    const r = await api("/api/docs/unclassified", {
      method: "POST",
      body: {
        schema: "unclassified/v1",
        id: docId,
        keywords: [{ kw: docId, inject: "full" }],
        status: "active",
        ...(u ? { origin: { url: u, ...(label ? { title: label } : {}) } } : {}),
        body: { name: docId, markdown },
      },
    });
    send.disabled = false;
    if (r.status === 201) {
      dlg.close();
      toast("미분류로 올렸습니다");
      invalidateDocs();
      await loadTypes();
      location.hash = `#/doc/unclassified/${encodeURIComponent(docId)}`;
      return;
    }
    const d = r.data || {};
    toast(
      r.status === 409
        ? `같은 id(${docId})의 문서가 이미 있습니다.`
        : `올리기 실패 (${r.status})${d.details ? ` — ${d.details.join(" · ")}` : d.message ? ` — ${d.message}` : ""}`,
      "error",
    );
  });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.appendChild(form);
  document.body.appendChild(dlg);
  dlg.showModal();
  fileBox.focus();
}
