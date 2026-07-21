// Dashboard SPA — vanilla JS, no build step, no inline handlers (CSP
// script-src 'self'). Every dynamic string goes through textContent, never
// innerHTML. Markup structure + class names mirror the approved FE prototype
// (~/repo/agent-knowledge-governance-fe-proto.html) 1:1; the prototype's mock
// data is replaced by live §6 API calls. Static chrome (header, sidebar shell,
// intro-band + SVG state diagram) lives in index.html.
"use strict";

const TOKEN_KEY = "akg_token";
const THEME_KEY = "akg_theme";
let currentUser = null; // {id, role}
let lastDoc = null; // {type, id} — for the "문서" nav tab

const DOC_TYPES = ["db-schema", "msg-format", "domain-skill"];
const TIER_LABEL = {
  scaffold: "빈칸",
  inferred: "추정",
  confirmed: "확정",
  deprecated: "폐기",
};
const TIER_ABBR = {
  scaffold: "sc",
  inferred: "inf",
  confirmed: "conf",
  deprecated: "dep",
};
const TYPE_LABEL = {
  "db-schema": "db-schema",
  "msg-format": "msg-format",
  "domain-skill": "domain-skill",
};

// ---------- DOM helper ----------
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null)
      node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children || [])) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
const $ = (id) => document.getElementById(id);

// ---------- toast (prototype pattern — reused for notices/errors) ----------
let toastTimer = null;
function toast(message, klass) {
  const t = $("toast");
  t.replaceChildren(el("div", { class: klass || "", text: message }));
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 4200);
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("theme-toggle").textContent =
    theme === "dark" ? "라이트 모드" : "다크 모드";
}
$("theme-toggle").addEventListener("click", () => {
  const next =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------- API ----------
const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let body = opts.body;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers,
    body,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* fail-soft: 304 / md text bodies have no JSON */
  }
  return {
    ok: res.ok,
    status: res.status,
    etag: res.headers.get("etag"),
    data,
  };
}

// ---------- slot address helpers (mirror server/slots.mjs) ----------
function getSlot(body, address) {
  const tokens = address.match(/([^.[\]]+)|\[(\d+)\]/g) || [];
  let cur = body;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = t.startsWith("[") ? cur[Number(t.slice(1, -1))] : cur[t];
  }
  return cur;
}
function setSlot(body, address, value) {
  const tokens = address.match(/([^.[\]]+)|\[(\d+)\]/g) || [];
  let cur = body;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    cur = t.startsWith("[") ? cur[Number(t.slice(1, -1))] : cur[t];
  }
  const last = tokens[tokens.length - 1];
  if (last.startsWith("[")) cur[Number(last.slice(1, -1))] = value;
  else cur[last] = value;
}

// ---------- shared bits ----------
function tierBadge(tier) {
  return el("span", {
    class: `b b-${TIER_ABBR[tier]}`,
    text: TIER_LABEL[tier],
  });
}
function keywordChips(keywords) {
  return keywords.map((k) =>
    el("span", {
      class: `kw${k.inject === "pointer" ? " ptr" : ""}`,
      text: k.kw,
    }),
  );
}
function tierMeter(tiers) {
  const order = ["scaffold", "inferred", "confirmed", "deprecated"];
  const meter = el("span", { class: "meter", "aria-hidden": "true" });
  const parts = [];
  for (const t of order) {
    if (!tiers[t]) continue;
    meter.appendChild(
      el("i", { class: `m-${TIER_ABBR[t]} f${Math.min(tiers[t], 7)}` }),
    );
    parts.push(`${TIER_LABEL[t]} ${tiers[t]}`);
  }
  if (!parts.length) parts.push("빈 문서");
  return el("span", {}, [
    meter,
    el("span", { class: "mtxt", text: parts.join(" · ") }),
  ]);
}
function evidence(ev) {
  return (ev || []).map((e) => el("span", { class: "ev", text: e }));
}
const shortRev = (r) => (r || "").slice(0, 7);

