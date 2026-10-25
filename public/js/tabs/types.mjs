// 타입 관리(6-v2, admin): the type list as a table (⋮⋮ 끌기 · 색 · 라벨 · id ·
// 종류 · 문서 · 상태 · 설명 · 동작) and a 408 form on the right. The order
// is dragged (or moved with ↑ ↓ on the handle) and saved with 순서 저장;
// 미분류 stays last. A registered type is edited or closed here; a code
// type's fields live in code.
import { api, invalidateDocs } from "../api.mjs";
import { el, icon, toast } from "../dom.mjs";
import { screen, setActiveTab, setCrumbs } from "../shell.mjs";
import { TYPES, TYPES_REV, loadTypes, setTypes } from "../state.mjs";

// FE 토큰 여덟(밝음 값): 청록 · 주황 · 남청 · 빨강 · 노랑 · 초록 · 파랑 · 갈색.
export const PALETTE = [
  { name: "청록", color: "#256b5e" },
  { name: "주황", color: "#e8a55a" },
  { name: "남청", color: "#4f6d8a" },
  { name: "빨강", color: "#c64545" },
  { name: "노랑", color: "#d4a017" },
  { name: "초록", color: "#5db872" },
  { name: "파랑", color: "#1f5fbf" },
  { name: "갈색", color: "#b4571a" },
];
const TYPE_ID_RE = /^[a-z][a-z0-9-]*$/;
const RESERVED = new Set(["types", "docs", "assets", "audit", "score", "proposals", "graph", "order", "rendered", "md", "common"]);
const COLOR_RE = /^#[0-9a-f]{6}$/;
// What a code type holds; its own fields live in code, not in the type list.
const CODE_DESC = {
  "db-schema": "테이블 · 컬럼",
  "msg-format": "설비 커맨드",
  "domain-skill": "스킬 문서(md)",
  domain: "도메인 지식(md) — main 이 가리키는 지식",
  "screen-map": "화면 지도",
  manual: "화면 매뉴얼(캡처)",
  "fab-line": "라인",
  unclassified: "타입을 정하지 않고 올린 문서",
};

let editing = null; // null = 새 타입, else the type id being edited

