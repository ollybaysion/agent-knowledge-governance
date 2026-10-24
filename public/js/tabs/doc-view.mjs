import { api } from "../api.mjs";
import { $, downloadTextFile, el, jsonPane, toast } from "../dom.mjs";
import { STATUS_LABEL, VERIFY_KEY, VERIFY_KIND_LABEL, VERIFY_KIND_WIRE, VERIFY_LABEL_OF_WIRE, bandClass, dataIdConflictText, docMeta, evidence, getSlot, inactiveBar, keywordChips, roleChip, setSlot, shortAt, shortRev, skillSectionsLib, sqlBindLib, statusBadge, tierBadge, verifyLib, viewChips, wikiText, wordDiff } from "../shared.mjs";
import { DOC_TYPES, TIER_LABEL, TYPE_LABEL, currentUser, isMdType, setLastDoc } from "../state.mjs";
import { highlightTree, renderDocTree } from "./docs.mjs";

// ================= 문서 (단일 문서 뷰) =================
// 편집은 슬롯 단위 클릭-투-편집(도착 상태 텍스트를 바로 누르면 그 슬롯만
// 편집 필드로 바뀜) — 문서 전체를 편집 모드로 앞서 전환하는 버튼은 없다.
export let editingAddr = null; // null | slot address currently being edited
export async function renderDocScreen(type, id) {
  const section = $("doc");
  section.replaceChildren(el("p", { class: "loading", text: "불러오는 중…" }));
  const res = await api(`/api/docs/${type}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    section.replaceChildren(
      el("p", {
        class: "error",
        text: `문서를 불러오지 못했습니다 (${res.status})`,
      }),
    );
    return;
  }
  setLastDoc({ type, id });
  highlightTree();
  editingAddr = null;
  // doc/rev are reassigned in place after a clean save so the screen can
  // repaint optimistically instead of re-fetching the whole document.
  let { json: doc, rev } = res.data;
  const { slots, md } = res.data;
  const canApprove = currentUser.group === "admin";
  const canEdit = canApprove;
  let editBuf = null; // {text, evidence[]} — working copy of the open slot
  let reconcileFor = null; // {address, doc, rev, overlap} — 409 화해 카드 상태
  const live = {}; // live refs of the open editor (badge/caption/save/diff)
  let jsonOpen = false; // 승인자 원본 JSON 좌우 분할 패널이 열려 있는지

  const notice = el("div", { id: "doc-notice" });
  const linksEl = linksSection(type, id, res.data, () => rev, canEdit, reload);

  async function reload() {
    await renderDocTree();
    renderDocScreen(type, id);
  }
  // #7 — activate/deactivate. Approver only, If-Match like every other write.
  async function statusAction(target) {
    const r = await api(
      `/api/docs/${type}/${encodeURIComponent(id)}/${
        target === "active" ? "activate" : "deactivate"
      }`,
      { method: "POST", headers: { "if-match": rev } },
    );
    if (!r.ok) {
      toast(
        r.status === 409
          ? "충돌 — 다른 사용자가 이 문서를 먼저 고쳤습니다. 새로고침 후 다시 시도하세요."
          : `상태 변경 실패 (${r.status})`,
        "error",
      );
      return;
    }
    toast(
      target === "active"
        ? "활성 — 다음 동기화부터 주입됩니다."
        : "비활성 — 미러에서 빠집니다.",
    );
    reload();
  }

  // Labelled by the state it arrives at, like 추정으로 반영/확정 — the button
  // says where the document lands, not what the click does.
  function statusSwitch() {
    if (!canApprove || doc.status === "archived") return null;
    const toActive = doc.status !== "active";
    return el(
      "button",
      {
        type: "button",
        class: `act ${toActive ? "a-promote" : "a-reject"}`,
        title: toActive
          ? "미러로 배포해 세션에 주입되게 합니다."
          : "미러에서 빼 주입을 멈춥니다. 문서와 이력은 남습니다.",
        onclick: () => statusAction(toActive ? "active" : "inactive"),
      },
      toActive ? "활성" : "비활성",
    );
  }

  async function slotAction(verb, address, endpoint) {
    const r = await api(
      `/api/docs/${type}/${encodeURIComponent(id)}/${endpoint}`,
      {
        method: "POST",
        headers: { "if-match": rev },
        body: { slots: [address] },
      },
    );
    if (!r.ok) {
      toast(`${verb} 실패 (${r.status})`, "error");
      return;
    }
    reload();
  }

  // A tiered-value slot in reading mode: badge + text(tier-colored) + evidence + inline actions.
  function slotReadActions(slot) {
    const acts = [];
    if (canApprove && slot.tier === "inferred")
      acts.push(
        el(
          "button",
          {
            type: "button",
            class: "btn promote sm",
            onclick: () => slotAction("확정", slot.address, "promote"),
          },
          ["확정", el("span", { class: "role", text: "admin" })],
        ),
      );
    if (canEdit && (slot.tier === "inferred" || slot.tier === "confirmed"))
      acts.push(
        el("button", {
          type: "button",
          class: "btn danger sm",
          onclick: () => slotAction("폐기", slot.address, "deprecate"),
          text: "폐기",
        }),
      );
    if (slot.tier === "deprecated") {
      acts.push(
        el("button", {
          type: "button",
          class: "btn ghost sm",
          onclick: () => {
            startEdit(slot.address);
          },
          text: "복원",
        }),
      );
      if (canApprove)
        acts.push(
          el("button", {
            type: "button",
            class: "btn danger sm",
            onclick: () =>
              toast("제거 확정 엔드포인트는 §6에 아직 없습니다(D4 갭).", ""),
            text: "삭제",
          }),
        );
    }
    return acts;
  }
  const tierTextClass = {
    scaffold: "t-sc",
    inferred: "t-inf",
    confirmed: "t-conf",
    deprecated: "t-conf",
  };
  function slotDirty() {
    if (!editingAddr || !editBuf) return false;
    const s = slotByAddr(editingAddr);
    if (!s) return false;
    return (
      editBuf.text.trim() !== (s.text || "").trim() ||
      editBuf.evidence.join(" ") !== (s.evidence || []).join(" ")
    );
  }
  function startEdit(address) {
    // Dirty guard: an unsaved edit is never dropped because a neighbouring
    // slot was clicked — flash the open editor and stay put instead.
    if (editingAddr && editingAddr !== address && slotDirty()) {
      const open = document.querySelector(".slot-edit");
      if (open) {
        open.classList.remove("dirtyflash");
        void open.offsetWidth;
        open.classList.add("dirtyflash");
      }
      toast("저장하지 않은 편집이 있습니다 — 저장하거나 취소한 뒤 이동하세요.");
      return;
    }
    const slot = slotByAddr(address);
    editingAddr = address;
    reconcileFor = null;
    editBuf = {
      text: (slot && slot.text) || "",
      evidence: ((slot && slot.evidence) || []).slice(),
    };
    renderInner();
  }
  function cancelEdit() {
    editingAddr = null;
    editBuf = null;
    reconcileFor = null;
    renderInner();
  }
  function slotReadText(slot) {
    const editable = canEdit && slot.tier !== "deprecated";
    const common = editable
      ? { title: "클릭해서 편집", onclick: () => startEdit(slot.address) }
      : {};
    if (slot.tier === "scaffold")
      return el("span", {
        class: editable ? "t-sc editable" : "t-sc",
        text: "{{설명}}",
        ...common,
      });
    return el("span", {
      class: `${tierTextClass[slot.tier]}${slot.tier === "deprecated" ? " strike" : ""}${editable ? " editable" : ""}`,
      text: slot.text || "",
      ...common,
    });
  }
  // 저장하면 티어가 어디로 가는지 — 서버 applyEdit 규칙의 클라이언트 미러.
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
    const slot = slotByAddr(editingAddr);
    const known = (slot && slot.evidence) || [];
    editBuf.evidence.forEach((ev, idx) => {
      const chip = el(
        "span",
        { class: `evchip${known.includes(ev) ? "" : " new"}` },
        [
          ev,
          el("button", {
            type: "button",
            "aria-label": `근거 제거: ${ev}`,
            text: "✕",
            onclick: () => {
              editBuf.evidence.splice(idx, 1);
              renderChips();
              updateLive();
            },
          }),
        ],
      );
      box.insertBefore(chip, live.chipInput);
    });
  }
  function commitChip() {
    const v = live.chipInput.value
      .trim()
      .replace(/[;,]+$/, "")
      .trim();
    if (v && !editBuf.evidence.includes(v)) editBuf.evidence.push(v);
    live.chipInput.value = "";
    renderChips();
    updateLive();
  }

  // ① 도장 모핑 · ② 저장 가드 · ④ diff. 타이핑마다 전체를 다시 그리면 캐럿을
  // 잃으므로, 열린 편집기 안의 노드만 제자리에서 갱신한다.
  function updateLive() {
    const slot = slotByAddr(editingAddr);
    if (!slot || !live.tierLive) return;
    const textChanged = editBuf.text.trim() !== (slot.text || "").trim();
    const evChanged =
      editBuf.evidence.join(" ") !== (slot.evidence || []).join(" ");
    const changed = textChanged || evChanged;
    const to = nextTier(slot, editBuf.text, textChanged);

    live.tierLive.replaceChildren();
    if (to !== slot.tier) {
      const demote = slot.tier === "confirmed";
      live.tierLive.append(
        el("span", { class: `from ${demote ? "demote" : "keep"}` }, [
          tierBadge(slot.tier),
        ]),
        el("span", { class: "arrow", text: "→" }),
        tierBadge(to),
      );
      const toScaffold = to === "scaffold";
      live.sealCap.hidden = false;
      live.sealCap.className =
        demote || toScaffold ? "seal-cap" : "seal-cap promote";
      live.sealCap.textContent = toScaffold
        ? "텍스트를 비우면 이 슬롯은 빈칸으로 되돌아갑니다."
        : demote
          ? "저장하면 확정이 풀립니다 — 다시 확정하려면 검토가 필요합니다."
          : "빈칸을 채우면 추정으로 반영됩니다.";
    } else {
      live.tierLive.appendChild(tierBadge(slot.tier));
      live.sealCap.hidden = true;
      live.sealCap.textContent = "";
    }

    // 서버가 400으로 막는 "바뀐 슬롯엔 근거 필수"를 저장 전으로 당긴다.
    if (!changed) {
      live.save.disabled = true;
      live.save.title = "변경 없음";
    } else if (textChanged && editBuf.evidence.length === 0) {
      live.save.disabled = true;
      live.save.title =
        "근거를 1개 이상 추가하세요 — 근거가 없으면 다음 사람이 확정할 수 없습니다.";
    } else {
      live.save.disabled = false;
      live.save.title = "";
    }

    const body = live.diffBody;
    body.replaceChildren();
    if (!changed) {
      body.appendChild(el("span", { class: "dim", text: "아직 변경 없음" }));
      return;
    }
    if (textChanged) {
      const wd = el("span", { class: "wd" });
      for (const p of wordDiff(slot.text || "", editBuf.text)) {
        wd.appendChild(
          p.t === "eq"
            ? document.createTextNode(`${p.w} `)
            : el("span", { class: p.t, text: `${p.w} ` }),
        );
      }
      body.appendChild(
        el("div", { class: "diffline" }, [
          el("span", { class: "k", text: "텍스트" }),
          wd,
        ]),
      );
    }
    if (to !== slot.tier) {
      body.appendChild(
        el("div", { class: "diffline" }, [
          el("span", { class: "k", text: "티어" }),
          el("span", {}, [
            tierBadge(slot.tier),
            document.createTextNode(" → "),
            tierBadge(to),
          ]),
        ]),
      );
    }
    if (evChanged) {
      const evd = el("span", { class: "evd" });
      for (const e of slot.evidence || [])
        if (!editBuf.evidence.includes(e))
          evd.appendChild(el("span", { class: "del", text: e }));
      for (const e of editBuf.evidence)
        if (!(slot.evidence || []).includes(e))
          evd.appendChild(el("span", { class: "add", text: `+${e}` }));
      if (evd.childNodes.length)
        body.appendChild(
          el("div", { class: "diffline" }, [
            el("span", { class: "k", text: "근거" }),
            evd,
          ]),
        );
    }
  }

  // 한 슬롯의 인라인 편집기 — 읽기 텍스트가 있던 자리에서 그대로 펼쳐진다.
  function editBlock(slot) {
    // 방어: startEdit 을 거치지 않고 열리는 경로(복원 버튼 등)에서도 버퍼를 만든다.
    if (!editBuf)
      editBuf = {
        text: slot.text || "",
        evidence: (slot.evidence || []).slice(),
      };
    const tierLive = el("span", { class: "tier-live" });
    const textArea = el("textarea", { spellcheck: "false" });
    textArea.value = editBuf.text;
    const chipInput = el("input", {
      type: "text",
      placeholder: "근거 file:line — 입력 후 ; 또는 Enter",
    });
    const chipBox = el("div", { class: "chipfield" }, chipInput);
    const sealCap = el("div", { class: "seal-cap", hidden: true });
    const save = el("button", {
      type: "button",
      class: "btn primary sm",
      text: "저장",
      onclick: () => saveEdit(slot.address),
    });
    const diffBody = el("div", { class: "diffbody" });

    live.tierLive = tierLive;
    live.sealCap = sealCap;
    live.save = save;
    live.diffBody = diffBody;
    live.chipBox = chipBox;
    live.chipInput = chipInput;
    live.textArea = textArea;

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
      } else if (
        e.key === "Backspace" &&
        !chipInput.value &&
        editBuf.evidence.length
      ) {
        editBuf.evidence.pop();
        renderChips();
        updateLive();
      }
    });
    chipInput.addEventListener("blur", () => {
      if (chipInput.value.trim()) commitChip();
    });
    chipBox.addEventListener("click", (e) => {
      if (e.target === chipBox) chipInput.focus();
    });

    const block = el("div", { class: "slot-edit" }, [
      el("div", { class: "toprow" }, tierLive),
      textArea,
      el("div", { class: "fieldlab", text: "근거 (evidence)" }),
      chipBox,
      sealCap,
      el("div", { class: "editacts" }, [
        save,
        el("button", {
          type: "button",
          class: "btn ghost sm",
          text: "취소",
          onclick: cancelEdit,
        }),
        el("span", { class: "kbd" }, [
          el("b", { text: "esc" }),
          " 취소 · ",
          el("b", { text: "⌘/Ctrl+↵" }),
          " 저장",
        ]),
      ]),
      el("details", { class: "diffbox" }, [
        el("summary", { text: "무엇이 바뀌나" }),
        diffBody,
      ]),
    ]);
    block.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!save.disabled) saveEdit(slot.address);
      }
    });
    // DOM에 붙은 뒤 실행 — 높이 맞춤·칩·프리뷰 초기화 + 포커스
    setTimeout(() => {
      grow();
      renderChips();
      updateLive();
      textArea.focus();
      textArea.setSelectionRange(textArea.value.length, textArea.value.length);
    }, 0);
    return block;
  }

  // ② 충돌 화해 카드 — 서버가 409에 실어 보낸 current/overlap을 그대로 쓴다.
  // 같은 칸에 대한 서로 다른 두 해석은 자동 병합하지 않는다: 사람이 고른다.
  function reconcileCard(address) {
    const theirs = getSlot(reconcileFor.doc.body, address) || {};
    const mineText = (editBuf && editBuf.text) || "";
    const mineEv = editBuf ? editBuf.evidence.slice() : [];
    const theirEv = theirs.evidence || [];
    const union = theirEv.concat(mineEv.filter((e) => !theirEv.includes(e)));
    const mergeTA = el("textarea", { spellcheck: "false" });
    mergeTA.value = theirs.text || "";
    const resolveWith = (text, ev) =>
      commitSlot(address, text, ev, reconcileFor.doc.body, reconcileFor.rev);

    return el("div", { class: "reconcile" }, [
      el("div", { class: "rhead" }, [
        "충돌 — 같은 슬롯을 두 사람이 동시에 고쳤습니다 ",
        el("span", { class: "addr", text: address }),
      ]),
      el("div", { class: "panes" }, [
        el("div", { class: "pane mine" }, [
          el("div", { class: "plab" }, [
            el("span", { text: "내 편집" }),
            el("span", { class: "who", text: currentUser.id }),
          ]),
          el("div", { class: "ptext", text: mineText }),
          el("div", { class: "pev", text: mineEv.join(" · ") || "근거 없음" }),
          el("button", {
            type: "button",
            class: "btn sm",
            text: "내 것으로",
            onclick: () => resolveWith(mineText, mineEv),
          }),
        ]),
        el("div", { class: "pane" }, [
          el("div", { class: "plab" }, [
            el("span", { text: "현재 저장본" }),
            el("span", { class: "who", text: theirs.by || "" }),
          ]),
          el("div", { class: "ptext", text: theirs.text || "" }),
          el("div", { class: "pev", text: theirEv.join(" · ") || "근거 없음" }),
          el("button", {
            type: "button",
            class: "btn sm",
            text: "상대 것으로",
            onclick: () => {
              // 내 편집을 버리고 서버 상태를 받는다 — 다시 읽어오는 쪽이 정확하다.
              editingAddr = null;
              editBuf = null;
              reconcileFor = null;
              reload();
            },
          }),
        ]),
      ]),
      el("details", { class: "merge" }, [
        el("summary", { text: "직접 병합 — 두 해석을 사람이 읽고 하나로" }),
        mergeTA,
        el("div", {
          class: "pev",
          text: `근거(합집합): ${union.join(" · ") || "없음"}`,
        }),
        el("button", {
          type: "button",
          class: "btn primary sm",
          text: "이걸로 저장",
          onclick: () => {
            if (!mergeTA.value.trim()) {
              toast("텍스트가 비었습니다.");
              return;
            }
            resolveWith(mergeTA.value, union);
          },
        }),
      ]),
      el(
        "div",
        { class: "rcancel" },
        el("button", {
          type: "button",
          class: "btn ghost sm",
          text: "취소(내 편집 유지)",
          onclick: () => {
            reconcileFor = null;
            renderInner();
          },
        }),
      ),
    ]);
  }

  // .ps row (purpose / query note)
  function psRow(slot) {
    if (reconcileFor && reconcileFor.address === slot.address)
      return el("div", { class: "ps", "data-addr": slot.address }, [
        reconcileCard(slot.address),
      ]);
    if (editingAddr === slot.address)
      return el("div", { class: "ps editing", "data-addr": slot.address }, [
        editBlock(slot),
      ]);
    return el("div", { class: "ps", "data-addr": slot.address }, [
      tierBadge(slot.tier),
      el("div", { class: "txt2" }, [
        slotReadText(slot),
        ...evidence(slot.evidence),
      ]),
      el("span", { class: "acts" }, slotReadActions(slot)),
    ]);
  }
  // .cslot (column desc cell)
  function cslotCell(slot) {
    if (!slot)
      return el(
        "div",
        { class: "cslot" },
        el("span", { class: "dim", text: "—" }),
      );
    if (reconcileFor && reconcileFor.address === slot.address)
      return el("div", { class: "cslot", "data-addr": slot.address }, [
        reconcileCard(slot.address),
      ]);
    if (editingAddr === slot.address)
      return el("div", { class: "cslot editing", "data-addr": slot.address }, [
        editBlock(slot),
      ]);
    return el("div", { class: "cslot", "data-addr": slot.address }, [
      tierBadge(slot.tier),
      el("span", { class: "txt3" }, [
        slotReadText(slot),
        ...evidence(slot.evidence),
      ]),
      el("span", { class: "acts" }, slotReadActions(slot)),
    ]);
  }
  const slotByAddr = (addr) => slots.find((s) => s.address === addr);

  function renderInner() {
    const view = BODY_VIEWS[type] ?? (isMdType(type) ? renderVocView : null);
    const meta = docMeta(type, doc, rev, reload);
    if (view) {
      const skill = view(
        doc,
        rev,
        md,
        canEdit,
        reload,
        // 상태는 칩 하나가 겸한다(라벨 = 도착 상태의 반대편이 아니라 현재
        // 상태): approver가 클릭하면 active ↔ inactive 토글.
        canApprove && doc.status !== "archived"
          ? () => statusAction(doc.status === "active" ? "inactive" : "active")
          : null,
        // 원본 JSON 좌우 분할(승인자 전용) — db-schema 뷰와 같은 affordance.
        canApprove
          ? () => {
              jsonOpen = !jsonOpen;
              renderInner();
            }
          : null,
        jsonOpen,
        res.data.wikilinks || [],
        res.data,
      );
      skill.appendChild(linksEl);
      if (meta) {
        const chips = skill.querySelector(".sk-chips");
        if (chips) chips.after(meta);
        else skill.prepend(meta);
      }
      section.replaceChildren(
        jsonOpen
          ? el("div", { class: "doc-split open" }, [
              skill,
              jsonPane(`${type}/${id}.json`, doc, () => {
                jsonOpen = false;
                renderInner();
              }),
            ])
          : skill,
      );
      return;
    }
    const b = doc.body;
    const mdChildren = [];
    if (type === "db-schema") {
      // owner is a plain attribute — the title is the bare table name and the
      // id/filename follow it (lower(table)); owner shows as a chip beside it.
      mdChildren.push(
        el("h1", {}, [
          b.table,
          b.owner ? el("span", { class: "chip owner-chip", text: b.owner }) : null,
        ]),
      );
      mdChildren.push(psRow(slotByAddr("purpose")));
      const colRows = (b.catalog.columns || []).map((col) =>
        el("tr", {}, [
          el("td", { text: col.name }),
          el("td", { text: col.type }),
          el("td", { text: col.nullable ? "Y" : "N" }),
          el(
            "td",
            col.comment ? { text: col.comment } : { class: "dim", text: "—" },
          ),
          el("td", {}, cslotCell(slotByAddr(`columnDescs.${col.name}`))),
        ]),
      );
      // orphan (deprecated) columnDescs whose column left the catalog
      const known = new Set((b.catalog.columns || []).map((c) => c.name));
      for (const s of slots) {
        const m = s.address.match(/^columnDescs\.(.+)$/);
        if (m && !known.has(m[1])) {
          colRows.push(
            el("tr", { class: "dep-row" }, [
              el("td", { class: "strike", text: m[1] }),
              el("td", { class: "dim", text: "—" }),
              el("td", { class: "dim", text: "—" }),
              el("td", { class: "dim", text: "컬럼 소멸" }),
              el("td", {}, cslotCell(s)),
            ]),
          );
        }
      }
      mdChildren.push(
        el(
          "div",
          { class: "tbl-wrap" },
          el("table", {}, [
            el(
              "thead",
              {},
              el("tr", {}, [
                el("th", { scope: "col", text: "컬럼" }),
                el("th", { scope: "col", text: "타입" }),
                el("th", { scope: "col", text: "NULL" }),
                el("th", { scope: "col", text: "comment" }),
                el("th", { scope: "col", text: "설명" }),
              ]),
            ),
            el("tbody", {}, colRows),
          ]),
        ),
      );
      const fkTxt = (b.catalog.foreignKeys || [])
        .map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`)
        .join(" · ");
      mdChildren.push(
        el("p", {
          class: "dim",
          text: `PK: ${(b.catalog.primaryKey || []).join(", ") || "—"}${fkTxt ? " · FK: " + fkTxt : ""} · catalog fetchedAt ${b.catalog.fetchedAt} — catalog-push로만 갱신`,
        }),
      );
      if (b.queries?.length) {
        mdChildren.push(el("p", {}, el("b", { text: "대표 쿼리" })));
        b.queries.forEach((q, i) => {
          mdChildren.push(psRow(slotByAddr(`queries[${i}].note`)));
          mdChildren.push(el("pre", { text: q.sql }));
        });
      }
    } else if (type === "msg-format") {
      mdChildren.push(el("h1", { text: b.command }));
      mdChildren.push(
        el("p", {
          class: "dim",
          text:
            b.direction === "host->equipment"
              ? "Host → Equipment"
              : "Equipment → Host",
        }),
      );
      mdChildren.push(psRow(slotByAddr("purpose")));
      const fieldRows = (b.fields || []).map((f, i) =>
        el("tr", {}, [
          el("td", { text: String(f.seq) }),
          el("td", { text: f.name }),
          el("td", { text: f.type }),
          el("td", { text: f.required ? "✓" : "-" }),
          el("td", {}, cslotCell(slotByAddr(`fields[${i}].desc`))),
        ]),
      );
      mdChildren.push(
        el(
          "div",
          { class: "tbl-wrap" },
          el("table", {}, [
            el(
              "thead",
              {},
              el("tr", {}, [
                el("th", { scope: "col", text: "#" }),
                el("th", { scope: "col", text: "필드" }),
                el("th", { scope: "col", text: "타입" }),
                el("th", { scope: "col", text: "필수" }),
                el("th", { scope: "col", text: "설명" }),
              ]),
            ),
            el("tbody", {}, fieldRows),
          ]),
        ),
      );
    }
    mdChildren.push(
      el("div", {
        class: "rnote",
        text: "타입·NULL·comment는 카탈로그 팩트(검토 대상 아님, catalog-push로만 갱신) · 확정을 수정하면 추정으로 자동 강등 · 흐름: 빈칸 → [추정으로 반영/작성] → 추정 → [확정] → 확정",
      }),
    );

    const parts = [
      el("div", { class: "dochead" }, [
        el("span", { class: "id", text: id }),
        el("span", { class: "chip", text: type }),
        statusBadge(doc.status),
        el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
        el("span", { class: "brk" }),
        ...keywordChips(doc.keywords || []),
        statusSwitch(),
        // 승인자는 렌더에 안 드러나는 필드(티어드 값의 by/at/evidence, catalog
        // 팩트)까지 원본 store JSON 으로 확인할 수 있다. 데이터는 이미 응답에
        // 있으므로 버튼만 더하는 열람 affordance(승인자 전용).
        canApprove
          ? el(
              "button",
              {
                type: "button",
                class: `btn ghost sm json-view${jsonOpen ? " on" : ""}`,
                "aria-pressed": jsonOpen ? "true" : "false",
                title: "문서를 좌우로 갈라 원본 store JSON 을 함께 봅니다(승인자 전용).",
                onclick: () => {
                  jsonOpen = !jsonOpen;
                  renderInner();
                },
              },
              "JSON",
            )
          : null,
      ]),
      // Say it on the document itself. Someone reading an inactive doc is
      // deciding whether to turn it on; the badge alone does not tell them
      // what turning it on costs.
      doc.status === "inactive"
        ? el("div", { class: "offbar" }, [
            el("b", { text: "비활성 문서입니다. " }),
            el("span", {
              text: "여기서는 그대로 읽을 수 있지만 미러로 나가지 않아 세션에 주입되지 않습니다. 주입 예산은 한 턴에 문서 2개뿐이므로, 상시 주입할 가치가 있을 때만 활성으로 바꾸세요.",
            }),
          ])
        : null,
      meta,
      notice,
      // 승인자가 JSON 을 열면 문서(좌)와 원본 JSON(우)을 좌우로 가른다. 닫혀
      // 있으면 docwrap 이 그대로 한 폭을 쓴다(기존과 동일). 좁은 화면은 세로로 쌓임.
      el(
        "div",
        { class: `doc-split${jsonOpen ? " open" : ""}` },
        [
          el(
            "div",
            { class: "docwrap" },
            el("div", { class: "card" }, [
              el("div", { class: "md" }, mdChildren),
              el(
                "div",
                { class: "savebar" },
                el("span", {
                  class: "dim",
                  text: canEdit
                    ? "값을 클릭하면 바로 편집 · 슬롯이 안 겹치면 자동 재베이스"
                    : "편집·확정·폐기는 슬롯 단위",
                }),
              ),
            ]),
          ),
          jsonOpen
            ? jsonPane(`${type}/${id}.json`, doc, () => {
                jsonOpen = false;
                renderInner();
              })
            : null,
        ],
      ),
      el("div", { class: "docwrap" }, linksEl),
    ];
    // el() 의 children 루프와 달리 replaceChildren() 은 null 을 걸러내지 않고
    // 문자열 "null" 로 바꿔 텍스트 노드로 넣는다. 활성 문서(=안내바 없음)에서
    // dochead 아래에 null 이 찍히던 원인이라, 넘기기 전에 떨궈낸다.
    section.replaceChildren(...parts.filter(Boolean));
  }

  // 저장 시 그 행만 반짝여서 "어디가 저장됐는지"를 보여준다.
  function shimmer(address) {
    setTimeout(() => {
      const row = section.querySelector(`[data-addr="${CSS.escape(address)}"]`);
      if (!row) return;
      row.classList.add("shimmer");
      setTimeout(() => row.classList.remove("shimmer"), 1000);
    }, 0);
  }

  // 한 슬롯을 baseBody 위에 얹어 PUT 한다. 평범한 저장과 화해 카드의
  // 세 갈래 해결이 같은 경로를 쓴다 — base/If-Match 짝만 다르다.
  async function commitSlot(address, text, ev, baseBody, ifMatch) {
    const clientBody = structuredClone(baseBody);
    const existing = getSlot(clientBody, address) || {};
    setSlot(clientBody, address, {
      text: text.trim() || null,
      tier: existing.tier,
      evidence: ev.slice(),
    });
    const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "if-match": ifMatch },
      body: clientBody,
    });
    await handleEditResult(r, address);
  }

  async function saveEdit(address) {
    if (!editBuf) return;
    await commitSlot(address, editBuf.text, editBuf.evidence, doc.body, rev);
  }

  async function handleEditResult(r, address) {
    if (r.ok) {
      const rebased = !!r.data.rebased;
      editingAddr = null;
      editBuf = null;
      reconcileFor = null;
      // rebase 는 남의 편집이 같이 들어온 것이라 이 화면의 다른 슬롯도 낡았다
      // — 그때만 전체를 다시 읽는다. 평범한 저장은 그 슬롯만 갈아끼운다.
      if (rebased) {
        // reload()가 이 화면을 통째로 다시 만들면서 notice 노드도 갈아치우므로,
        // 이 알림은 화면 밖에 사는 toast로 띄운다.
        await reload();
        toast(
          "자동 병합됨 — 다른 사람이 다른 슬롯을 고쳐서 두 편집이 모두 남았습니다.",
        );
        return;
      }
      doc = r.data.json;
      rev = r.data.rev;
      const entry = slots.find((s) => s.address === address);
      const saved = getSlot(doc.body, address) || {};
      if (entry) {
        entry.text = saved.text ?? null;
        entry.tier = saved.tier;
        entry.evidence = saved.evidence || [];
      }
      notice.replaceChildren();
      renderInner();
      shimmer(address);
      toast(
        saved.tier === "confirmed" ? "저장됨" : "저장됨 · 추정으로 반영",
        "ok",
      );
      renderDocTree().catch(() => {}); // 사이드바 티어 집계만 뒤에서 갱신
      return;
    }
    if (r.status === 409 && r.data && r.data.error === "slot_conflict") {
      // 서버가 실어 보낸 현재 문서로 나란히 비교시킨다 — 작업을 버리지 않는다.
      reconcileFor = {
        address,
        doc: r.data.current,
        rev: r.data.currentRev,
        overlap: r.data.overlap || [address],
      };
      notice.replaceChildren();
      renderInner();
      return;
    }
    if (r.status === 409) {
      notice.replaceChildren(
        el("div", { class: "notice" }, [
          el("strong", { text: "문서가 그 사이 바뀌었습니다 " }),
          el("span", { text: "— 최신 내용을 다시 불러온 뒤 편집하세요." }),
          el("button", {
            type: "button",
            class: "btn ghost sm",
            onclick: reload,
            text: "다시 불러오기",
          }),
        ]),
      );
      return;
    }
    if (r.status === 400 && r.data && r.data.error === "edit_rejected") {
      toast(r.data.message || "저장이 거부되었습니다 (근거 필요).", "error");
      return;
    }
    toast(`저장 실패 (${r.status})`, "error");
  }

  renderInner();
}