// ---------- shell ----------
function showLogin(message) {
  $("topbar").hidden = true;
  $("app-layout").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message || "";
}
function showApp() {
  $("topbar").hidden = false;
  $("app-layout").hidden = false;
  $("login").hidden = true;
}
function renderMeta() {
  $("meta-store").replaceChildren(
    el("span", { text: `${currentUser.id} (${currentUser.role})` }),
  );
}
async function tryLogin(token) {
  setToken(token);
  const res = await api("/api/me");
  if (!res.ok) {
    clearToken();
    showLogin(
      res.status === 401
        ? "토큰이 유효하지 않습니다."
        : `로그인 실패 (${res.status})`,
    );
    return false;
  }
  currentUser = res.data;
  renderMeta();
  showApp();
  return true;
}
$("token-submit").addEventListener("click", async () => {
  const val = $("token-input").value.trim();
  if (!val) return;
  if (await tryLogin(val)) enterApp();
});

// ---------- URL token pickup (convenience only — S1 still enforced server-side) ----------
function consumeUrlToken() {
  const params = new URLSearchParams(location.search);
  const t = params.get("token");
  if (!t) return null;
  params.delete("token");
  const rest = params.toString();
  history.replaceState(
    null,
    "",
    location.pathname + (rest ? `?${rest}` : "") + location.hash,
  );
  return t;
}

// ---------- navigation (prototype: section.on + nav button.on) ----------
function go(screen) {
  for (const s of document.querySelectorAll("main > section"))
    s.classList.toggle("on", s.id === screen);
  for (const b of document.querySelectorAll("nav button"))
    b.classList.toggle("on", b.dataset.go === screen);
  window.scrollTo(0, 0);
}
for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    const screen = btn.dataset.go;
    if (screen === "doc" && lastDoc)
      location.hash = `#/doc/${lastDoc.type}/${encodeURIComponent(lastDoc.id)}`;
    else location.hash = `#/${screen}`;
  });
}
window.addEventListener("hashchange", route);

function route() {
  if (!currentUser) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "doc" && parts[1] && parts[2]) {
    go("doc");
    renderDocScreen(parts[1], decodeURIComponent(parts[2]));
    return;
  }
  const screen = ["corpus", "queue", "audit"].includes(parts[0])
    ? parts[0]
    : "corpus";
  go(screen);
  if (screen === "corpus") renderOverview();
  else if (screen === "queue") renderQueue();
  else if (screen === "audit") renderAudit();
}

// ---------- sidebar (prototype: side-toggle + grp folding) ----------
$("side-toggle").addEventListener("click", () => {
  const layout = document.querySelector(".layout");
  const hidden = !layout.classList.contains("hide-side");
  layout.classList.toggle("hide-side", hidden);
  $("side-toggle").setAttribute("aria-pressed", String(hidden));
});

async function renderDocTree() {
  const tree = $("doc-tree");
  tree.replaceChildren();
  let pendingTotal = 0;
  for (const type of DOC_TYPES) {
    const res = await api(`/api/docs?type=${type}`);
    // Inactive documents belong in the tree: they are readable by design and
    // invisible ones cannot be reviewed, let alone activated. Archived stays
    // hidden — that one is a decision to stop carrying the document.
    const docs = (res.ok ? res.data.docs : []).filter(
      (d) => d.status !== "archived",
    );
    const items = el(
      "div",
      { class: "grp-items" },
      docs.map((d) => {
        pendingTotal += d.tiers.inferred || 0;
        return el(
          "button",
          {
            type: "button",
            class: d.status === "inactive" ? "doc-item off" : "doc-item",
            "data-type": type,
            "data-id": d.id,
            onclick: () =>
              (location.hash = `#/doc/${type}/${encodeURIComponent(d.id)}`),
          },
          [
            el("span", { class: "nm", text: d.id }),
            el("span", { class: "mini" }, [
              d.status === "inactive"
                ? el("span", { class: "mini-off", text: "비활성" })
                : null,
              d.tiers.inferred
                ? el("span", {
                    class: "mini-inf",
                    text: String(d.tiers.inferred),
                  })
                : null,
              d.tiers.deprecated
                ? el("span", {
                    class: "mini-dep",
                    text: String(d.tiers.deprecated),
                  })
                : null,
            ]),
          ],
        );
      }),
    );
    const grp = el("div", { class: "grp" }, [
      el(
        "button",
        {
          type: "button",
          class: "grp-h",
          onclick: (e) =>
            e.currentTarget.closest(".grp").classList.toggle("closed"),
        },
        [
          el("span", { class: "chev", text: "▾" }),
          ` ${type} `,
          el("span", { class: "cnt", text: String(docs.length) }),
        ],
      ),
      items,
    ]);
    tree.appendChild(grp);
  }
  highlightTree();
  return pendingTotal;
}
function highlightTree() {
  for (const b of $("doc-tree").querySelectorAll(".doc-item")) {
    b.classList.toggle(
      "on",
      lastDoc && b.dataset.type === lastDoc.type && b.dataset.id === lastDoc.id,
    );
  }
}

