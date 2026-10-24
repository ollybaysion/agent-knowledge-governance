import { api } from "./api.mjs";
import { $, el, toast } from "./dom.mjs";
import { dataIdConflictText } from "./shared.mjs";
import { DOC_TYPES, TYPE_LABEL, activeMdTypes, currentUser, isMdType } from "./state.mjs";
import { renderDocTree } from "./tabs/docs.mjs";

// ================= 새 문서 만들기 (#33) =================
// 흐름: 사이드바 하단 "+ 새 문서" → 오른쪽 포맷 플라이아웃 → 포맷 클릭 → 로컬
// 드래프트(서버 미저장) → 이름 포함 모든 필드를 클릭-투-편집으로 채움 → "저장"
// 이 inactive 문서로 커밋(이름 없으면 저장 불가). 미완이어도 저장되고(서버 완화
// 검증), 활성화는 완성돼야만 된다. CSP: 인라인 없이 el/addEventListener.
export function canCreate() {
  return !!currentUser && currentUser.group === "admin";
}
export function canUpload() {
  return !!currentUser && (currentUser.group === "admin" || currentUser.group === "user");
}
export const nowIso = () => new Date().toISOString();

// ---- 로컬 드래프트 저장소 (localStorage) — 여러 개 동시 보관 ----
// akg_drafts = { <localId>: { type, body } }. 저장 전이라 서버엔 없고, 트리에
// "(빈 문서)"·"(빈 문서2)"… 로 늘어난다. localId 는 단조 증가 카운터(d1, d2 …).
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

// ---- 사이드바 하단 버튼 + 오른쪽 포맷 플라이아웃 ----
export function renderTreeActions() {
  const host = $("tree-actions");
  if (!host) return;
  host.replaceChildren();
  if (!canUpload()) return;
  const btn = el(
    "button",
    { type: "button", id: "new-doc-btn", class: "btn primary" },
    "+ 새 문서",
  );
  btn.addEventListener("click", () => toggleFlyout(host, btn));
  host.appendChild(btn);
}
export function closeFlyout() {
  document.querySelector(".nd-flyout")?.remove();
  document.removeEventListener("click", onDocClickForFlyout, true);
}
export function onDocClickForFlyout(e) {
  const fly = document.querySelector(".nd-flyout");
  if (!fly) return;
  if (!fly.contains(e.target) && e.target.id !== "new-doc-btn") closeFlyout();
}
export const NEW_DOC_OPTS = [
  { type: "db-schema", desc: "테이블 · 컬럼" },
  { type: "msg-format", desc: "설비 커맨드" },
  { type: "domain-skill", desc: "스킬 문서(md)" },
  { type: "manual", desc: "화면 매뉴얼(캡처)" },
];
// admin: the structured types above and every open md type; anyone who
// writes: 타입 없이 올리기 (unclassified).
export function newDocOpts() {
  if (!canCreate()) return [];
  const md = activeMdTypes()
    .filter((t) => t.id !== "unclassified")
    .map((t) => ({ type: t.id, desc: t.description || `${t.label}(md)` }));
  return [...NEW_DOC_OPTS, ...md];
}
export function toggleFlyout(host, btn) {
  if (document.querySelector(".nd-flyout")) {
    closeFlyout();
    return;
  }
  const fly = el("div", { class: "nd-flyout", role: "menu" }, [
    el("div", { class: "nd-h", text: "새 문서 종류" }),
    ...newDocOpts().map((o) =>
      el(
        "button",
        {
          type: "button",
          class: "nd-opt",
          role: "menuitem",
          onclick: () => {
            closeFlyout();
            startDraft(o.type);
          },
        },
        [
          el("span", { class: "k", text: o.type }),
          el("span", { class: "d", text: o.desc }),
        ],
      ),
    ),
    el(
      "button",
      {
        type: "button",
        class: "nd-opt",
        role: "menuitem",
        onclick: () => {
          closeFlyout();
          openUploadDialog();
        },
      },
      [
        el("span", { class: "k", text: "타입 없이 올리기" }),
        el("span", { class: "d", text: "미분류 md 한 장" }),
      ],
    ),
  ]);
  // body 에 fixed 로 붙인다 — 사이드바의 overflow 가 팝오버를 자르지 않게. 위치는
  // 버튼 rect 로: 버튼 오른쪽, 아래 정렬(.style 프로퍼티는 CSP style-src 무관).
  document.body.appendChild(fly);
  const rect = btn.getBoundingClientRect();
  fly.style.left = `${Math.round(rect.right + 6)}px`;
  fly.style.bottom = `${Math.round(window.innerHeight - rect.bottom)}px`;
  // 다음 틱에 바깥 클릭 감지 등록(지금 클릭이 바로 닫지 않게)
  setTimeout(
    () => document.addEventListener("click", onDocClickForFlyout, true),
    0,
  );
}