// domain-skill: the body is the author's md, stored verbatim (user decision
// 2026-09-21) — so the view is the text and one editor for it, not a per-field
// form. The heading structure inside the text is the consumer's schema
// (## 한 줄 설명 / ## 언제 호출되는가? / ## 도메인 지식 / ## 데이터); the server
// refuses a `##` section it does not know, and the error comes back here.
// A main skill's screen always has the ## 답변 품질 검증 Set block; a skill
// without it shows the block empty, and 편집 starts from the template.
export function renderSkillView(doc, rev, md, canEdit, reload, onToggleStatus, onToggleJson, jsonOpen, wikis, data) {
  const s = doc.body;
  const main = (doc.role ?? "main") === "main";
  // A sub never has the section, so its screen leaves the block out.
  const sectionsOf = (lib) => (main ? lib.SKILL_SECTIONS : lib.SKILL_SECTIONS.filter((x) => x.key !== VERIFY_KEY));
  const url = `/api/docs/domain-skill/${encodeURIComponent(doc.id)}`;

  // One whole-body PUT (the body is the unit — no tiered slots). On success the
  // screen reloads so the next edit sees a fresh rev.
  async function commit(next) {
    const r = await api(url, {
      method: "PUT",
      headers: { "if-match": rev },
      body: next,
    });
    if (r.ok) {
      toast("저장했습니다", "");
      reload();
      return true;
    }
    if ((r.data || {}).error === "data_id_conflict") toast(dataIdConflictText(r.data), "error");
    else if (r.status === 409)
      toast("다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요.", "error");
    else if (r.status === 403) toast("admin 만 할 수 있습니다.", "error");
    else {
      const d = r.data || {};
      toast(
        `저장 실패 (${r.status})` +
          (d.message ? " — " + d.message : "") +
          (d.details ? " — " + JSON.stringify(d.details) : ""),
        "error",
      );
    }
    return false;
  }

  // The one-line summary is the first paragraph under `## 한 줄 설명` — the same
  // rule the renderer uses for the SKILL.md description.
  function summaryOf(markdown) {
    let inSummary = false;
    for (const line of String(markdown || "").split(/\r?\n/)) {
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        inSummary = h[1].length === 2 && /^한 줄 설명[?？:：\s]*$/.test(h[2].trim());
        continue;
      }
      if (inSummary && line.trim() !== "") return line.trim();
    }
    return "";
  }

  const chips = viewChips(doc, rev, onToggleStatus, onToggleJson, jsonOpen);
  chips.insertBefore(roleChip(doc, rev, canEdit, reload), chips.children[1] ?? null);
  const wrap = el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: "domain-skill · 스킬 문서(md)" }),
    el("h1", { class: "sk-title", text: s.name }),
    el("p", { class: "sk-sub", text: summaryOf(s.markdown) }),
    chips,
    inactiveBar(doc),
  ]);

  // ── 문서 ──────────────────────────────────────────────────────────────
  // Read: one block per `##` section (heading + its text as written — the
  // dashboard does not render md, the consumer does). Each block has its own
  // 편집, which turns that block alone into a textarea; 전체 md 편집 opens the
  // whole text. A md the section splitter refuses is read and edited whole.
  // Every save is one PUT of { name, markdown }, so the stored document is one
  // md as before.
  const docHolder = el("div", { class: "sk-doc" });
  const HINT =
    "절은 다섯 — ## 한 줄 설명 · ## 언제 호출되는가? · ## 도메인 지식 · ## 데이터(### id — 제목, ```sql 또는 ```ask) · ## 답변 품질 검증 Set(main 만). 모르는 ## 절은 저장이 거절됩니다.";
  const VERIFY_HINT =
    "답변 품질 검증 Set — ### 설정(- 라인 · - 설비 · - 기간: 시작 ~ 끝) · ### 일반 지식 · ### 데이터 설명 · ### 데이터 연관 · ### 고도화 분석 · ### 신뢰성. #### 하나가 질문 하나다. 일반 지식은 - 정답: ## 도메인 지식 소제목 경로 · - 채점표(선택), 데이터 설명은 ```sql 블록 하나(값이 다 들어간 SQL), 데이터 연관은 ```sql 블록 여럿 + - 채점표, 고도화 분석은 - 보류, 신뢰성은 답이 자료에 없는 질문(\"모른다\" 가 맞는 답) · - 채점표(선택).";

  let verifyTemplate = null;
  let verifyCounts = null; // {1..5: n} when the md has the section
  let verifyQuestions = []; // the section's questions, written order
  // The pieces a 정답 can name, by skill (own · link1 · link2). Own paths go in
  // bare; another skill's as <skill>/<path>.
  let answerGroups = [];
  let vlib = null; // src/verify-set.mjs once loaded
  let verifyParsed = null; // parseVerifySet of the md
  let scoreLines = null; // GET /api/score/:agent lines, oldest first; null when not loaded
  let verifyQueries = []; // GET …/verification-choices: the queries a 정답 SQL can come from
  let blib = null; // src/sql-bind.mjs once loaded
  async function read() {
    const [lib, verifyModule, scores, queries, bindModule] = await Promise.all([
      skillSectionsLib,
      verifyLib,
      main ? api(`/api/score/${encodeURIComponent(doc.id)}`) : null,
      main ? api(`${url}/verification-choices`) : null,
      sqlBindLib,
    ]);
    if (!lib) return readWhole("절 편집기를 불러오지 못해 전체 md 로 보입니다.");
    vlib = verifyModule;
    blib = bindModule;
    verifyQueries = queries?.ok ? queries.data.queries : [];
    answerGroups = (queries?.ok ? queries.data.pieces : [])
      .filter((g) => g.paths.length)
      .map((g) => ({ ...g, values: g.paths.map((p) => (g.tier === "own" ? p : `${g.skill}/${p}`)) }));
    if (vlib) {
      verifyTemplate = vlib.verifySetTemplate();
      const parsed = vlib.parseVerifySet(s.markdown || "");
      verifyParsed = parsed;
      verifyCounts = parsed.present ? vlib.countByKind(parsed.questions) : null;
      verifyQuestions = parsed.questions;
      if (!answerGroups.length) {
        const own = vlib.knowledgePaths(s.markdown || "");
        answerGroups = own.length ? [{ skill: doc.id, tier: "own", paths: own, values: own }] : [];
      }
    }
    scoreLines = scores?.ok ? scores.data.lines : null;
    showLastScore();
    try {
      readSections(lib, lib.splitSkill(s.markdown || "", sectionsOf(lib)), null);
    } catch (e) {
      if (!(e instanceof lib.SkillSplitError)) throw e;
      readWhole(`절 단위로 나눌 수 없어 전체 md 로 보입니다 — ${e.message}`);
    }
  }

  // An inline editor: 저장 · 취소 · esc · ⌘↵. `value()` is the md to save.
  function editor(input, { dirty, value }) {
    const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
    const refresh = () => {
      save.disabled = !dirty();
      save.title = dirty() ? "" : "변경 없음";
    };
    save.addEventListener("click", async () => {
      save.disabled = true;
      const ok = await commit({ ...s, markdown: value() });
      if (!ok) save.disabled = false;
    });
    const card = el("div", { class: "slot-edit" }, [
      input,
      el("div", { class: "editacts" }, [
        save,
        el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
        el("span", { class: "kbd" }, [
          el("b", { text: "esc" }),
          " 취소 · ",
          el("b", { text: "⌘/Ctrl+↵" }),
          " 저장",
        ]),
      ]),
    ]);
    input.addEventListener("input", refresh);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (dirty() && !confirm("저장하지 않은 편집이 있습니다. 버릴까요?")) return;
        read();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!save.disabled) save.click();
      }
    });
    refresh();
    return card;
  }

  // A textarea as tall as its text; dragging the corner makes it taller still.
  const fitHeight = (ta) => {
    const grow = () => {
      if (ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight + 2}px`;
    };
    queueMicrotask(grow);
    if (!ta.dataset.fit) {
      ta.dataset.fit = "1";
      ta.addEventListener("input", grow);
    }
  };

  const editBtn = (label, onclick, disabled) =>
    canEdit
      ? el("button", { type: "button", class: "btn ghost sm add-btn", text: label, disabled, onclick })
      : null;

  // `editing` = the key of the one section open in a textarea, or null. While
  // one is open every other 편집 is off — one edit at a time.
  function readSections(lib, split, editing) {
    const name = split.title ?? s.name;
    const blocks = split.sections.map((sec) => {
      const head = el("div", { class: "sk-sec-head" }, [
        el("h3", { class: "sk-sec-h mono", text: `## ${sec.heading}` }),
        editing === sec.key
          ? null
          : editBtn("편집", () => readSections(lib, split, sec.key), editing !== null),
      ]);
      if (editing === sec.key) {
        // An empty verification set opens on its template; saving it puts the section in.
        const initial = sec.key === VERIFY_KEY && sec.body === "" && verifyTemplate ? verifyTemplate : sec.body;
        const ta = el("textarea", {
          class: "fld mono sk-sec-edit",
          spellcheck: "false",
          rows: Math.max(3, initial.split("\n").length + 1),
          "aria-label": `## ${sec.heading}`,
        });
        ta.value = initial;
        fitHeight(ta);
        // 정답 paths to click in at the cursor; typing them works the same.
        const paths =
          sec.key === VERIFY_KEY
            ? pathPicker("정답 경로 넣기", (p) => {
                const at = ta.selectionStart ?? ta.value.length;
                const before = ta.value.slice(0, at);
                const line = `${before === "" || before.endsWith("\n") ? "" : "\n"}- 정답: ${p}\n`;
                ta.setRangeText(line, at, ta.selectionEnd ?? at, "end");
                ta.dispatchEvent(new Event("input", { bubbles: true }));
                ta.focus();
              })
            : null;
        queueMicrotask(() => ta.focus());
        return el("div", { class: "sk-sec editing sk-wide" }, [
          head,
          paths,
          editor(ta, {
            dirty: () => ta.value !== sec.body,
            // Unchanged gives back the md as it was (any section order).
            value: () =>
              ta.value === sec.body
                ? s.markdown || ""
                : lib.joinSkill(
                    name,
                    split.sections.map((x) => (x.key === sec.key ? { ...x, body: ta.value } : x)),
                    sectionsOf(lib),
                  ),
          }),
        ]);
      }
      // The verification set is edited question by question; a section the
      // reader refuses (a draft) falls back to the section textarea above.
      if (sec.key === VERIFY_KEY && vlib && verifyParsed && verifyParsed.errors.length === 0)
        return verifyBlock(lib, split, editing, sec);
      return el("div", { class: "sk-sec" }, [
        head,
        sec.body.trim() === ""
          ? el("p", { class: "dim", text: "비어 있습니다" })
          : wikiText(el("pre", { class: "sk-md" }), sec.body, wikis),
        ...(sec.key === VERIFY_KEY ? verifyExtras() : []),
      ]);
    });
    docHolder.replaceChildren(
      el("h2", { class: "sk-h" }, ["문서", editBtn("전체 md 편집", editWhole, editing !== null)]),
      el("p", { class: "sk-sec-title mono", text: `# ${name}` }),
      ...blocks,
      el("p", { class: "dim", text: HINT }),
    );
  }

  // The pieces a 정답 can name, one row per skill: own first, then the linked skills.
  const TIER_LABEL = { own: "이 스킬", link1: "연결 1단", link2: "연결 2단" };
  function pathPicker(label, onPick) {
    if (!answerGroups.length) return null;
    return el("div", { class: "verify-paths-groups" }, answerGroups.map((g) =>
      el("div", { class: "verify-paths" }, [
        el("span", { class: "dim", text: `${label} · ${TIER_LABEL[g.tier]}${g.tier === "own" ? "" : ` ${g.skill}`} — ` }),
        ...g.values.map((v, i) =>
          el("button", { type: "button", class: "chip verify-path", text: g.paths[i], title: `- 정답: ${v}`, onclick: () => onPick(v) })),
      ]),
    ));
  }

  // Under the verification block: questions per kind, the server's warnings, the rules.
  function verifyExtras() {
    const out = [];
    if (verifyCounts)
      out.push(
        el("div", { class: "verify-counts" }, [1, 2, 3, 4, 5].map((k) =>
          el("span", { class: `chip${verifyCounts[k] ? "" : " none"}`, text: `${VERIFY_KIND_LABEL[k]} ${verifyCounts[k]}` }),
        )),
      );
    const warnings = data?.warnings || [];
    if (warnings.length)
      out.push(
        el("div", { class: "verify-warn" }, [
          el("b", { text: `경고 ${warnings.length}` }),
          el("ul", {}, warnings.map((w) => el("li", { text: w }))),
        ]),
      );
    if (scoreLines?.length) out.push(verifyHistory());
    out.push(el("p", { class: "dim", text: VERIFY_HINT }));
    return out;
  }

  const questionKey = (kind, text) => `${kind}\n${text}`;
  // The last machine and human line of each question, by kind + text.
  function lastLines() {
    const machine = new Map();
    const human = new Map();
    for (const l of scoreLines || []) {
      const key = questionKey(l.kind, l.text);
      if (l.machine) machine.set(key, l);
      if (l.human) human.set(key, l);
    }
    return { machine, human };
  }

  // The agent's last Score, next to the role chip.
  const scoreChip = el("span", { class: "chip verify-score none", text: "Score 기록 없음" });
  if (main) chips.appendChild(scoreChip);
  function showLastScore() {
    const last = [...(scoreLines || [])].reverse().find((l) => l.machine && l.run);
    if (!last) return;
    scoreChip.className = `chip verify-score ${bandClass(last.run.score)}`;
    scoreChip.textContent = `Score ${last.run.score}${last.run.band ? ` · ${last.run.band}` : ""} · ${shortAt(last.at)}`;
    const r2 = (x, d = 2) => (typeof x === "number" ? x.toFixed(d) : "—");
    scoreChip.title = `G ${last.run.G ?? "—"} · A ${last.run.A} · R ${last.run.R ?? "—"}`
      + ` · 문 앞 S ${r2(last.run.raw, 1)} · 사람 점수 비율 h ${r2(last.run.humanRatio)} · σ̃(h) ${r2(last.run.gate)} · ${last.model}`;
  }

  // The person's 0~100 score for one question: "80 / 100 · who · when", or a
  // "사람 점수 적기" link that opens the input · 저장 · 취소 in place.
  function humanScore(q, h) {
    const wire = VERIFY_KIND_WIRE[q.kind];
    const box = el("div", { class: "verify-human" });
    const shown = () => {
      const parts = h
        ? [
            el("span", { class: "dim", text: "사람 " }),
            el("b", { text: `${h.human.score} / 100` }),
            el("span", { class: "dim", text: ` · ${h.human.by} · ${shortAt(h.human.at)}` }),
          ]
        : canEdit ? [] : [el("span", { class: "dim", text: "사람 점수 —" })];
      if (canEdit)
        parts.push(el("button", { type: "button", class: "linkbtn", text: h ? "고치기" : "사람 점수 적기 (100점 만점)", onclick: form }));
      box.replaceChildren(...parts);
    };
    const form = () => {
      const input = el("input", { type: "number", min: "0", max: "100", step: "1", class: "fld verify-human-in", "aria-label": `${q.text} 사람 점수` });
      if (h) input.value = String(h.human.score);
      const save = el("button", {
        type: "button",
        class: "btn primary sm",
        text: "저장",
        onclick: async () => {
          const score = Number(input.value);
          if (input.value === "" || !Number.isInteger(score) || score < 0 || score > 100) {
            toast("사람 점수는 0~100 정수입니다", "error");
            return;
          }
          save.disabled = true;
          const r = await api(`/api/score/${encodeURIComponent(doc.id)}`, {
            method: "POST",
            body: { lines: [{ kind: wire, text: q.text, human: { score } }] },
          });
          if (r.ok) {
            toast("사람 점수를 남겼습니다", "ok");
            reload();
            return;
          }
          save.disabled = false;
          toast(`남기지 못했습니다 (${r.status})`, "error");
        },
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") save.click();
        if (e.key === "Escape") shown();
      });
      box.replaceChildren(
        el("span", { class: "dim", text: "사람 점수 " }), input, el("span", { class: "dim", text: "/ 100" }), save,
        el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: shown }),
      );
      input.focus();
    };
    shown();
    return box;
  }

  // The last machine verdict as a pill: ✓ 맞음 · ✗ 틀림 + 이유, and when.
  function verdictPill(m) {
    if (!m) return el("span", { class: "verify-pill none", text: "판정 없음" });
    return el("span", { class: "verify-verdict" }, [
      el("span", { class: `verify-pill ${m.machine.ok ? "ok" : "no"}`, text: m.machine.ok ? "✓ 맞음" : `✗ 틀림${m.machine.reason ? ` · ${m.machine.reason}` : ""}` }),
      el("span", { class: "dim", text: shortAt(m.at) }),
    ]);
  }

  // ── 답변 품질 검증 Set: 설정 카드 + 종류 다섯 묶음, 질문 하나 = 카드 ──
  // A card edits one question; 저장 rebuilds the section md (verifySetBody)
  // and saves the document the way a section edit does. `editing` is
  // "verify:settings", "verify:q<index>" or "verify:new<kind>" while a card is open.
  function verifyBlock(lib, split, editing, sec) {
    const set = { settings: verifyParsed.settings, questions: verifyParsed.questions };
    const busy = editing !== null;
    const open = (key) => readSections(lib, split, `verify:${key}`);
    const close = () => readSections(lib, split, null);

    // The one write path scripts use too: PUT …/verification-set with the contract object.
    async function saveSet(next, errBox, button) {
      button.disabled = true;
      const r = await api(`${url}/verification-set`, {
        method: "PUT",
        headers: { "if-match": rev },
        body: {
          ...(next.settings && Object.keys(next.settings).length ? { settings: next.settings } : {}),
          questions: next.questions.map(vlib.toContractQuestion),
        },
      });
      if (r.ok) {
        toast("저장했습니다", "");
        reload();
        return;
      }
      button.disabled = false;
      const d = r.data || {};
      showErrors(errBox, r.status === 409 ? ["다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요."]
        : d.details || [d.message || `저장 실패 (${r.status})`]);
    }
    function showErrors(box, list) {
      box.replaceChildren(el("ul", {}, list.map((e) => el("li", { text: e.replace(/^\$\.body\.markdown: /, "") }))));
      box.hidden = false;
    }
    const cardActs = (save, cancel) =>
      el("div", { class: "verify-acts" }, [
        el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: cancel }),
        el("button", { type: "button", class: "btn primary sm", text: "저장", onclick: save }),
      ]);
    const field = (label, control) => el("label", { class: "verify-field" }, [el("span", { class: "verify-label", text: label }), control]);
    const input = (value, placeholder) => {
      const i = el("input", { type: "text", class: "fld", placeholder: placeholder || "" });
      i.value = value ?? "";
      return i;
    };
    const area = (value, cls) => {
      const t = el("textarea", { class: `fld ${cls || ""}`, spellcheck: "false", rows: 2 });
      t.value = value ?? "";
      queueMicrotask(() => fitHeight(t));
      t.addEventListener("input", () => fitHeight(t));
      return t;
    };

    // 설정 — 라인 · 설비 · 기간
    function settingsCard() {
      const st = set.settings || {};
      if (editing === "verify:settings") {
        const line = input(st.line, "L1");
        const eqp = input(st.eqp, "EQP01");
        const start = input(st.duration?.start, "2026-10-01T00:00");
        const end = input(st.duration?.end, "2026-10-01T06:00");
        const errBox = el("div", { class: "verify-errors", hidden: true });
        return el("div", { class: "verify-card editing sk-wide" }, [
          el("b", { text: "설정" }),
          el("div", { class: "verify-fields" }, [field("라인", line), field("설비", eqp), field("기간 시작", start), field("기간 끝", end)]),
          errBox,
          cardActs((e) => {
            const v = (x) => x.value.trim();
            if ((v(start) === "") !== (v(end) === "")) return showErrors(errBox, ["기간은 시작과 끝을 같이 적습니다"]);
            const settings = {
              ...(v(line) ? { line: v(line) } : {}),
              ...(v(eqp) ? { eqp: v(eqp) } : {}),
              ...(v(start) ? { duration: { start: v(start), end: v(end) } } : {}),
            };
            saveSet({ ...set, settings }, errBox, e.currentTarget);
          }, close),
        ]);
      }
      const dur = st.duration ? `${st.duration.start.replace("T", " ")} ~ ${st.duration.end.replace("T", " ")}` : null;
      const cell = (k, v) => el("div", { class: "verify-cell" }, [
        el("span", { class: "verify-label", text: k }),
        el("span", { class: `verify-cell-v${v ? " mono" : " dim"}`, text: v || "—" }),
      ]);
      return el("div", { class: "verify-card" }, [
        el("div", { class: "verify-card-head" }, [
          el("b", { class: "verify-q", text: "설정" }),
          editBtn("편집", () => open("settings"), busy),
        ]),
        el("div", { class: "verify-settings" }, [cell("라인", st.line), cell("설비", st.eqp), cell("기간", dur)]),
      ]);
    }

    // 질문 카드 — 읽기
    function readCard(q, index, last) {
      const answerParts = [];
      if (q.path) answerParts.push(el("div", { class: "verify-answer" }, [el("span", { class: "verify-label", text: "정답" }), el("span", { class: "chip verify-path-chip", text: q.path })]));
      for (const sql of q.sqls) answerParts.push(el("pre", { class: "verify-sql", text: sql }));
      if (q.rubric) answerParts.push(el("div", { class: "verify-answer" }, [el("span", { class: "verify-label", text: "채점표" }), el("span", { text: q.rubric })]));
      if (q.deferred) answerParts.push(el("div", {}, el("span", { class: "chip", text: "보류 — 판정 없이 수만 셉니다" })));
      if (q.kind === 5) answerParts.push(el("div", { class: "dim", text: "답이 자료에 없는 질문 — \"모른다\" 가 맞는 답" }));
      const m = last.machine.get(questionKey(VERIFY_KIND_WIRE[q.kind], q.text));
      return el("div", { class: "verify-card" }, [
        el("div", { class: "verify-card-head" }, [
          el("b", { class: "verify-q", text: q.text }),
          editBtn("편집", () => open(`q${index}`), busy),
          canEdit
            ? el("button", {
                type: "button",
                class: "btn ghost sm add-btn",
                text: "삭제",
                disabled: busy,
                onclick: (e) => {
                  if (!confirm(`"${q.text}" 질문을 지울까요?`)) return;
                  const errBox = e.currentTarget.closest(".verify-card").querySelector(".verify-errors");
                  saveSet({ ...set, questions: set.questions.filter((_, i) => i !== index) }, errBox, e.currentTarget);
                },
              })
            : null,
        ]),
        ...answerParts,
        el("div", { class: "verify-foot" }, [
          verdictPill(m),
          humanScore(q, last.human.get(questionKey(VERIFY_KIND_WIRE[q.kind], q.text))),
        ]),
        el("div", { class: "verify-errors", hidden: true }),
      ]);
    }

    // 조회 고르기 — 고른 조회의 SQL 틀과 입력 칸. 값을 치면 `target` 에 묶은 SQL 을 채운다.
    // `shared` 는 한 카드 안 SQL 줄들이 같이 쓰는 ASK 값(이름 → 값)이다.
    function sqlPicker(target, shared) {
      if (!hasPicker) return null;
      const st = set.settings || {};
      const pick = el("select", { class: "fld verify-pick", "aria-label": "조회 고르기" }, [
        el("option", { value: "", text: "조회 고르기 — 고르면 SQL 틀과 입력 칸이 나옵니다" }),
        ...verifyQueries.map((qq, i) =>
          el("option", { value: String(i), text: `${qq.id}${qq.title ? ` — ${qq.title}` : ""}${qq.skill === doc.id ? "" : ` (${qq.skill})`}` }),
        ),
      ]);
      const body = el("div", { class: "verify-pick-body", hidden: true });
      const fill = (query, inputs) => {
        const binds = {};
        for (const [name, i] of inputs) if (i.value.trim() !== "") binds[name] = i.value;
        const { sql, missing } = blib.bindSql(query.sql, binds);
        target.value = sql;
        fitHeight(target);
        status.textContent = missing.length ? `값이 빈 칸: ${missing.map((m) => `:${m}`).join(" · ")}` : "SQL 을 채웠습니다 — 아래 칸에서 더 고칠 수 있습니다";
        status.className = missing.length ? "verify-pick-status missing" : "verify-pick-status dim";
      };
      const status = el("div", { class: "verify-pick-status dim" });
      pick.addEventListener("change", () => {
        const query = verifyQueries[Number(pick.value)];
        if (pick.value === "" || !query) {
          body.hidden = true;
          body.replaceChildren();
          return;
        }
        const inputs = [];
        const fields = query.binds.map((b) => {
          const prefill = b.from === "eqp" ? st.eqp : b.from === "start" ? st.duration?.start : b.from === "end" ? st.duration?.end : shared[b.name];
          const i = input(prefill, b.example ? `예: ${b.example}` : b.from === "start" || b.from === "end" ? "2026-10-01T00:00" : "");
          i.addEventListener("input", () => {
            if (b.from === "ask") shared[b.name] = i.value;
            fill(query, inputs);
          });
          inputs.push([b.name, i]);
          const label = b.from === "eqp" ? "설비" : b.from === "start" ? "기간 시작" : b.from === "end" ? "기간 끝" : b.title || b.name;
          return el("label", { class: "verify-field" }, [
            el("span", { class: "verify-label" }, [`${label} `, el("code", { text: `:${b.name}` })]),
            i,
            b.from === "ask" && b.question ? el("span", { class: "dim verify-pick-q", text: b.question }) : null,
          ]);
        });
        body.replaceChildren(
          el("div", { class: "verify-step" }, [el("b", { text: "① SQL 틀" }), el("span", { class: "dim", text: ` · ${query.skill}${st.line ? ` · 라인 ${st.line} 에서 돌립니다` : ""}` })]),
          el("pre", { class: "verify-sql", text: query.sql }),
          el("div", { class: "verify-step" }, [el("b", { text: "② 값" }), el("span", { class: "dim", text: " · 설비 · 기간은 설정에서 채웁니다" })]),
          fields.length ? el("div", { class: "verify-fields" }, fields) : el("div", { class: "dim", text: "이 조회는 입력이 없습니다" }),
          status,
        );
        body.hidden = false;
        fill(query, inputs);
        (inputs.find(([, i]) => i.value === "")?.[1] ?? inputs[0]?.[1])?.focus();
      });
      return el("div", { class: "verify-pick-wrap" }, [
        el("label", { class: "verify-field" }, [el("span", { class: "verify-label", text: "조회 고르기 — 고른 조회의 틀에 값을 묶어 정답 SQL 을 채웁니다" }), pick]),
        body,
      ]);
    }
    const hasPicker = !!blib && verifyQueries.length > 0;
    const sqlLabel = (text) => (hasPicker ? `③ ${text}` : text);
    // 정답 SQL 에 묶이지 않은 :바인드가 남았으면 그 이름들.
    const unbound = (sqls) => (blib ? [...new Set(sqls.flatMap((x) => blib.varsOf(x)))] : []);

    // 질문 카드 — 편집. `index` null 이면 새 질문(묶음 끝에 붙는다).
    function editCard(q, index) {
      const text = input(q.text, "질문 문장");
      const errBox = el("div", { class: "verify-errors", hidden: true });
      const parts = [field("질문", text)];
      let collect = () => ({});
      const shared = {};
      if (q.kind === 1) {
        const path = input(q.path, "소제목 경로 — 다른 스킬 조각은 <스킬>/<소제목 경로>");
        const rubric = area(q.rubric);
        parts.push(field("정답 경로", path));
        parts.push(pathPicker("경로 고르기", (p) => { path.value = p; path.focus(); }));
        parts.push(field("채점표(선택)", rubric));
        collect = () => ({ path: path.value.trim() || null, rubric: rubric.value.trim() || null });
      } else if (q.kind === 2) {
        const sql = area(q.sqls[0], "verify-sql-edit");
        parts.push(sqlPicker(sql, shared), field(sqlLabel("정답 SQL — 값이 다 들어간 문장"), sql));
        collect = () => ({ sqls: sql.value.trim() ? [sql.value.trim()] : [] });
      } else if (q.kind === 3) {
        const list = el("div", { class: "verify-sql-list" });
        const rows = [];
        const renumber = () => list.querySelectorAll(".verify-sql-no").forEach((n, i) => { n.textContent = `SQL ${i + 1}`; });
        const addRow = (value) => {
          const t = area(value, "verify-sql-edit");
          const row = el("div", { class: "verify-sql-item" }, [
            el("div", { class: "verify-sql-head" }, [
              el("b", { class: "verify-sql-no" }),
              el("button", {
                type: "button",
                class: "iconbtn",
                text: "✕",
                title: "이 SQL 줄 삭제",
                "aria-label": "이 SQL 줄 삭제",
                onclick: () => { rows.splice(rows.indexOf(t), 1); row.remove(); renumber(); },
              }),
            ]),
            sqlPicker(t, shared),
            field(sqlLabel("정답 SQL"), t),
          ]);
          rows.push(t);
          list.appendChild(row);
          renumber();
        };
        (q.sqls.length ? q.sqls : [""]).forEach(addRow);
        const rubric = area(q.rubric);
        parts.push(
          el("div", { class: "verify-field" }, [el("span", { class: "verify-label", text: "정답 SQL — 하나 이상" }), list]),
          el("div", {}, el("button", { type: "button", class: "btn ghost sm", text: "+ SQL 추가", onclick: () => addRow("") })),
        );
        parts.push(field("채점표", rubric));
        collect = () => ({ sqls: rows.map((t) => t.value.trim()).filter(Boolean), rubric: rubric.value.trim() || null });
      } else if (q.kind === 4) {
        parts.push(el("span", { class: "chip", text: "보류 — 판정 없이 수만 셉니다" }));
        collect = () => ({ deferred: true });
      } else {
        parts.push(el("span", { class: "dim", text: "답이 자료에 없는 질문 — 에이전트가 \"모른다\" 로 답해야 맞습니다" }));
      }
      queueMicrotask(() => text.focus());
      const save = (e) => {
        const t = text.value.trim();
        if (!t) return showErrors(errBox, ["질문 문장이 비었습니다"]);
        const edited = { ...q, text: t, ...collect() };
        const left = unbound(edited.sqls || []);
        if (left.length) return showErrors(errBox, [`정답 SQL 에 값이 빈 바인드가 있습니다: ${left.map((m) => `:${m}`).join(" · ")}`]);
        const questions = index === null
          ? [...set.questions, edited]
          : set.questions.map((x, i) => (i === index ? edited : x));
        saveSet({ ...set, questions }, errBox, e.currentTarget);
      };
      const card = el("div", { class: "verify-card editing sk-wide" }, [
        el("b", { text: index === null ? `새 질문 · ${VERIFY_KIND_LABEL[q.kind]}` : `질문 고치기 · ${VERIFY_KIND_LABEL[q.kind]}` }),
        ...parts, errBox, cardActs(save, close),
      ]);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      });
      return card;
    }

    const last = lastLines();
    const groups = [1, 2, 3, 4, 5].map((kind) => {
      const mine = set.questions.map((q, i) => [q, i]).filter(([q]) => q.kind === kind);
      const cards = mine.map(([q, i]) => (editing === `verify:q${i}` ? editCard(q, i) : readCard(q, i, last)));
      if (editing === `verify:new${kind}`)
        cards.push(editCard({ kind, text: "", path: null, sqls: [], rubric: null, deferred: kind === 4 }, null));
      return el("div", { class: "verify-group" }, [
        el("div", { class: "verify-group-head" }, [
          el("h4", { text: VERIFY_KIND_LABEL[kind] }),
          el("span", { class: `verify-count${mine.length ? "" : " none"}`, text: String(mine.length) }),
          canEdit ? el("button", { type: "button", class: "btn ghost sm verify-add", text: "+ 질문 추가", disabled: busy, onclick: () => open(`new${kind}`) }) : null,
        ]),
        ...cards,
      ]);
    });
    return el("div", { class: "sk-sec verify-set" }, [
      el("div", { class: "sk-sec-head" }, [el("h3", { class: "sk-sec-h mono", text: `## ${sec.heading}` })]),
      sec.body.trim() === "" ? el("p", { class: "dim", text: "아직 질문이 없습니다 — 설정을 적고 묶음마다 [질문 추가] 로 넣으세요." }) : null,
      settingsCard(),
      ...groups,
      ...verifyExtras(),
    ]);
  }

  // Every record line, newest first.
  function verifyHistory() {
    const lines = [...scoreLines].reverse();
    return el("details", { class: "verify-history" }, [
      el("summary", { text: `기록 ${lines.length}줄` }),
      el("table", { class: "verify-history-tbl" }, [
        el("colgroup", {}, ["c-at", "c-kind", "c-q", "c-machine", "c-human"].map((c) => el("col", { class: c }))),
        el("thead", {}, el("tr", {}, ["시각", "종류", "질문", "기계", "사람(100점 만점)"].map((t) => el("th", { text: t })))),
        el("tbody", {}, lines.map((l) =>
          el("tr", {}, [
            el("td", { class: "mono", text: shortAt(l.at) }),
            el("td", { class: "dim", text: VERIFY_LABEL_OF_WIRE[l.kind] ?? l.kind }),
            el("td", { text: l.text }),
            el("td", { text: l.machine ? `${l.machine.ok ? "✓" : "✗"}${l.machine.reason ? ` ${l.machine.reason}` : ""} · Score ${l.run?.score ?? "—"}` : "" }),
            el("td", { text: l.human ? `${l.human.score} / 100 · ${l.human.by}` : "" }),
          ]),
        )),
      ]),
    ]);
  }

  function readWhole(note) {
    docHolder.replaceChildren(
      el("h2", { class: "sk-h" }, ["문서", editBtn("편집", editWhole, false)]),
      note ? el("p", { class: "dim", text: note }) : null,
      (s.markdown || "").trim() === ""
        ? el("p", { class: "dim", text: "아직 본문이 없습니다 — 편집을 눌러 스킬 md 를 붙여 넣으세요." })
        : wikiText(el("pre", { class: "sk-md" }), s.markdown, wikis),
      el("p", { class: "dim", text: HINT }),
    );
  }

  function editWhole() {
    const input = el("textarea", { class: "fld mono sk-md-edit", spellcheck: "false" });
    input.value = s.markdown || "";
    fitHeight(input);
    docHolder.replaceChildren(
      el("h2", { class: "sk-h" }, ["문서 편집 · 전체 md"]),
      el("div", { class: "sk-wide" }, editor(input, { dirty: () => input.value !== (s.markdown || ""), value: () => input.value })),
    );
    input.focus();
  }
  read();
  wrap.appendChild(docHolder);

  // 설치 — 다운로드와 놓을 위치를 한 카드에. Claude Code와 opencode 모두
  // ~/.claude/skills/<name>/ 를 읽으므로 경로 하나로 끝난다 (install-skills.mjs).
  // 다운로드는 클라이언트 blob(downloadTextFile) — 이미 로드된 md를 재사용한다.
  if (md) {
    const installCmd =
      `mkdir -p ~/.claude/skills/${s.name}\n` +
      `mv ~/Downloads/SKILL.md ~/.claude/skills/${s.name}/SKILL.md`;
    wrap.appendChild(
      el("div", { class: "sk-install" }, [
        el("div", { class: "sk-install-top" }, [
          el("h2", { class: "sk-h", text: "설치" }),
          el("button", {
            type: "button",
            class: "btn primary sm dl-btn",
            onclick: () => {
              downloadTextFile("SKILL.md", md, "text/markdown;charset=utf-8");
              toast("SKILL.md 다운로드 — 아래 위치에 넣으세요", "");
            },
            text: "↓ SKILL.md 다운로드",
          }),
        ]),
        el("p", { class: "dim install-lead" }, [
          "받은 ",
          el("code", { text: "SKILL.md" }),
          " 를 아래 위치에 넣으면 끝 — Claude Code·opencode 모두 이 경로를 읽습니다. 내려받는 파일은 이 문서 앞에 frontmatter(name·description)만 붙인 것입니다.",
        ]),
        el("div", { class: "install-cmd-wrap" }, [
          el("pre", { class: "install-cmd", text: installCmd }),
          el("button", {
            type: "button",
            class: "btn ghost sm copy-btn",
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(installCmd);
                toast("복사했습니다", "");
              } catch {
                toast("복사 실패 — 명령을 직접 선택해 복사하세요", "error");
              }
            },
            text: "복사",
          }),
        ]),
        el("p", {
          class: "dim",
          text: "설치 후 새 세션(또는 스킬 새로고침)부터 이 스킬을 쓸 수 있습니다.",
        }),
      ]),
    );
  }

  return wrap;
}