// ================= 개요 =================
async function renderOverview() {
  const all = [];
  const totals = { scaffold: 0, inferred: 0, confirmed: 0, deprecated: 0 };
  for (const type of DOC_TYPES) {
    const res = await api(`/api/docs?type=${type}`);
    if (!res.ok) continue;
    for (const d of res.data.docs) {
      if (d.status === "archived") continue;
      all.push({ ...d, type });
      for (const t of Object.keys(totals)) totals[t] += d.tiers[t] || 0;
    }
  }

  // Counted separately rather than folded into 문서: after a bulk import most
  // of the corpus can be inactive, and a single total would read as a corpus
  // far larger than what any session actually sees.
  const inactive = all.filter((d) => d.status === "inactive").length;
  $("ov-stats").replaceChildren(
    stat(String(all.length - inactive), "활성 문서"),
    stat(String(inactive), "비활성 (주입 안 됨)", inactive ? "off" : ""),
    stat(String(totals.inferred), "검토 대기 (추정 슬롯)", "warn"),
    stat(String(totals.confirmed), "confirmed 슬롯"),
    stat(String(totals.deprecated), "deprecated (고아)", "dep"),
  );

  const typeCounts = { all: all.length };
  for (const d of all) typeCounts[d.type] = (typeCounts[d.type] || 0) + 1;
  const chipDefs = [
    ["all", `전체 ${typeCounts.all || 0}`],
    ["db-schema", `db-schema ${typeCounts["db-schema"] || 0}`],
    ["msg-format", `msg-format ${typeCounts["msg-format"] || 0}`],
    ["domain-skill", `domain-skill ${typeCounts["domain-skill"] || 0}`],
  ];
  const chips = chipDefs.map(([t, label], i) =>
    el(
      "button",
      {
        type: "button",
        class: i === 0 ? "on" : "",
        "data-type": t,
        onclick: (e) => filterType(e.currentTarget, t),
      },
      label,
    ),
  );
  $("ov-typechips").replaceChildren(...chips);

  const rows = all.map((d) =>
    el(
      "tr",
      {
        class: "nav-doc",
        "data-type": d.type,
        tabindex: "0",
        onclick: () =>
          (location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`),
        onkeydown: (e) => {
          if (e.key === "Enter")
            location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`;
        },
      },
      [
        el("td", {}, [
          el("b", { text: d.id }),
          " ",
          el("span", { class: "dim", text: TYPE_LABEL[d.type] }),
        ]),
        el("td", {}, keywordChips(d.keywords || [])),
        el("td", {}, tierMeter(d.tiers)),
        el("td", {}, statusBadge(d.status)),
        el("td", {}, el("span", { class: "chip rev", text: shortRev(d.rev) })),
      ],
    ),
  );
  $("ov-table").replaceChildren(
    all.length
      ? el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "문서" }),
              el("th", { scope: "col", text: "키워드" }),
              el("th", { scope: "col", text: "검토 상태" }),
              el("th", { scope: "col", text: "상태" }),
              el("th", { scope: "col", text: "rev" }),
            ]),
          ),
          el("tbody", {}, rows),
        ])
      : el("p", { class: "loading", text: "문서가 없습니다." }),
  );

  function filterType(btn, t) {
    for (const c of $("ov-typechips").querySelectorAll("button"))
      c.classList.toggle("on", c === btn);
    for (const tr of $("ov-table").querySelectorAll("tbody tr")) {
      tr.style.display = t === "all" || tr.dataset.type === t ? "" : "none";
    }
  }
}
function stat(value, label, klass) {
  return el("div", { class: `stat${klass ? " " + klass : ""}` }, [
    el("b", { text: value }),
    el("span", { text: label }),
  ]);
}