// 포맷을 고를 때마다 새 빈 드래프트를 하나 더 만든다 — 트리에 "(빈 문서)",
// "(빈 문서2)"… 로 늘어난다.
export function startDraft(type) {
  const localId = createDraft(type);
  renderDocTree(); // 왼쪽 트리에 바로 뜨게
  location.hash = `#/draft/${type}/${localId}`;
}

// 헤더 제목 = id 소스(테이블/커맨드/스킬명) 클릭-투-편집. "이름"이 곧 문서 제목.
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

// ---- 드래프트 화면 (인라인 클릭-투-편집) ----
export function renderDraftScreen(type, localId) {
  const section = $("draft");
  const body = getDraftBody(localId);
  // 드래프트가 없어졌으면(저장/취소/잘못된 링크) 개요로.
  if (!DOC_TYPES.includes(type) || body == null) {
    location.hash = "#/corpus";
    return;
  }
  const persist = () => saveDraftBody(localId, body);
  const rerender = () => {
    persist();
    renderDraftScreen(type, localId);
  };

  const saveBtn = el("button", {
    type: "button",
    class: "btn primary",
    text: "저장 (비활성)",
    onclick: () => saveDraft(type, localId, body),
  });
  function updateSave() {
    const id = deriveDraftId(type, body);
    saveBtn.disabled = !id;
    saveBtn.title = id
      ? "이 드래프트를 비활성 문서로 저장합니다."
      : "제목(테이블/커맨드/스킬명)을 먼저 입력해야 저장할 수 있습니다.";
  }
  const onIdChange = () => {
    persist();
    updateSave();
    renderDocTree(); // 트리 라벨을 "(빈 문서)" → 새 제목으로 갱신
  };

  // 헤더 제목 = id 소스 클릭-투-편집. 여기에 바로 이름을 친다.
  const head = el("div", { class: "dfhead" }, [
    el("span", { class: "df-badge", text: "드래프트 · 저장 안 됨" }),
    el("span", { class: "dftitle-wrap" }, idSourceField(type, body, onIdChange)),
    el("span", { class: "chip", text: type }),
    el("span", { class: "sp" }),
    el("button", {
      type: "button",
      class: "btn ghost",
      text: "취소",
      onclick: () => {
        deleteDraft(localId);
        toast("드래프트를 버렸습니다.");
        renderDocTree();
        location.hash = "#/corpus";
      },
    }),
    saveBtn,
  ]);
  const note = el("div", { class: "df-note" }, [
    el("b", { text: "로컬 드래프트입니다 — 아직 서버에 저장되지 않았습니다." }),
    " 이름과 팩트를 채우고 ",
    el("b", { text: "저장" }),
    " 하면 비활성 문서로 올라갑니다. 설명 등 나머지는 저장 후 문서 화면에서 채우고, ",
    el("b", { text: "완성되면 활성화" }),
    " 하세요.",
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

// 클릭-투-편집 텍스트 (제자리 스왑, 전체 재렌더 없음). onChange 는 커밋 후 호출.
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

// ---- 저장: 드래프트 → inactive 문서 POST ----
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
    toast("제목(테이블/커맨드/스킬명)을 먼저 입력하세요.", "error");
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
    toast("저장했습니다 — 비활성 문서입니다. 이어서 채우고 완성되면 활성화하세요.");
    await renderDocTree();
    location.hash = `#/doc/${type}/${encodeURIComponent(id)}`;
    return;
  }
  if ((r.data || {}).error === "data_id_conflict") {
    toast(dataIdConflictText(r.data), "error");
    return;
  }
  if (r.status === 409) {
    toast(`이미 같은 이름(${id})의 문서가 있습니다.`, "error");
    return;
  }
  if (r.status === 400) {
    const d = r.data || {};
    const msg =
      d.error === "validation_failed"
        ? (d.details || []).join(" · ")
        : d.error === "edit_rejected"
          ? d.message
          : d.error || "";
    toast("저장 실패: " + msg, "error");
    return;
  }
  toast(`저장 실패 (${r.status || "네트워크"})`, "error");
}

// 타입 없이 올리기: one md as an unclassified document. Anyone who writes may;
// an admin gives it a type later (타입 정하기).
export function openUploadDialog() {
  const name = el("input", { type: "text", class: "fld mono", placeholder: "이름 (예: deploy-guide)", "aria-label": "이름" });
  const text = el("textarea", {
    class: "fld mono up-md",
    rows: 12,
    spellcheck: "false",
    placeholder: "md 를 붙여 넣거나 .md 파일 하나를 여기에 끌어 놓습니다",
    "aria-label": "md 본문",
  });
  const url = el("input", { type: "url", class: "fld mono", placeholder: "원본 URL (선택, https://…)", "aria-label": "원본 URL" });
  const send = el("button", { type: "submit", class: "btn primary", text: "올리기" });
  const dlg = el("dialog", { class: "up-dialog", "aria-label": "타입 없이 올리기" });
  const form = el("form", { method: "dialog" }, [
    el("h3", { text: "타입 없이 올리기" }),
    el("p", { class: "fhint", text: "미분류로 저장합니다. 타입은 admin 이 나중에 정합니다." }),
    dfRow("이름", true, name),
    dfRow("md", true, text),
    dfRow("원본", false, url),
    el("div", { class: "editacts" }, [
      send,
      el("button", { type: "button", class: "btn ghost", text: "취소", onclick: () => dlg.close() }),
    ]),
  ]);
  text.addEventListener("dragover", (e) => e.preventDefault());
  text.addEventListener("drop", async (e) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    e.preventDefault();
    if (files.length > 1 || !/\.(md|markdown|txt)$/i.test(files[0].name)) {
      toast(".md 파일 하나만 받습니다", "error");
      return;
    }
    text.value = await files[0].text();
    if (!name.value.trim())
      name.value = files[0].name
        .replace(/\.[^.]+$/, "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^[^a-z]+|-+$/g, "");
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = name.value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      toast("이름은 영어 소문자로 시작하고 소문자 · 숫자 · - 만 씁니다", "error");
      return;
    }
    if (!text.value.trim()) {
      toast("md 본문이 비었습니다", "error");
      return;
    }
    const u = url.value.trim();
    send.disabled = true;
    const r = await api("/api/docs/unclassified", {
      method: "POST",
      body: {
        schema: "unclassified/v1",
        id,
        keywords: [{ kw: id, inject: "full" }],
        status: "active",
        ...(u ? { origin: { url: u } } : {}),
        body: { name: id, markdown: text.value },
      },
    });
    send.disabled = false;
    if (r.status === 201) {
      dlg.close();
      toast("미분류로 올렸습니다");
      await renderDocTree();
      location.hash = `#/doc/unclassified/${encodeURIComponent(id)}`;
      return;
    }
    const d = r.data || {};
    toast(
      r.status === 409
        ? `이미 같은 이름(${id})의 문서가 있습니다.`
        : `올리기 실패 (${r.status})${d.details ? " — " + d.details.join(" · ") : d.message ? " — " + d.message : ""}`,
      "error",
    );
  });
  dlg.addEventListener("close", () => dlg.remove());
  dlg.appendChild(form);
  document.body.appendChild(dlg);
  dlg.showModal();
  name.focus();
}