// voc: one md note, read whole and edited whole (no section structure). Its
// [[ ]] are drawn as links like a skill's; 저장 = one PUT of { name, markdown }.
// Every md type's doc screen (voc, unclassified, a registered type).
export function renderVocView(doc, rev, md, canEdit, reload, onToggleStatus, onToggleJson, jsonOpen, wikis) {
  const b = doc.body;
  const type = doc.schema.split("/")[0];
  const holder = el("div", { class: "sk-doc" });
  function read() {
    holder.replaceChildren(
      el("h2", { class: "sk-h" }, [
        "문서",
        canEdit
          ? el("button", { type: "button", class: "btn ghost sm add-btn", onclick: edit, text: "편집" })
          : null,
      ]),
      (b.markdown || "").trim() === ""
        ? el("p", { class: "dim", text: "아직 본문이 없습니다 — 편집을 눌러 md 를 붙여 넣으세요." })
        : wikiText(el("pre", { class: "sk-md" }), b.markdown, wikis),
    );
  }
  function edit() {
    const input = el("textarea", { class: "fld mono sk-md-edit", spellcheck: "false" });
    input.value = b.markdown || "";
    const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
    const dirty = () => input.value !== (b.markdown || "");
    const refresh = () => {
      save.disabled = !dirty();
      save.title = dirty() ? "" : "변경 없음";
    };
    save.addEventListener("click", async () => {
      save.disabled = true;
      const r = await api(`/api/docs/${type}/${encodeURIComponent(doc.id)}`, {
        method: "PUT",
        headers: { "if-match": rev },
        body: { ...b, markdown: input.value },
      });
      if (r.ok) {
        toast("저장했습니다", "ok");
        reload();
        return;
      }
      save.disabled = false;
      const d = r.data || {};
      toast(
        r.status === 409
          ? "다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요."
          : `저장 실패 (${r.status})${d.message ? " — " + d.message : ""}${d.details ? " — " + d.details.join(" · ") : ""}`,
        "error",
      );
    });
    input.addEventListener("input", refresh);
    const card = el("div", { class: "slot-edit" }, [
      input,
      el("div", { class: "editacts" }, [
        save,
        el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
        el("span", { class: "kbd" }, [el("b", { text: "esc" }), " 취소 · ", el("b", { text: "⌘/Ctrl+↵" }), " 저장"]),
      ]),
    ]);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (dirty() && !confirm("저장하지 않은 편집이 있습니다. 버릴까요?")) return;
        read();
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        if (!save.disabled) save.click();
      }
    });
    holder.replaceChildren(el("h2", { class: "sk-h" }, ["문서 편집"]), card);
    refresh();
    input.focus();
  }
  read();
  return el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: `${type} · ${TYPE_LABEL[type] ?? type}(md)` }),
    el("h1", { class: "sk-title", text: b.name }),
    viewChips(doc, rev, onToggleStatus, onToggleJson, jsonOpen),
    inactiveBar(doc),
    holder,
  ]);
}