// The status in the reader's language: what it means for the document, not the
// enum value. "활성" alone says nothing about why anyone should care.
const STATUS_LABEL = {
  active: "활성",
  inactive: "비활성",
  archived: "폐기",
};
function statusBadge(status) {
  return el("span", {
    class: `chip st-${status}`,
    text: STATUS_LABEL[status] ?? status,
    title:
      status === "inactive"
        ? "조회는 되지만 미러로 나가지 않아 세션에 주입되지 않습니다."
        : status === "active"
          ? "미러로 배포되어 세션 프롬프트에 주입됩니다."
          : "더 이상 싣지 않는 문서입니다.",
  });
}

// ================= 문서 (단일 문서 뷰) =================
// 편집은 슬롯 단위 클릭-투-편집(도착 상태 텍스트를 바로 누르면 그 슬롯만
// 편집 필드로 바뀜) — 문서 전체를 편집 모드로 앞서 전환하는 버튼은 없다.
let editingAddr = null; // null | slot address currently being edited
async function renderDocScreen(type, id) {
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
  lastDoc = { type, id };
  highlightTree();
  editingAddr = null;
  // doc/rev are reassigned in place after a clean save so the screen can
  // repaint optimistically instead of re-fetching the whole document.
  let { json: doc, rev } = res.data;
  const { slots, md } = res.data;
  const canApprove = currentUser.role === "approver";
  const canEdit = canApprove || currentUser.role === "editor";
  let editBuf = null; // {text, evidence[]} — working copy of the open slot
  let reconcileFor = null; // {address, doc, rev, overlap} — 409 화해 카드 상태
  const live = {}; // live refs of the open editor (badge/caption/save/diff)

  const notice = el("div", { id: "doc-notice" });

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
          ["확정", el("span", { class: "role", text: "approver" })],
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
  // 단어 단위 LCS diff — 저장 전 미리보기(④)에서 무엇이 바뀌는지 보여준다.
  function wordDiff(oldStr, newStr) {
    const a = oldStr.trim() ? oldStr.trim().split(/\s+/) : [];
    const b = newStr.trim() ? newStr.trim().split(/\s+/) : [];
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          a[i] === b[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ t: "eq", w: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ t: "del", w: a[i] });
        i++;
      } else {
        out.push({ t: "add", w: b[j] });
        j++;
      }
    }
    while (i < n) out.push({ t: "del", w: a[i++] });
    while (j < m) out.push({ t: "add", w: b[j++] });
    return out;
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
    if (type === "domain-skill") {
      section.replaceChildren(
        renderSkillView(doc, rev, md, canEdit, canApprove),
      );
      return;
    }
    const b = doc.body;
    const mdChildren = [];
    if (type === "db-schema") {
      mdChildren.push(el("h1", { text: `${b.owner}.${b.table}` }));
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

    section.replaceChildren(
      el("div", { class: "dochead" }, [
        el("span", { class: "id", text: id }),
        el("span", { class: "chip", text: type }),
        statusBadge(doc.status),
        el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
        el("span", { class: "brk" }),
        ...keywordChips(doc.keywords || []),
        statusSwitch(),
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
      notice,
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
                ? `If-Match: ${shortRev(rev)} · 값을 클릭하면 바로 편집 · 슬롯 안 겹치면 자동 재베이스(S6)`
                : `If-Match: ${shortRev(rev)} · 편집·확정·폐기는 슬롯 단위`,
            }),
          ),
        ]),
      ),
    );
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