export async function renderTypes() {
  setActiveTab("types");
  setCrumbs([{ label: "타입" }]);
  await loadTypes();
  const root = screen();
  const savedOrder = TYPES.filter((t) => t.id !== "unclassified").map((t) => t.id);
  let order = [...savedOrder];
  const byId = new Map(TYPES.map((t) => [t.id, t]));
  const orderDirty = () => order.join() !== savedOrder.join();

  const counts = { code: TYPES.filter((t) => t.builtin && t.id !== "unclassified").length, reg: TYPES.filter((t) => !t.builtin).length };
  const stateTag = el("span", { class: "chip warnchip", text: "순서 바뀜 · 저장 전", hidden: true });
  const revertBtn = el("button", { type: "button", class: "btn sm", text: "되돌리기", onclick: () => { order = [...savedOrder]; paintRows(); } });
  const saveOrderBtn = el("button", { type: "button", class: "btn sm primary", text: "순서 저장", onclick: saveOrder });
  const tbody = el("tbody", {});
  const auditBox = el("div", { class: "types-audit" });
  const form = el("aside", { class: "panel types-form", "aria-label": "타입 칸" });

  async function saveOrder() {
    saveOrderBtn.disabled = true;
    const r = await api("/api/types/order", { method: "PUT", headers: TYPES_REV ? { "if-match": TYPES_REV } : {}, body: { order } });
    saveOrderBtn.disabled = false;
    if (!r.ok) {
      toast(r.status === 409 ? "다른 사람이 타입 목록을 먼저 고쳤습니다 — 다시 읽습니다." : `순서를 저장하지 못했습니다 (${r.status})${r.data?.message ? ` — ${r.data.message}` : ""}`, "error");
      if (r.status === 409) renderTypes();
      return;
    }
    setTypes(r.data);
    invalidateDocs();
    toast("타입 순서를 저장했습니다");
    renderTypes();
  }

  // ---------- 표 ----------
  let dragId = null;
  function move(id, delta) {
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    order.splice(i, 1);
    order.splice(j, 0, id);
    paintRows();
    tbody.querySelector(`[data-id="${CSS.escape(id)}"] .grip`)?.focus();
  }
  function kindCell(t) {
    if (t.id === "unclassified") return el("span", { class: "tag ghosttag", text: "내장" });
    if (t.builtin) return el("span", { class: "dim kind-code" }, [icon("lock", 12), " 코드"]);
    return el("span", { class: "tag", text: "등록" });
  }
  function row(t, pinned = false) {
    const handle = pinned
      ? el("span", { class: "grip pinned", title: "늘 마지막", "aria-label": "늘 마지막" }, icon("pin", 13))
      : el("button", {
          type: "button",
          class: "grip",
          draggable: "true",
          "aria-label": `${t.label} 순서 옮기기 — ↑ ↓`,
          title: "끌거나 ↑ ↓ 로 옮깁니다",
          onkeydown: (e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              move(t.id, e.key === "ArrowUp" ? -1 : 1);
            }
          },
        }, icon("grip", 14));
    const tr = el("tr", { class: `${t.status === "archived" ? "off" : ""}${editing === t.id ? " on" : ""}`, "data-id": t.id }, [
      el("td", { class: "td-grip" }, handle),
      el("td", {}, el("span", { class: "tdot", style: { "--c": t.color } })),
      el("td", { class: "td-label" }, el("b", { text: t.label })),
      el("td", { class: "mono", text: t.id }),
      el("td", {}, kindCell(t)),
      el("td", { class: "num", text: String(t.count ?? 0) }),
      el("td", {}, el("span", { class: `chip st-${t.status}`, text: t.status === "archived" ? "CLOSED" : "ACTIVE" })),
      el("td", { class: "td-desc", text: t.description ?? CODE_DESC[t.id] ?? "" }),
      el("td", { class: "ty-acts" },
        pinned
          ? el("span", { class: "dim", text: "늘 마지막" })
          : t.builtin
            ? el("span", { class: "dim", text: "칸은 코드에서" })
            : [
                el("button", { type: "button", class: "btn sm", text: "고치기", onclick: () => { editing = t.id; paintRows(); paintForm(); } }),
                t.status === "archived"
                  ? null
                  : el("button", { type: "button", class: "btn sm", text: "닫기", onclick: () => archive(t) }),
              ]),
    ]);
    if (!pinned) {
      handle.addEventListener("dragstart", (e) => {
        dragId = t.id;
        tr.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", t.id);
      });
      handle.addEventListener("dragend", () => {
        dragId = null;
        tr.classList.remove("dragging");
        for (const r of tbody.querySelectorAll(".drop-before, .drop-after")) r.classList.remove("drop-before", "drop-after");
      });
      tr.addEventListener("dragover", (e) => {
        if (!dragId || dragId === t.id) return;
        e.preventDefault();
        const after = e.offsetY > tr.offsetHeight / 2;
        tr.classList.toggle("drop-after", after);
        tr.classList.toggle("drop-before", !after);
      });
      tr.addEventListener("dragleave", () => tr.classList.remove("drop-before", "drop-after"));
      tr.addEventListener("drop", (e) => {
        e.preventDefault();
        if (!dragId || dragId === t.id) return;
        const after = tr.classList.contains("drop-after");
        order.splice(order.indexOf(dragId), 1);
        order.splice(order.indexOf(t.id) + (after ? 1 : 0), 0, dragId);
        paintRows();
      });
    }
    return tr;
  }
  function paintRows() {
    tbody.replaceChildren(...order.map((id) => row(byId.get(id))), row(byId.get("unclassified"), true));
    const dirty = orderDirty();
    stateTag.hidden = !dirty;
    revertBtn.disabled = !dirty;
    saveOrderBtn.disabled = !dirty;
  }

  async function archive(t) {
    if (!confirm(`${t.label}(${t.id}) 타입을 닫습니다. 문서는 그대로 읽히고, 새 문서 메뉴와 새 내용은 받지 않습니다.`)) return;
    const r = await api(`/api/types/${encodeURIComponent(t.id)}/archive`, { method: "POST", headers: TYPES_REV ? { "if-match": TYPES_REV } : {} });
    if (!r.ok) return toast(r.status === 409 ? "다른 사람이 타입 목록을 먼저 고쳤습니다 — 다시 읽으세요." : `닫지 못했습니다 (${r.status})`, "error");
    setTypes(r.data);
    toast(`${t.label} 타입을 닫았습니다`);
    renderTypes();
  }

  // ---------- 폼 ----------
  function paintForm() {
    const t = editing ? byId.get(editing) : null;
    const isNew = !t;
    const id = el("input", { type: "text", class: "fld mono", placeholder: "meeting-note", "aria-label": "id", disabled: !isNew, value: t?.id ?? "" });
    const label = el("input", { type: "text", class: "fld", placeholder: "회의록", maxlength: "40", "aria-label": "라벨", value: t?.label ?? "" });
    const desc = el("input", { type: "text", class: "fld", placeholder: "FDC 주간 회의 기록", maxlength: "200", "aria-label": "설명 한 줄", value: t?.description ?? "" });
    let color = t?.color ?? PALETTE[5].color;
    const custom = el("input", { type: "text", class: "fld mono color-in", "aria-label": "색 직접 넣기 (#rrggbb)", value: color });
    const swatches = el("div", { class: "swatches", role: "radiogroup", "aria-label": "색" });
    const colorNote = el("p", { class: "dim fhint" });
    const preview = el("div", { class: "types-preview" });
    const errors = el("ul", { class: "form-errors", hidden: true });
    function paintColor() {
      swatches.replaceChildren(
        ...PALETTE.map((p) =>
          el("button", {
            type: "button",
            class: `swatch${p.color === color ? " on" : ""}`,
            role: "radio",
            "aria-checked": String(p.color === color),
            "aria-label": p.name,
            title: `${p.name} ${p.color}`,
            style: { "--c": p.color },
            onclick: () => {
              color = p.color;
              custom.value = color;
              paintColor();
            },
          }),
        ),
      );
      const name = PALETTE.find((p) => p.color === color)?.name ?? "직접 넣은 색";
      const shared = TYPES.filter((x) => x.color === color && x.id !== t?.id).map((x) => x.label);
      colorNote.textContent = `${name}${shared.length ? ` · ${shared.join(" · ")} 도 씀` : ""} · 트리 점 · 칩 · 그래프 점`;
      paintPreview();
    }
    function paintPreview() {
      const l = label.value.trim() || "라벨";
      preview.replaceChildren(
        el("span", { class: "dim", text: "미리보기" }),
        el("span", { class: "chip" }, [el("span", { class: "tdot", style: { "--c": color } }), ` ${l}`]),
        el("span", { class: "wchip", style: { "--c": color } }, [el("span", { class: "wchip-t", text: l }), id.value.trim() || "문서-id"]),
      );
    }
    custom.addEventListener("input", () => {
      const v = custom.value.trim().toLowerCase();
      if (COLOR_RE.test(v)) {
        color = v;
        paintColor();
      }
    });
    label.addEventListener("input", paintPreview);
    id.addEventListener("input", paintPreview);
    const field = (name, control, hint) => el("label", { class: "tf-row" }, [el("span", { class: "tf-k", text: name }), control, hint ? el("span", { class: "dim fhint", text: hint }) : null]);
    const posOf = (tid) => {
      const i = order.indexOf(tid);
      if (i < 0) return "—";
      const prev = order[i - 1] ? byId.get(order[i - 1]).label : null;
      const next = order[i + 1] ? byId.get(order[i + 1]).label : "미분류";
      return `${i + 1}번째${prev ? ` · ${prev} 다음` : ""}, ${next} 앞`;
    };
    const save = el("button", { type: "submit", class: "btn primary", text: isNew ? "등록" : "저장" });
    const f = el("form", { class: "types-f", novalidate: true }, [
      el("div", { class: "tf-h" }, isNew
        ? [el("b", { text: "새 타입" }), el("span", { class: "dim", text: "md 타입 — 본문은 이름과 md 한 장" })]
        : [el("b", { text: `${t.label} 고치기` }), el("span", { class: "tag", text: "등록" }), el("span", { class: "mono dim", text: t.id })]),
      el("div", { class: "tf-body panel-scroll" }, [
        field("id", id, isNew ? "영문 소문자 · 숫자 · 하이픈. 저장 뒤 고정" : "저장 뒤 고정된 값"),
        field("라벨", label, "트리 · 칩 · 새 문서 메뉴에 보임"),
        el("div", { class: "tf-row" }, [el("span", { class: "tf-k", text: "색" }), swatches, el("div", { class: "color-custom" }, [el("span", { class: "dim", text: "직접" }), custom]), colorNote]),
        field("설명 한 줄", desc, "새 문서 메뉴에서 라벨 옆에 보임"),
        isNew ? null : el("div", { class: "tf-row" }, [el("span", { class: "tf-k", text: "순서" }), el("div", { class: "fld ro", text: posOf(t.id) }), el("span", { class: "dim fhint", text: "표에서 ⋮⋮ 를 끌어 바꿉니다. 미분류는 늘 마지막" })]),
        isNew ? null : el("div", { class: "tf-row" }, [el("span", { class: "tf-k", text: "이 타입의 문서" }), el("div", { class: "fld ro", text: String(t.count ?? 0) })]),
        preview,
        errors,
      ]),
      el("div", { class: "tf-foot" }, [
        el("span", { class: "dim", text: "칸을 고친 뒤 저장하면 커밋 하나와 감사 한 줄이 남습니다" }),
        el("button", { type: "button", class: "btn", text: "취소", onclick: () => { editing = null; paintRows(); paintForm(); } }),
        save,
      ]),
    ]);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const tid = id.value.trim();
      const problems = [];
      if (isNew) {
        if (!TYPE_ID_RE.test(tid)) problems.push("id 는 영문 소문자로 시작하고 소문자 · 숫자 · - 만 씁니다");
        else if (RESERVED.has(tid)) problems.push(`${tid} 는 예약어입니다`);
        else if (byId.has(tid)) problems.push(`${tid} 타입이 이미 있습니다`);
      }
      if (!label.value.trim()) problems.push("라벨이 비었습니다");
      if (!COLOR_RE.test(color)) problems.push("색은 #rrggbb 입니다");
      if (problems.length) {
        errors.replaceChildren(...problems.map((p) => el("li", { text: p })));
        errors.hidden = false;
        return;
      }
      save.disabled = true;
      const r = await api(`/api/types/${encodeURIComponent(tid)}`, {
        method: "PUT",
        headers: TYPES_REV ? { "if-match": TYPES_REV } : {},
        body: { label: label.value.trim(), color, ...(desc.value.trim() ? { description: desc.value.trim() } : {}) },
      });
      save.disabled = false;
      if (!r.ok) {
        const d = r.data || {};
        errors.replaceChildren(el("li", { text: r.status === 409 && d.error === "unknown_base_rev" ? "다른 사람이 타입 목록을 먼저 고쳤습니다 — 다시 읽으세요." : d.message || [].concat(d.details || []).join(" · ") || `저장 실패 (${r.status})` }));
        errors.hidden = false;
        return;
      }
      setTypes(r.data);
      toast(isNew ? `타입 ${tid} 를 등록했습니다` : `타입 ${tid} 를 고쳤습니다`);
      editing = null;
      renderTypes();
    });
    form.replaceChildren(f);
    paintColor();
  }

  // ---------- 감사 ----------
  api("/api/audit").then((r) => {
    const rows = (r.ok ? r.data.entries : []).filter((e) => /^타입 /.test(e.message)).slice(0, 8);
    auditBox.replaceChildren(
      el("div", { class: "plabel", text: "타입 변경 감사" }),
      rows.length
        ? el("ul", { class: "plist" }, rows.map((e) =>
            el("li", { class: "taudit" }, [
              el("span", { class: "mono dim", text: e.at.slice(5, 16).replace("T", " ") }),
              el("span", { text: `${e.message} · ${e.author}` }),
              el("span", { class: "mono dim", text: e.rev.slice(0, 7) }),
            ])))
        : el("p", { class: "dim pnone", text: "기록이 없습니다." }),
    );
  });

  const table = el("section", { class: "types-card", "aria-label": "문서 타입" }, [
    el("div", { class: "types-h" }, [
      el("b", { text: "문서 타입" }),
      el("span", { class: "dim", text: `코드 ${counts.code} · 등록 ${counts.reg} · 내장 1` }),
      stateTag,
      el("span", { class: "sp" }),
      revertBtn,
      saveOrderBtn,
      el("button", { type: "button", class: "btn sm", onclick: () => { editing = null; paintRows(); paintForm(); form.querySelector("input")?.focus(); } }, [icon("plus", 13), "새 타입"]),
    ]),
    el("p", { class: "types-lead" }, [
      el("span", {}, [icon("grip", 13), " 를 끌어 순서를 바꿉니다. 이 순서가 문서 탭 트리 · 새 문서 메뉴 · 검색 묶음 순서입니다."]),
      el("span", { class: "dim", text: "저장 = 커밋 하나" }),
    ]),
    el("div", { class: "tbl-wrap" }, el("table", { class: "types-tbl" }, [
      el("thead", {}, el("tr", {}, ["", "색", "라벨", "id", "정의", "문서", "상태", "설명", "동작"].map((h, i) => el("th", { scope: "col", class: i === 5 ? "num" : i === 8 ? "ty-acts" : "", text: h })))),
      tbody,
    ])),
    auditBox,
  ]);
  root.appendChild(el("main", { class: "main wide types-main" }, el("div", { class: "types-layout" }, [table, form])));
  paintRows();
  paintForm();
}