// screen-map: one screen of the capture classifier's closed list. Read-only
// here — what it adds to this dashboard is being a link target (a manual's
// rel:"screen").
export function renderScreenMapView(doc, rev, md, canEdit, reload, onToggleStatus, onToggleJson, jsonOpen) {
  const b = doc.body;
  const cols = b.expectedColumns || {};
  const listOrNone = (items) =>
    items && items.length
      ? el("ul", { class: "sm-list" }, items.map((t) => el("li", { text: t })))
      : el("p", { class: "dim", text: "없음" });
  return el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: "screen-map · 화면" }),
    el("h1", { class: "sk-title", text: b.name }),
    el("p", { class: "sk-sub", text: [b.program, ...(b.menuPath || [])].filter(Boolean).join(" › ") }),
    viewChips(doc, rev, onToggleStatus, onToggleJson, jsonOpen),
    inactiveBar(doc),
    el("h2", { class: "sk-h", text: "보이는 모습" }),
    listOrNone(b.hints),
    el("h2", { class: "sk-h", text: "표에 있어야 할 컬럼" }),
    el("p", { class: "dim", text: `필수 ${(cols.required || []).join(" · ") || "없음"} / 선택 ${(cols.optional || []).join(" · ") || "없음"}` }),
  ]);
}

// manual: steps on one screen, each a line of text and a capture. The screen
// is the envelope's rel:"screen" link (edited in 연결 below); the captures sit
// in the asset store under their sha256, uploaded one row at a time.
export const CAPTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const CAPTURE_LIMIT = 2 * 1024 * 1024;