// domain-skill: editorial reading view (prototype .skwrap), read-only in v1
function renderSkillView(doc, rev, md, canEdit, canApprove) {
  const s = doc.body;
  const wrap = el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: "domain-skill · 조회 절차 스킬" }),
    el("h1", { class: "sk-title", text: s.name }),
    el("p", { class: "sk-sub", text: (s.description || "").split("\n")[0] }),
    el("div", { class: "sk-chips" }, [
      el("span", { class: "chip", text: doc.status }),
      el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
      ...keywordChips(doc.keywords || []),
    ]),
  ]);
  // frontmatter spec sheet
  const fm = el(
    "table",
    {},
    el("tbody", {}, [
      el("tr", {}, [
        el("td", { class: "key", text: "name" }),
        el("td", { class: "mono", text: s.name }),
      ]),
      el("tr", {}, [
        el("td", { class: "key", text: "argument-hint" }),
        el("td", { class: "mono", text: s.argumentHint }),
      ]),
      el("tr", {}, [
        el("td", { class: "key", text: "description" }),
        el("td", { text: s.description }),
      ]),
      el("tr", {}, [
        el("td", { class: "key", text: "disable-model-invocation" }),
        el("td", {}, [el("span", { class: "flag", text: "true" })]),
      ]),
    ]),
  );
  wrap.appendChild(el("div", { class: "fm" }, fm));
  if (s.intro) wrap.appendChild(el("p", { class: "lead", text: s.intro }));

  wrap.appendChild(el("h2", { class: "sk-h", text: "조회 절차" }));
  const steps = el(
    "ol",
    { class: "steps" },
    (s.steps || []).map((st) => {
      const li = el("li", {}, [
        el("div", { class: "st-h" }, [
          st.title,
          st.lead ? el("span", { class: "n", text: st.lead }) : null,
        ]),
      ]);
      li.appendChild(
        el(
          "div",
          { class: "tbl-wrap" },
          el("pre", { class: "step-sql", text: st.sql }),
        ),
      );
      if (st.notes)
        li.appendChild(
          el("div", { class: "step-notes" }, [
            el("b", { text: "분기" }),
            " " + st.notes,
          ]),
        );
      return li;
    }),
  );
  wrap.appendChild(steps);

  wrap.appendChild(el("h2", { class: "sk-h", text: "값 해석 규칙" }));
  wrap.appendChild(
    el(
      "div",
      { class: "md tbl-wrap" },
      el("table", {}, [
        el(
          "thead",
          {},
          el("tr", {}, [
            el("th", { scope: "col", text: "대상" }),
            el("th", { scope: "col", text: "규칙" }),
            el("th", { scope: "col", text: "근거" }),
          ]),
        ),
        el(
          "tbody",
          {},
          (s.valueRules || []).map((r) =>
            el("tr", {}, [
              el("td", { text: r.target }),
              el("td", { text: r.rule }),
              el("td", { class: "dim", text: r.basis }),
            ]),
          ),
        ),
      ]),
    ),
  );

  wrap.appendChild(el("h2", { class: "sk-h", text: "출력" }));
  const outCard = el("div", { class: "out-card" }, [
    el("div", { class: "out-tmpl", text: s.output.template }),
  ]);
  if (s.output.lead)
    outCard.insertBefore(
      el("div", { class: "out-hint", text: s.output.lead }),
      outCard.firstChild,
    );
  if (s.output.example)
    outCard.appendChild(
      el("div", { class: "out-ex" }, [
        s.output.exampleLabel
          ? el("span", { class: "lbl", text: s.output.exampleLabel })
          : null,
        s.output.example,
      ]),
    );
  wrap.appendChild(outCard);

  const skbar = el("div", { class: "skbar" }, [
    el("span", { class: "b b-inf", text: "추정" }),
    el("span", {
      class: "dim",
      text: "v1은 슬롯 단위가 아니라 문서 전체 검토 — basis 인라인",
    }),
    el("span", { class: "mla" }),
  ]);
  if (canApprove)
    skbar.appendChild(
      el("button", {
        type: "button",
        class: "btn promote sm",
        onclick: () =>
          toast(
            "domain-skill 승격은 문서 단위 — 서버 promote는 슬롯 기반이라 v1 미연결.",
            "",
          ),
        text: "확정",
      }),
    );
  wrap.appendChild(skbar);
  return wrap;
}

