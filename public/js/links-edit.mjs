// 연결 고치기: the doc's hand-made links (type · 문서 · 관계) in a dialog.
// Links the body's [[ ]] made stay fixed here — they follow the body.
import { api } from "./api.mjs";
import { el, toast } from "./dom.mjs";
import { DOC_TYPES, TYPE_LABEL } from "./state.mjs";
import { STATUS_LABEL } from "./shared.mjs";

const LINK_RELS = ["screen", "related"];

export function openLinksDialog({ type, id, data, getRev, reload }) {
  const fromBody = new Set((data.wikilinks || []).filter((w) => w.found).map((w) => `${w.type}/${w.id}#related`));
  const isFromBody = (l) => fromBody.has(`${l.type}/${l.id}#${l.rel}`);
  const rows = (data.links || []).filter((l) => !isFromBody(l)).map(({ type: t, id: i, rel }) => ({ type: t, id: i, rel }));
  const fixed = (data.links || []).filter(isFromBody);
  const targetsOf = new Map();
  const targets = (t) => {
    if (!targetsOf.has(t)) targetsOf.set(t, api(`/api/docs?type=${t}`).then((r) => (r.ok ? r.data.docs : [])));
    return targetsOf.get(t);
  };
  const body = el("div", { class: "links-rows" });
  const relList = el("datalist", { id: "link-rels" }, LINK_RELS.map((r) => el("option", { value: r })));

  function row(r) {
    const typeSel = el("select", { class: "fld", "aria-label": "대상 타입" }, DOC_TYPES.map((t) => el("option", { value: t, text: TYPE_LABEL[t] })));
    typeSel.value = r.type;
    const idSel = el("select", { class: "fld mono", "aria-label": "대상 문서" });
    async function fillIds() {
      idSel.replaceChildren(el("option", { value: "", text: "불러오는 중…" }));
      const docs = (await targets(r.type)).filter((d) => !(r.type === type && d.id === id));
      idSel.replaceChildren(
        el("option", { value: "", text: "문서를 고르세요" }),
        ...docs.map((d) => el("option", { value: d.id, text: d.status === "active" ? d.id : `${d.id} (${STATUS_LABEL[d.status] ?? d.status})` })),
      );
      idSel.value = docs.some((d) => d.id === r.id) ? r.id : "";
      r.id = idSel.value;
    }
    typeSel.addEventListener("change", () => {
      r.type = typeSel.value;
      r.id = "";
      fillIds();
    });
    idSel.addEventListener("change", () => (r.id = idSel.value));
    const relInp = el("input", { class: "fld mono", type: "text", list: "link-rels", "aria-label": "관계", placeholder: "related" });
    relInp.value = r.rel;
    relInp.addEventListener("input", () => (r.rel = relInp.value.trim()));
    fillIds();
    return el("div", { class: "link-row" }, [
      typeSel,
      idSel,
      relInp,
      el("button", { type: "button", class: "btn ghost sm", text: "삭제", onclick: () => { rows.splice(rows.indexOf(r), 1); paint(); } }),
    ]);
  }
  function paint() {
    body.replaceChildren(
      ...fixed.map((l) =>
        el("div", { class: "link-row fixed" }, [
          el("span", { class: "mono", text: TYPE_LABEL[l.type] ?? l.type }),
          el("span", { class: "mono", text: l.id }),
          el("span", { class: "mono", text: l.rel }),
          el("span", { class: "chip from-body", title: "본문의 [[ ]] 에서 온 연결입니다", text: "본문에서" }),
        ]),
      ),
      ...(rows.length || fixed.length ? rows.map(row) : [el("p", { class: "dim", text: "연결이 없습니다." })]),
    );
  }
  const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
  const dlg = el("dialog", { class: "dlg links-dlg", "aria-label": "연결 고치기" });
  save.addEventListener("click", async () => {
    if (rows.some((r) => !r.id || !r.rel)) {
      toast("줄마다 대상 문서와 관계를 채우세요.", "error");
      return;
    }
    save.disabled = true;
    const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}/links`, { method: "PUT", headers: { "if-match": getRev() }, body: { links: rows } });
    save.disabled = false;
    if (r.ok) {
      dlg.close();
      toast("연결을 저장했습니다");
      reload();
      return;
    }
    const d = r.data || {};
    if (r.status === 409) toast("다른 사람이 먼저 고쳤습니다 — 문서를 다시 여세요.", "error");
    else if (d.error === "unknown_link_target") toast(`없는 문서입니다 — ${d.missing.map((m) => `${m.type}/${m.id}`).join(", ")}`, "error");
    else toast(`저장 실패 (${r.status})${d.details ? ` — ${d.details.join(" · ")}` : ""}`, "error");
  });
  dlg.append(
    el("h3", { text: "연결 고치기" }),
    el("p", { class: "dim", text: "본문의 [[ ]] 로 생긴 연결은 본문을 고치면 따라 바뀝니다." }),
    relList,
    body,
    el("div", { class: "editacts" }, [
      el("button", { type: "button", class: "btn ghost sm", text: "+ 연결 추가", onclick: () => { rows.push({ type: DOC_TYPES[0], id: "", rel: "related" }); paint(); } }),
      el("span", { class: "sp" }),
      el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: () => dlg.close() }),
      save,
    ]),
  );
  dlg.addEventListener("close", () => dlg.remove());
  document.body.appendChild(dlg);
  paint();
  dlg.showModal();
}