export function captureImg(step, cls) {
  return el("img", {
    class: cls,
    src: `/api/assets/${step.asset}`,
    width: step.width,
    height: step.height,
    alt: step.text || "캡처",
    loading: "lazy",
    // A capture the store lacks (an inactive manual may name one) shows as
    // a labelled gap instead of the browser's broken-image icon.
    onerror: (e) =>
      e.currentTarget.replaceWith(
        el("p", { class: "mn-nocap dim", text: `캡처를 불러오지 못했습니다 (${step.asset.slice(0, 8)})` }),
      ),
  });
}

export async function uploadCapture(file) {
  if (!CAPTURE_TYPES.includes(file.type))
    return { error: "PNG · JPEG · WebP 이미지만 올릴 수 있습니다." };
  if (file.size > CAPTURE_LIMIT) return { error: "캡처는 2MB 까지 올릴 수 있습니다." };
  const r = await api("/api/assets", {
    method: "POST",
    headers: { "content-type": file.type },
    raw: file,
  });
  if (r.ok) return { step: { asset: r.data.sha256, width: r.data.width, height: r.data.height } };
  if (r.status === 403) return { error: "admin 만 할 수 있습니다." };
  if (r.status === 413) return { error: "캡처는 2MB 까지 올릴 수 있습니다." };
  if (r.status === 400 || r.status === 415)
    return { error: "이미지를 읽지 못했습니다 — PNG · JPEG · WebP 인지 확인하세요." };
  return { error: `올리기 실패 (${r.status || "네트워크"})` };
}