// ================= 검토 대기열 =================
async function renderQueue() {
  const section = $("queue");
  section.replaceChildren(
    el("h2", {}, ["에이전트 제안 ", el("span", { class: "n", id: "q-pend" })]),
  );

  const propRes = await api("/api/proposals?state=pending");
  const propWrap = el("div", {});
  section.appendChild(propWrap);
  if (propRes.status === 403)
    propWrap.appendChild(
      el("p", { class: "loading", text: "editor 이상만 볼 수 있습니다." }),
    );
  else if (!propRes.ok)
    propWrap.appendChild(
      el("p", { class: "error", text: `불러오기 실패 (${propRes.status})` }),
    );
  else if (!propRes.data.proposals.length)
    propWrap.appendChild(
      el("p", { class: "loading", text: "대기 중인 제안이 없습니다." }),
    );
  else {
    const pc = $("q-pend");
    if (pc) pc.textContent = `${propRes.data.proposals.length} pending`;
    for (const p of propRes.data.proposals)
      propWrap.appendChild(proposalCard(p));
  }

  await slotQueueSection(
    section,
    "추정 슬롯 — 문서 횡단",
    "확정 대기",
    "inferred",
    true,
  );
  await slotQueueSection(
    section,
    "폐기(deprecated) 슬롯",
    "삭제/복원 대기",
    "deprecated",
    false,
  );

  function proposalCard(p) {
    const bodyLines = Object.entries(p.slots).map(([addr, v]) =>
      el("div", {}, [
        el("span", { class: "addr", text: addr }),
        ` "${v.text}" `,
        ...evidence(v.evidence),
      ]),
    );
    return el("div", { class: "prop" }, [
      el("div", { class: "head" }, [
        el("span", { class: "agent", text: p.submittedBy }),
        el("span", { class: "dim", text: "→" }),
        el("span", { class: "target", text: `${p.type}/${p.docId}` }),
        el("span", {
          class: "dim mla",
          text: `${p.id.slice(0, 6)} · ${p.createdAt}`,
        }),
      ]),
      el("div", { class: "body" }, bodyLines),
      el("div", { class: "acts" }, [
        el("button", {
          type: "button",
          class: "btn primary",
          onclick: () => adopt(p),
          text: "추정으로 반영",
        }),
        el("button", {
          type: "button",
          class: "btn danger",
          onclick: () => reject(p),
          text: "기각",
        }),
      ]),
    ]);
  }
  async function adopt(p) {
    const docRes = await api(
      `/api/docs/${p.type}/${encodeURIComponent(p.docId)}`,
    );
    if (!docRes.ok) return toast("대상 문서를 찾을 수 없습니다.", "error");
    const r = await api(`/api/proposals/${p.id}/adopt`, {
      method: "POST",
      headers: { "if-match": docRes.data.rev },
      body: {},
    });
    if (r.ok) {
      await renderDocTree();
      renderQueue();
    } else toast(`반영 실패 (${r.status})`, "error");
  }
  async function reject(p) {
    const r = await api(`/api/proposals/${p.id}/reject`, {
      method: "POST",
      body: {},
    });
    if (r.ok) renderQueue();
    else toast(`기각 실패 (${r.status})`, "error");
  }
}

async function slotQueueSection(section, title, badge, tier, promotable) {
  section.appendChild(
    el("h2", {}, [title + " ", el("span", { class: "n", text: badge })]),
  );
  const wrap = el("div", { class: "tbl-wrap" });
  section.appendChild(wrap);
  const canApprove = currentUser.role === "approver";
  const rows = [];
  for (const type of DOC_TYPES) {
    const listRes = await api(`/api/docs?type=${type}&tier=${tier}`);
    if (!listRes.ok) continue;
    for (const d of listRes.data.docs) {
      const detail = await api(`/api/docs/${type}/${encodeURIComponent(d.id)}`);
      if (!detail.ok) continue;
      const drev = detail.data.rev;
      for (const slot of detail.data.slots.filter((s) => s.tier === tier)) {
        const actCell = el("td", {});
        if (promotable && canApprove) {
          actCell.appendChild(
            el("button", {
              type: "button",
              class: "btn promote",
              onclick: async () => {
                const r = await api(
                  `/api/docs/${type}/${encodeURIComponent(d.id)}/promote`,
                  {
                    method: "POST",
                    headers: { "if-match": drev },
                    body: { slots: [slot.address] },
                  },
                );
                if (r.ok) {
                  await renderDocTree();
                  renderQueue();
                } else toast(`확정 실패 (${r.status})`, "error");
              },
              text: "확정",
            }),
          );
        } else if (!promotable) {
          actCell.appendChild(
            el("a", {
              class: "btn ghost",
              href: `#/doc/${type}/${encodeURIComponent(d.id)}`,
              text: "문서로",
            }),
          );
        }
        rows.push(
          el("tr", tier === "deprecated" ? { class: "dep-row" } : {}, [
            el("td", { text: `${type === "db-schema" ? d.id : d.id}` }),
            el("td", {}, el("span", { class: "addr", text: slot.address })),
            el(
              "td",
              {},
              el(
                "span",
                tier === "deprecated" ? { class: "strike dim" } : {},
                slot.text || "",
              ),
            ),
            el("td", {
              class: "num",
              text: String((slot.evidence || []).length),
            }),
            el("td", { class: "dim", text: slot.by || "" }),
            actCell,
          ]),
        );
      }
    }
  }
  wrap.replaceChildren(
    rows.length
      ? el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "문서" }),
              el("th", { scope: "col", text: "슬롯" }),
              el("th", { scope: "col", text: "내용" }),
              el("th", { scope: "col", class: "num", text: "근거" }),
              el("th", { scope: "col", text: "by" }),
              el("th", { scope: "col", text: "" }),
            ]),
          ),
          el("tbody", {}, rows),
        ])
      : el("p", { class: "loading", text: "없습니다." }),
  );
}

