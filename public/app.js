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
  // fetch throws rather than resolving for two reachable cases: the network is
  // down, and the token carries a character that cannot go in a header (a
  // mis-paste — Korean text, a stray newline). Both used to surface as an
  // unhandled rejection, which meant the UI showed nothing at all and left
  // whatever message was on screen before. Status 0 = "the request never went
  // out", distinct from any status a server can return.
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || "GET",
      headers,
      body,
    });
  } catch {
    return { ok: false, status: 0, etag: null, data: null };
  }
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
  const anon = currentUser.anonymous === true;
  $("meta-store").replaceChildren(
    el("span", {
      class: anon ? "whoami anon" : "whoami",
      text: anon ? "열람 전용" : `${currentUser.id} (${currentUser.role})`,
    }),
    el("button", {
      type: "button",
      id: "auth-toggle",
      class: "btn ghost sm",
      text: anon ? "로그인" : "로그아웃",
      onclick: anon ? () => showLogin() : logout,
    }),
  );
}
// Ask the server who we are with whatever credential is in storage — none is a
// valid answer when anonymous read is on, and that is what boots the read-only
// view. Returns the identity, or null if even anonymous access was refused.
async function loadMe() {
  const res = await api("/api/me");
  // The status is carried out, not swallowed: "wrong token" and "server is
  // rate-limiting you" and "the auth store is broken" are different problems
  // and the login screen has to be able to say which one happened.
  if (!res.ok) return { ok: false, status: res.status };
  currentUser = res.data;
  renderMeta();
  return { ok: true };
}
function loginFailureMessage(status) {
  if (status === 0)
    return "요청을 보내지 못했습니다 — 서버에 연결할 수 없거나, 토큰에 쓸 수 없는 문자가 섞여 있습니다.";
  if (status === 401)
    return "토큰이 유효하지 않습니다 — 오타이거나, 만료됐거나, 회수된 토큰입니다.";
  if (status === 429)
    return "인증 시도가 너무 많습니다. 잠시 후 다시 시도하세요.";
  if (status === 500)
    return "서버의 인증 저장소를 읽지 못했습니다. 관리자에게 문의하세요.";
  return `로그인 실패 (${status})`;
}
async function tryLogin(token) {
  setToken(token);
  const me = await loadMe();
  if (!me.ok) {
    clearToken();
    showLogin(loginFailureMessage(me.status));
    return false;
  }
  showApp();
  return true;
}
// Anonymous browsing: no token at all. Only reachable when the server allows it
// (AKG_ANON_READ), otherwise /api/me 401s and the caller falls back to login.
async function tryAnon() {
  clearToken();
  const me = await loadMe();
  if (!me.ok) return false;
  showApp();
  return true;
}
async function logout() {
  clearToken();
  if (await tryAnon()) enterApp();
  else showLogin("로그아웃했습니다.");
}
$("token-submit").addEventListener("click", async () => {
  const val = $("token-input").value.trim();
  // An empty submit used to do nothing at all, which reads as a broken button.
  if (!val) return showLogin("토큰을 입력하세요.");
  if (await tryLogin(val)) enterApp();
});
// The input is not inside a <form>, so Enter would otherwise do nothing —
// which is the first thing anyone tries in a password field.
$("token-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("token-submit").click();
});
// Escape hatch from the login screen back to anonymous browsing — without it a
// logged-out user who opens login has no way back to the read-only view.
$("login-cancel").addEventListener("click", async () => {
  if (await tryAnon()) enterApp();
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
  const { json: doc, rev, slots, md } = res.data;
  const canApprove = currentUser.role === "approver";
  const canEdit = canApprove || currentUser.role === "editor";
  const inputs = {}; // address -> {textArea, evidenceInput}

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
            editingAddr = slot.address;
            renderInner();
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
  function startEdit(address) {
    editingAddr = address;
    renderInner();
  }
  function cancelEdit() {
    editingAddr = null;
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
  function slotEditFields(slot) {
    const textArea = el("textarea", { text: slot.text ?? "" });
    const evidenceInput = el("input", {
      type: "text",
      value: (slot.evidence || []).join("; "),
      placeholder: "근거 (file:line; 세미콜론 구분)",
    });
    inputs[slot.address] = { textArea, evidenceInput };
    return [textArea, evidenceInput];
  }
  // Save/Cancel pair shown inline next to whichever slot is being edited.
  function slotEditActs(slot) {
    return el("span", { class: "acts" }, [
      el("button", {
        type: "button",
        class: "btn primary sm",
        onclick: () => saveEdit(slot.address),
        text: "저장",
      }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        onclick: cancelEdit,
        text: "취소",
      }),
    ]);
  }

  // .ps row (purpose / query note)
  function psRow(slot) {
    if (editingAddr === slot.address) {
      return el("div", { class: "ps editing" }, [
        tierBadge(slot.tier),
        el("div", { class: "txt2" }, slotEditFields(slot)),
        slotEditActs(slot),
      ]);
    }
    return el("div", { class: "ps" }, [
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
    if (editingAddr === slot.address) {
      return el("div", { class: "cslot editing" }, [
        tierBadge(slot.tier),
        el("span", { class: "txt3" }, slotEditFields(slot)),
        slotEditActs(slot),
      ]);
    }
    return el("div", { class: "cslot" }, [
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
      mdChildren.push(
        el("h1", { text: b.owner ? `${b.owner}.${b.table}` : b.table }),
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

  async function saveEdit(address) {
    const f = inputs[address];
    if (!f) return;
    const clientBody = structuredClone(doc.body);
    const text = f.textArea.value.trim();
    const ev = f.evidenceInput.value
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const existing = getSlot(clientBody, address) || {};
    setSlot(clientBody, address, {
      text: text || null,
      tier: existing.tier,
      evidence: ev,
    });
    const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "if-match": rev },
      body: clientBody,
    });
    if (r.status === 409) {
      notice.replaceChildren(
        el("div", { class: "notice" }, [
          el("strong", {
            text: "충돌 — 다른 사용자가 같은 슬롯을 먼저 고쳤습니다: ",
          }),
          el("span", { text: (r.data.overlap || []).join(", ") }),
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
    if (!r.ok) {
      toast(`저장 실패 (${r.status})`, "error");
      return;
    }
    reload();
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
  // With a token, log in as that user. Without one, try anonymous first — the
  // login screen is now an opt-in action, not the front gate. It only appears
  // if the server refuses anonymous reads.
  if (token) {
    if (await tryLogin(token)) enterApp();
    return;
  }
  if (await tryAnon()) enterApp();
  else showLogin();
})();