export function renderManualView(doc, rev, md, canEdit, reload, onToggleStatus, onToggleJson, jsonOpen, wikis) {
  const b = doc.body;
  const steps = b.steps || [];
  const screen = (doc.links || []).find((l) => l.rel === "screen");

  const wrap = el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: "manual · 화면 매뉴얼" }),
    el("h1", { class: "sk-title", text: b.title || "(제목 없음)" }),
    screen
      ? el("p", { class: "sk-sub" }, [
          "화면 ",
          el("a", { href: `#/doc/${screen.type}/${encodeURIComponent(screen.id)}`, text: screen.id }),
        ])
      : el("p", {
          class: "sk-sub warn",
          text: "화면 연결이 없습니다 — 아래 연결에서 관계 screen 으로 screen-map 문서를 고르세요. 활성화하려면 꼭 하나 있어야 합니다.",
        }),
    viewChips(doc, rev, onToggleStatus, onToggleJson, jsonOpen),
    inactiveBar(doc),
  ]);

  const holder = el("div", {});
  function read() {
    const h = el("h2", { class: "sk-h" }, [`단계 ${steps.length}`]);
    if (canEdit)
      h.appendChild(
        el("button", { type: "button", class: "btn ghost sm add-btn", onclick: edit, text: "편집" }),
      );
    holder.replaceChildren(
      h,
      steps.length
        ? el(
            "ol",
            { class: "mn-steps" },
            steps.map((s, i) =>
              el("li", { class: "mn-step" }, [
                el("p", { class: "mn-text" }, [
                  el("b", { class: "mono", text: `${i + 1}.` }),
                  " ",
                  wikiText(el("span"), s.text || "", wikis),
                ]),
                s.asset
                  ? captureImg(s, "mn-cap")
                  : el("p", { class: "mn-nocap dim", text: "캡처 없음" }),
              ]),
            ),
          )
        : el("p", { class: "dim", text: "아직 단계가 없습니다 — 편집을 눌러 단계와 캡처를 넣으세요." }),
    );
  }

  function edit() {
    const draft = {
      title: b.title || "",
      steps: steps.map((s) => ({ ...s })),
    };
    const titleInp = el("input", { class: "fld", type: "text", "aria-label": "제목", placeholder: "제목 (예: SPC 관리 한계 설정)" });
    titleInp.value = draft.title;
    titleInp.addEventListener("input", () => (draft.title = titleInp.value));
    const rowsEl = el("div", { class: "mn-rows" });

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= draft.steps.length) return;
      [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]];
      paint();
    }
    function row(s, i) {
      const text = el("textarea", { class: "fld", rows: 2, "aria-label": `${i + 1}단계 설명`, placeholder: "한 동작을 한 줄로 (예: 상단 메뉴 [설정]을 누른다.)" });
      text.value = s.text || "";
      text.addEventListener("input", () => (s.text = text.value));
      const file = el("input", { type: "file", accept: CAPTURE_TYPES.join(","), hidden: true });
      const upBtn = el("button", {
        type: "button",
        class: "btn ghost sm",
        text: s.asset ? "캡처 바꾸기" : "캡처 올리기",
        onclick: () => file.click(),
      });
      file.addEventListener("change", async () => {
        const f = file.files[0];
        if (!f) return;
        upBtn.disabled = true;
        upBtn.textContent = "올리는 중…";
        const res = await uploadCapture(f);
        if (res.error) toast(res.error, "error");
        else Object.assign(s, res.step);
        paint();
      });
      return el("div", { class: "mn-row" }, [
        el("b", { class: "mono mn-n", text: `${i + 1}` }),
        el("div", { class: "mn-row-main" }, [
          text,
          el("div", { class: "mn-row-cap" }, [
            s.asset ? captureImg(s, "mn-thumb") : el("span", { class: "dim", text: "캡처 없음" }),
            s.asset ? el("span", { class: "dim mono", text: `${s.width}×${s.height} · ${s.asset.slice(0, 8)}` }) : null,
            upBtn,
            file,
          ]),
        ]),
        el("div", { class: "mn-row-acts" }, [
          el("button", { type: "button", class: "btn ghost sm", text: "↑", title: "위로", "aria-label": `${i + 1}단계 위로`, disabled: i === 0, onclick: () => move(i, -1) }),
          el("button", { type: "button", class: "btn ghost sm", text: "↓", title: "아래로", "aria-label": `${i + 1}단계 아래로`, disabled: i === draft.steps.length - 1, onclick: () => move(i, 1) }),
          el("button", {
            type: "button",
            class: "btn ghost sm",
            text: "삭제",
            onclick: () => {
              draft.steps.splice(i, 1);
              paint();
            },
          }),
        ]),
      ]);
    }
    function paint() {
      rowsEl.replaceChildren(
        ...(draft.steps.length
          ? draft.steps.map(row)
          : [el("p", { class: "dim", text: "단계가 없습니다 — [+ 단계 추가] 로 시작하세요." })]),
      );
    }

    const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
    save.addEventListener("click", async () => {
      save.disabled = true;
      const body = {
        title: draft.title.trim(),
        steps: draft.steps.map((s) => ({
          // one line per step (schema): a pasted newline becomes a space
          text: (s.text || "").replace(/\s*\n\s*/g, " ").trim(),
          ...(s.asset ? { asset: s.asset, width: s.width, height: s.height } : {}),
        })),
      };
      const r = await api(`/api/docs/manual/${encodeURIComponent(doc.id)}`, {
        method: "PUT",
        headers: { "if-match": rev },
        body,
      });
      save.disabled = false;
      if (r.ok) {
        toast("저장했습니다", "ok");
        reload();
        return;
      }
      const d = r.data || {};
      if (r.status === 409) toast("다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요.", "error");
      else if (r.status === 403) toast("admin 만 할 수 있습니다.", "error");
      else toast(`저장 실패 (${r.status})${d.details ? " — " + d.details.join(" · ") : ""}`, "error");
    });

    holder.replaceChildren(
      el("h2", { class: "sk-h" }, ["단계 편집"]),
      el("div", { class: "slot-edit" }, [
        titleInp,
        rowsEl,
        el("div", { class: "editacts" }, [
          el("button", {
            type: "button",
            class: "btn ghost sm",
            text: "+ 단계 추가",
            onclick: () => {
              draft.steps.push({ text: "" });
              paint();
            },
          }),
          save,
          el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
        ]),
      ]),
    );
    paint();
  }

  read();
  wrap.appendChild(holder);
  return wrap;
}