// ================= 감사 =================
async function renderAudit() {
  const section = $("audit");
  const docInput = el("input", { type: "text", placeholder: "type/id (선택)" });
  const windowSelect = el("select", {}, [
    el("option", { value: "", text: "전체 기간" }),
    el("option", { value: "24h", text: "최근 24시간" }),
    el("option", { value: "7d", text: "최근 7일" }),
    el("option", { value: "4w", text: "최근 4주" }),
  ]);
  const goBtn = el("button", {
    type: "button",
    class: "btn",
    onclick: load,
    text: "조회",
  });
  const results = el("div", {});
  section.replaceChildren(
    el("h2", {}, [
      "감사 로그 ",
      el("span", { class: "n", text: "= git log (GET /api/audit)" }),
    ]),
    el("div", { class: "row6", style: "padding:0 16px 8px" }, [
      docInput,
      windowSelect,
      goBtn,
    ]),
    results,
  );

  async function load() {
    const params = new URLSearchParams();
    if (docInput.value.trim()) params.set("doc", docInput.value.trim());
    if (windowSelect.value) params.set("window", windowSelect.value);
    const res = await api(`/api/audit?${params.toString()}`);
    if (!res.ok)
      return results.replaceChildren(
        el("p", { class: "error", text: `조회 실패 (${res.status})` }),
      );
    if (!res.data.entries.length)
      return results.replaceChildren(
        el("p", { class: "loading", text: "기록이 없습니다." }),
      );
    results.replaceChildren(
      el(
        "div",
        { class: "tbl-wrap" },
        el("table", {}, [
          el(
            "thead",
            {},
            el("tr", {}, [
              el("th", { scope: "col", text: "시각" }),
              el("th", { scope: "col", text: "actor" }),
              el("th", { scope: "col", text: "메시지" }),
              el("th", { scope: "col", text: "rev" }),
            ]),
          ),
          el(
            "tbody",
            {},
            res.data.entries.map((e) =>
              el("tr", {}, [
                el("td", { class: "dim", text: e.at }),
                el("td", { text: e.author }),
                el("td", {}, auditMessage(e.message)),
                el(
                  "td",
                  {},
                  el("span", { class: "chip rev", text: shortRev(e.rev) }),
                ),
              ]),
            ),
          ),
        ]),
      ),
    );
  }
  await load();
}
// color the leading verb of a commit message as an action badge (prototype .act)
function auditMessage(msg) {
  const verb = (msg || "").split(" ")[0];
  const cls = {
    promote: "a-promote",
    adopt: "a-adopt",
    edit: "a-edit",
    "catalog-push": "a-catalog",
    deprecate: "a-dep",
    reject: "a-reject",
    create: "a-edit",
    propose: "a-adopt",
  }[verb];
  if (!cls) return document.createTextNode(msg);
  return el("span", {}, [
    el("span", { class: `act ${cls}`, text: verb }),
    " " + msg.slice(verb.length + 1),
  ]);
}

// ---------- boot ----------
function enterApp() {
  renderDocTree().then(() => route());
}
(async function boot() {
  applyTheme(localStorage.getItem(THEME_KEY) || "light");
  const token = consumeUrlToken() || getToken();
  if (!token) return showLogin();
  if (await tryLogin(token)) enterApp();
})();