// Types whose doc screen is a body view of its own (the rest share the
// slot-table screen). Each returns the element the links card is appended to.
export const BODY_VIEWS = {
  "domain-skill": renderSkillView,
  voc: renderVocView,
  "screen-map": renderScreenMapView,
  manual: renderManualView,
};

// ================= 연결 (envelope links[]) =================
// What this doc points at (stored) and what points at it (computed by the
// server on read). Built once per document screen so an open editor survives
// the slot repaints around it; getRev reads the screen's current rev.
export const LINK_RELS = ["screen", "related"];
export function linksSection(type, id, data, getRev, canEdit, reload) {
  const wrap = el("div", { class: "links" });
  const targetsOf = new Map(); // type -> Promise<docs[]>
  function targets(t) {
    if (!targetsOf.has(t))
      targetsOf.set(
        t,
        api(`/api/docs?type=${t}`).then((r) => (r.ok ? r.data.docs : [])),
      );
    return targetsOf.get(t);
  }

  // Links the body's [[ ]] made: shown with 본문에서, removed only by editing
  // the body (the server re-adds them to whatever PUT …/links sends).
  const fromBody = new Set(
    (data.wikilinks || []).filter((w) => w.found).map((w) => `${w.type}/${w.id}#related`),
  );
  const isFromBody = (l) => fromBody.has(`${l.type}/${l.id}#${l.rel}`);
  const bodyChip = () =>
    el("span", { class: "chip from-body", title: "본문의 [[ ]] 에서 온 연결입니다", text: "본문에서" });

  function item(link) {
    return el("li", { class: "link-item" }, [
      el("span", { class: "chip", text: link.rel }),
      isFromBody(link) ? bodyChip() : null,
      el("a", {
        href: `#/doc/${link.type}/${encodeURIComponent(link.id)}`,
        text: `${link.type}/${link.id}`,
      }),
      link.status && link.status !== "active" ? statusBadge(link.status) : null,
    ]);
  }
  function list(title, links) {
    return el("div", { class: "links-col" }, [
      el("h3", { text: title }),
      links.length
        ? el("ul", { class: "links-list" }, links.map(item))
        : el("p", { class: "dim", text: "없음" }),
    ]);
  }

  function read() {
    const h = el("h2", { class: "sk-h" }, ["연결"]);
    if (canEdit)
      h.appendChild(
        el("button", { type: "button", class: "btn ghost sm add-btn", onclick: edit, text: "편집" }),
      );
    wrap.replaceChildren(
      h,
      el("div", { class: "links-cols" }, [
        list("이 문서가 가리키는 문서", data.links || []),
        list("이 문서를 가리키는 문서", data.backlinks || []),
      ]),
    );
  }

  function edit() {
    const rows = (data.links || [])
      .filter((l) => !isFromBody(l))
      .map(({ type: t, id: i, rel }) => ({ type: t, id: i, rel }));
    const fixed = (data.links || []).filter(isFromBody);
    const body = el("div", { class: "links-rows" });
    const relList = el(
      "datalist",
      { id: "link-rels" },
      LINK_RELS.map((r) => el("option", { value: r })),
    );

    function row(r) {
      const typeSel = el("select", { class: "fld", "aria-label": "대상 타입" });
      for (const t of DOC_TYPES) typeSel.appendChild(el("option", { value: t }, TYPE_LABEL[t]));
      typeSel.value = r.type;
      const idSel = el("select", { class: "fld mono", "aria-label": "대상 문서" });
      async function fillIds() {
        idSel.replaceChildren(el("option", { value: "" }, "불러오는 중…"));
        const docs = (await targets(r.type)).filter((d) => !(r.type === type && d.id === id));
        idSel.replaceChildren(
          el("option", { value: "" }, "문서를 고르세요"),
          ...docs.map((d) =>
            el("option", { value: d.id }, d.status === "active" ? d.id : `${d.id} (${STATUS_LABEL[d.status] ?? d.status})`),
          ),
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
      const relInp = el("input", {
        class: "fld mono",
        type: "text",
        list: "link-rels",
        "aria-label": "관계",
        placeholder: "related",
      });
      relInp.value = r.rel;
      relInp.addEventListener("input", () => (r.rel = relInp.value.trim()));
      fillIds();
      return el("div", { class: "link-row" }, [
        typeSel,
        idSel,
        relInp,
        el("button", {
          type: "button",
          class: "btn ghost sm",
          text: "삭제",
          onclick: () => {
            rows.splice(rows.indexOf(r), 1);
            paint();
          },
        }),
      ]);
    }
    function paint() {
      body.replaceChildren(
        ...fixed.map((l) =>
          el("div", { class: "link-row fixed" }, [
            el("span", { class: "mono", text: TYPE_LABEL[l.type] ?? l.type }),
            el("span", { class: "mono", text: l.id }),
            el("span", { class: "mono", text: l.rel }),
            bodyChip(),
          ]),
        ),
        ...(rows.length || fixed.length ? rows.map(row) : [el("p", { class: "dim", text: "연결이 없습니다." })]),
      );
    }

    const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
    save.addEventListener("click", async () => {
      if (rows.some((r) => !r.id || !r.rel)) {
        toast("모든 행에 대상 문서와 관계를 채우세요.", "error");
        return;
      }
      save.disabled = true;
      const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}/links`, {
        method: "PUT",
        headers: { "if-match": getRev() },
        body: { links: rows },
      });
      save.disabled = false;
      if (r.ok) {
        toast("연결을 저장했습니다", "ok");
        reload();
        return;
      }
      const d = r.data || {};
      if (r.status === 409)
        toast("다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요.", "error");
      else if (d.error === "unknown_link_target")
        toast(`없는 문서입니다 — ${d.missing.map((m) => `${m.type}/${m.id}`).join(", ")}`, "error");
      else toast(`저장 실패 (${r.status})${d.details ? " — " + d.details.join(" · ") : ""}`, "error");
    });

    wrap.replaceChildren(
      el("h2", { class: "sk-h" }, ["연결 편집"]),
      el("div", { class: "slot-edit" }, [
        relList,
        body,
        el("div", { class: "editacts" }, [
          el("button", {
            type: "button",
            class: "btn ghost sm",
            text: "+ 연결 추가",
            onclick: () => {
              rows.push({ type: DOC_TYPES[0], id: "", rel: "related" });
              paint();
            },
          }),
          save,
          el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
        ]),
      ]),
    );
    paint();
  }

  read();
  return wrap;
}
