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

// ---------- JSON 보기 패널 (승인자 전용 — 문서를 좌우로 갈라 원본 store JSON) ----------
// 모달로 문서를 덮지 않고, 문서 뷰를 좌우로 갈라 오른쪽에 붙인다 — 렌더된 문서와
// 원본 JSON 을 나란히 대조하며 승격을 판단하게. renderInner 가 다시 그릴 때마다
// 최신 doc 으로 새로 만들어지므로 편집·승격 직후 JSON 도 즉시 갱신된다(상태는
// 여는 여부뿐). CSP(script-src 'self') 아래라 인라인 없이 el/addEventListener 로만.
function jsonPane(title, obj, onClose) {
  const pretty = JSON.stringify(obj, null, 2);
  return el("aside", { class: "json-pane", "aria-label": "원본 JSON" }, [
    el("div", { class: "jm-head" }, [
      el("span", { class: "jm-title", text: title }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        text: "복사",
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(pretty);
            toast("JSON 을 복사했습니다.");
          } catch {
            toast("복사할 수 없습니다 — 텍스트를 직접 선택해 복사하세요.", "error");
          }
        },
      }),
      el("button", {
        type: "button",
        class: "btn ghost sm",
        "aria-label": "JSON 패널 닫기",
        text: "✕",
        onclick: onClose,
      }),
    ]),
    el("pre", { class: "jm-body", text: pretty }),
  ]);
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
        ? "주입이 꺼진 문서입니다 — 대시보드에서 열람·편집만 됩니다."
        : status === "active"
          ? "LLM 세션에 주입되는 문서입니다. 문서 단위 전역 스위치 — 모든 사용자에게 동일합니다."
          : "폐기된 문서입니다 — 기록으로만 남습니다.",
  });
}

// 단어 단위 LCS diff — 저장 전 미리보기(④)에서 무엇이 바뀌는지 보여준다.
// db-schema 슬롯과 domain-skill 필드 편집이 공유한다.
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
  let jsonOpen = false; // 승인자 원본 JSON 좌우 분할 패널이 열려 있는지

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
      const skill = renderSkillView(
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
      );
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

// domain-skill: editorial reading view (prototype .skwrap), read-only in v1
function renderSkillView(doc, rev, md, canEdit, reload, onToggleStatus, onToggleJson, jsonOpen) {
  const s = doc.body;
  const url = `/api/docs/domain-skill/${encodeURIComponent(doc.id)}`;
  // Only one inline editor open at a time. A dirty editor blocks opening
  // another (flash + toast) — the same guard db-schema slots use; a clean
  // one is reverted silently.
  let active = null; // { revert, dirty, flash } of the open editor

  // Every field edit is one whole-body PUT (spec v2 has no tiered slots — the
  // body is the unit). mutate() applies the one change onto a clone; on success
  // the screen reloads so the next edit sees a fresh rev.
  async function commit(mutate) {
    const next = structuredClone(s);
    mutate(next);
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
    if (r.status === 409)
      toast("다른 사람이 먼저 수정했습니다 — 문서를 다시 여세요.", "error");
    else if (r.status === 403) toast("editor 이상 권한이 필요합니다.", "error");
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

  // A click-to-edit value. opts.kind: text | area | enum | bool. `apply(next,
  // value)` writes the value into a body clone. Read shows the value (or a
  // "(빈칸)" affordance); clicking swaps in the same slot-edit card db-schema
  // slots use — one edit design language across doc types.
  function field(value, opts, apply) {
    const holder = el("span", { class: "fx" });
    function read() {
      if (active && active.revert === read) active = null;
      const shown =
        opts.kind === "bool"
          ? value
            ? "필수"
            : "선택"
          : (value ?? "") === ""
            ? opts.empty || "(빈칸)"
            : String(value);
      const empty = opts.kind !== "bool" && (value ?? "") === "";
      const cls =
        "fx-val" +
        (empty ? " empty" : "") +
        (opts.mono ? " mono" : "") +
        (opts.block ? " block" : "") +
        (canEdit ? " editable" : "");
      holder.replaceChildren(
        canEdit
          ? el("span", { class: cls, title: "클릭해서 편집", onclick: edit, text: shown })
          : el("span", { class: cls, text: shown }),
      );
    }
    function edit() {
      // Dirty guard — same rule as db-schema slots: a half-typed edit is never
      // dropped because another value was clicked; flash the open card instead.
      if (active && active.revert !== read) {
        if (active.dirty()) {
          active.flash();
          toast("저장하지 않은 편집이 있습니다 — 저장하거나 취소한 뒤 이동하세요.");
          return;
        }
        active.revert();
      }
      // enum: no card — the closed list unfolds in place as segment buttons
      // and picking one commits immediately (esc/취소 to back out).
      if (opts.kind === "enum") {
        const seg = el(
          "span",
          { class: "segedit" },
          opts.values.map((v) => {
            const b = el("button", {
              type: "button",
              class: v === value ? "on" : "",
              text: v,
            });
            b.addEventListener("click", async () => {
              if (v === value) return read();
              b.disabled = true;
              const ok = await commit((next) => apply(next, v));
              if (!ok) read();
            });
            return b;
          }),
        );
        const pick = el("span", { class: "segwrap" }, [
          seg,
          el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: read }),
        ]);
        pick.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            read();
          }
        });
        active = { revert: read, dirty: () => false, flash: () => {} };
        holder.replaceChildren(pick);
        seg.querySelector("button")?.focus();
        return;
      }
      let input;
      let getVal;
      const oldShown =
        opts.kind === "bool" ? (value ? "필수" : "선택") : String(value ?? "");
      if (opts.kind === "bool") {
        input = el("select", { class: "fld" });
        for (const [v, label] of [
          ["true", "필수"],
          ["false", "선택"],
        ]) {
          const o = el("option", { value: v, text: label });
          if ((v === "true") === !!value) o.selected = true;
          input.appendChild(o);
        }
        getVal = () => input.value === "true";
      } else {
        input = el(opts.kind === "area" ? "textarea" : "input", {
          class: "fld" + (opts.mono ? " mono" : ""),
          spellcheck: "false",
        });
        if (opts.kind !== "area") input.type = "text";
        input.value = value ?? "";
        getVal = () => input.value;
      }
      const newShown = () =>
        opts.kind === "bool" ? (getVal() ? "필수" : "선택") : String(getVal());
      const dirty = () => newShown() !== oldShown;
      const save = el("button", { type: "button", class: "btn primary sm", text: "저장" });
      save.addEventListener("click", async () => {
        save.disabled = true;
        const ok = await commit((next) => apply(next, getVal()));
        if (!ok) save.disabled = false;
      });
      // 저장 전 미리보기 — db-schema 와 같은 단어 diff.
      const diffBody = el("div", { class: "diffbody" });
      const refresh = () => {
        const changed = dirty();
        save.disabled = !changed;
        save.title = changed ? "" : "변경 없음";
        diffBody.replaceChildren();
        if (!changed) {
          diffBody.appendChild(el("span", { class: "dim", text: "아직 변경 없음" }));
          return;
        }
        const wd = el("span", { class: "wd" });
        for (const p of wordDiff(oldShown, newShown())) {
          if (p.t === "eq") wd.appendChild(document.createTextNode(`${p.w} `));
          else wd.appendChild(el("span", { class: p.t, text: `${p.w} ` }));
        }
        diffBody.appendChild(wd);
      };
      const grow = () => {
        if (opts.kind !== "area") return;
        input.style.height = "auto";
        input.style.height = `${input.scrollHeight}px`;
      };
      input.addEventListener("input", () => {
        grow();
        refresh();
      });
      input.addEventListener("change", refresh);
      const card = el("div", { class: "slot-edit" }, [
        input,
        el("div", { class: "editacts" }, [
          save,
          el("button", { type: "button", class: "btn ghost sm", onclick: read, text: "취소" }),
          el("span", { class: "kbd" }, [
            el("b", { text: "esc" }),
            " 취소 · ",
            el("b", { text: opts.kind === "area" ? "⌘/Ctrl+↵" : "↵" }),
            " 저장",
          ]),
        ]),
        el("details", { class: "diffbox" }, [
          el("summary", { text: "무엇이 바뀌나" }),
          diffBody,
        ]),
      ]);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          read();
        } else if (
          e.key === "Enter" &&
          (e.metaKey || e.ctrlKey || opts.kind !== "area")
        ) {
          e.preventDefault();
          if (!save.disabled) save.click();
        }
      });
      active = {
        revert: read,
        dirty,
        flash: () => {
          card.classList.remove("dirtyflash");
          void card.offsetWidth;
          card.classList.add("dirtyflash");
        },
      };
      holder.replaceChildren(card);
      refresh();
      grow();
      input.focus();
      // cursor at end, like the db-schema editor (text kinds only)
      if (opts.kind === "area" || opts.kind === undefined)
        input.setSelectionRange(input.value.length, input.value.length);
    }
    read();
    return holder;
  }

  // argument-hint is composed from inputs (the spec calls inputs "인자 계약의
  // 진실원") — {name} for required, [name] for optional. Every inputs mutation
  // recomputes it so the two can never drift.
  const composeHint = (inputs) =>
    (inputs || [])
      .map((p) => (p.required ? `{${p.name}}` : `[${p.name}]`))
      .join(" ");

  // The argument-hint row IS the inputs editor: one chip per parameter
  // ({name}/[name], tooltip = description), click a chip to edit it in place,
  // `+` to add — no separate section, the whole contract lives on one line.
  const paramsField = () => {
    const holder = el("span", { class: "fx" });
    function readRow() {
      if (active && active.revert === readRow) active = null;
      const row = el("span", { class: "chiprow" });
      (s.inputs || []).forEach((inp, i) => {
        const label = inp.required ? `{${inp.name}}` : `[${inp.name}]`;
        row.appendChild(
          canEdit
            ? el("button", {
                type: "button",
                class: "pchip",
                title: `${inp.description || ""} — 클릭해서 편집`,
                text: label,
                onclick: () => openEditor(i),
              })
            : el("span", { class: "pchip", title: inp.description || "", text: label }),
        );
      });
      if (!(s.inputs || []).length)
        row.appendChild(el("span", { class: "fx-val empty", text: "(입력 없음)" }));
      if (canEdit)
        row.appendChild(
          el("button", {
            type: "button",
            class: "btn ghost sm add-btn",
            title: "입력 파라미터 추가",
            text: "+",
            onclick: () => openEditor(-1),
          }),
        );
      holder.replaceChildren(row);
    }
    // i >= 0 edits that parameter, i === -1 adds a new one. Same card either
    // way: 이름/필수/설명 + 저장(확인)/취소(/삭제), committed as one body PUT.
    function openEditor(i) {
      if (active && active.revert !== readRow) {
        if (active.dirty()) {
          active.flash();
          toast("저장하지 않은 편집이 있습니다 — 저장하거나 취소한 뒤 이동하세요.");
          return;
        }
        active.revert();
      }
      const cur = i >= 0 ? s.inputs[i] : null;
      const name = el("input", {
        class: "fld mono",
        type: "text",
        spellcheck: "false",
        placeholder: "파라미터 이름 (예: snsr_id)",
      });
      if (cur) name.value = cur.name;
      const req = el("select", { class: "fld" }, [
        el("option", { value: "true", text: "필수" }),
        el("option", { value: "false", text: "선택" }),
      ]);
      if (cur && !cur.required) req.value = "false";
      const desc = el("textarea", {
        class: "fld",
        spellcheck: "false",
        placeholder: "설명 (예: 조회 키)",
      });
      if (cur) desc.value = cur.description || "";
      const growDesc = () => {
        desc.style.height = "auto";
        desc.style.height = `${desc.scrollHeight}px`;
      };
      desc.addEventListener("input", growDesc);
      const save = el("button", {
        type: "button",
        class: "btn primary sm",
        text: cur ? "저장" : "확인",
      });
      save.addEventListener("click", async () => {
        const nm = name.value.trim();
        if (!nm) {
          toast("파라미터 이름을 입력하세요.", "error");
          name.focus();
          return;
        }
        if (!desc.value.trim()) {
          toast("설명을 입력하세요.", "error");
          desc.focus();
          return;
        }
        save.disabled = true;
        const entry = {
          name: nm,
          required: req.value === "true",
          description: desc.value.trim(),
        };
        const done = await commit((n) => {
          if (!n.inputs) n.inputs = [];
          if (i >= 0) n.inputs[i] = entry;
          else n.inputs.push(entry);
          n.argumentHint = composeHint(n.inputs);
        });
        if (!done) save.disabled = false;
      });
      const acts = [
        save,
        el("button", { type: "button", class: "btn ghost sm", text: "취소", onclick: readRow }),
      ];
      if (cur) {
        const last = (s.inputs || []).length <= 1;
        const del = el("button", {
          type: "button",
          class: "btn danger sm",
          text: "삭제",
          title: last ? "마지막 입력은 삭제할 수 없습니다" : "",
          onclick: () =>
            commit((n) => {
              n.inputs.splice(i, 1);
              n.argumentHint = composeHint(n.inputs);
            }),
        });
        if (last) del.disabled = true;
        acts.push(del);
      }
      acts.push(
        el("span", { class: "kbd" }, [
          el("b", { text: "esc" }),
          " 취소 · ",
          el("b", { text: "⌘/Ctrl+↵" }),
          ` ${cur ? "저장" : "확인"}`,
        ]),
      );
      const card = el("div", { class: "slot-edit" }, [
        el("div", { class: "fieldlab", text: "이름 (name)" }),
        name,
        el("div", { class: "fieldlab", text: "필수 여부 (required)" }),
        req,
        el("div", { class: "fieldlab", text: "설명 (description)" }),
        desc,
        el("div", { class: "editacts" }, acts),
      ]);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          readRow();
        } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          if (!save.disabled) save.click();
        }
      });
      active = {
        revert: readRow,
        dirty: () =>
          cur
            ? name.value.trim() !== cur.name ||
              (req.value === "true") !== !!cur.required ||
              desc.value.trim() !== (cur.description || "")
            : name.value.trim() !== "" || desc.value.trim() !== "",
        flash: () => {
          card.classList.remove("dirtyflash");
          void card.offsetWidth;
          card.classList.add("dirtyflash");
        },
      };
      holder.replaceChildren(card);
      growDesc();
      name.focus();
    }
    readRow();
    return holder;
  };

  // optional scalar: clearing it removes the key (empty fails the schema's \S).
  const setOpt = (key) => (n, v) => {
    if (String(v).trim() === "") delete n[key];
    else n[key] = v;
  };
  // optional scalar nested in an array item: n[arr][i][key].
  const setOpt2 = (i, arr, key) => (n, v) => {
    if (String(v).trim() === "") delete n[arr][i][key];
    else n[arr][i][key] = v;
  };

  const wrap = el("div", { class: "skwrap" }, [
    el("p", { class: "sk-eyebrow", text: "domain-skill · 조회 절차 스킬" }),
    el("h1", { class: "sk-title", text: s.name }),
    el("p", { class: "sk-sub", text: (s.intro || "").split("\n")[0] }),
    el("div", { class: "sk-chips" }, [
      statusChip(),
      el("span", { class: "chip rev", text: `rev ${shortRev(rev)}` }),
      ...keywordChips(doc.keywords || []),
      onToggleJson
        ? el(
            "button",
            {
              type: "button",
              class: `btn ghost sm json-view${jsonOpen ? " on" : ""}`,
              "aria-pressed": jsonOpen ? "true" : "false",
              title: "문서를 좌우로 갈라 원본 store JSON 을 함께 봅니다(승인자 전용).",
              onclick: onToggleJson,
            },
            "JSON",
          )
        : null,
    ]),
    // db-schema 뷰와 같은 배너 — 비활성이 실제로 무엇을 의미하는지 본문 자리에서 설명.
    doc.status === "inactive"
      ? el("div", { class: "offbar" }, [
          el("b", { text: "비활성 문서입니다. " }),
          el("span", {
            text: "여기서는 그대로 읽을 수 있지만 미러로 나가지 않아 세션에 주입되지 않습니다. 주입 예산은 한 턴에 문서 2개뿐이므로, 상시 주입할 가치가 있을 때만 활성으로 바꾸세요.",
          }),
        ])
      : null,
  ]);

  // One chip does both jobs: shows the status (raw enum, uppercase) and — for
  // an approver — toggles it on click. The tooltip carries what the state
  // means AND what clicking will do, so no second button is needed.
  function statusChip() {
    const meaning =
      {
        active: "LLM 세션에 주입되는 문서입니다. 문서 단위 전역 스위치 — 모든 사용자에게 동일합니다.",
        inactive: "주입이 꺼진 문서입니다 — 대시보드에서 열람·편집만 됩니다.",
        archived: "폐기된 문서입니다 — 기록으로만 남습니다.",
      }[doc.status] ?? "";
    const nextHint =
      doc.status === "active"
        ? " 클릭하면 주입을 끕니다(INACTIVE)."
        : doc.status === "inactive"
          ? " 클릭하면 주입을 켭니다(ACTIVE)."
          : "";
    const label = (doc.status || "").toUpperCase();
    if (!onToggleStatus)
      return el("span", { class: `chip st-${doc.status}`, text: label, title: meaning });
    return el("button", {
      type: "button",
      class: `chip st-${doc.status} st-toggle`,
      text: label,
      title: meaning + nextHint,
      onclick: onToggleStatus,
    });
  }
  const sec = (title, addBtn) => {
    const h = el("h2", { class: "sk-h" }, [title]);
    if (addBtn) h.appendChild(addBtn);
    wrap.appendChild(h);
  };
  const addBtn = (label, onAdd) =>
    canEdit
      ? el("button", { type: "button", class: "btn ghost sm add-btn", onclick: () => commit(onAdd), text: label })
      : null;
  const delBtn = (canDel, onDel) =>
    canEdit && canDel
      ? el("button", { type: "button", class: "btn ghost sm del-btn", title: "삭제", onclick: () => commit(onDel), text: "✕" })
      : null;
  // help: 라벨 호버 시 이 필드가 무엇인지(스펙 §4.4의 정의) 설명한다.
  const drow = (label, node, help) =>
    el("div", { class: "drow" }, [
      el(
        "span",
        help
          ? { class: "dk has-help", text: label, title: help }
          : { class: "dk", text: label },
      ),
      el("span", { class: "dv" }, node),
    ]);

  // ── 기본 ──────────────────────────────────────────────────────────────
  sec("기본");
  wrap.appendChild(
    el("div", { class: "sk-def" }, [
      drow(
        "name",
        field(s.name, { mono: true }, (n, v) => (n.name = v)),
        "스킬 이름(kebab-case). 문서 id·SKILL.md 제목이 됩니다.",
      ),
      drow(
        "argument-hint",
        paramsField(),
        "스킬 호출 시 표시되는 인자 목록. {이름}=필수, [이름]=선택 — 칩을 클릭해 수정하고, +로 추가합니다.",
      ),
      drow(
        "단위",
        field(s.scope?.단위, { kind: "enum", values: ["설비", "챔버", "센서"] }, (n, v) => (n.scope.단위 = v)),
        "스킬이 다루는 대상의 단위. description 골격과 추적 방향을 정합니다.",
      ),
      drow(
        "카디널리티",
        field(s.scope?.카디널리티, { kind: "enum", values: ["단일"] }, (n, v) => (n.scope.카디널리티 = v)),
        "한 번에 다루는 대상 수 — 현재는 단일 조회만 지원합니다.",
      ),
      drow(
        "의도",
        field(s.scope?.의도, { kind: "enum", values: ["상태", "생성 이력"] }, (n, v) => (n.scope.의도 = v)),
        "질문의 성격 — 상태(지금 어떤가) / 생성 이력(어떻게 만들어졌나).",
      ),
      drow(
        "focus",
        field(s.focus, {}, (n, v) => (n.focus = v)),
        "이 스킬의 도메인 요약 한 줄. 라우팅용 description의 빈칸을 채웁니다 — 답이 나열할 목록이 아닙니다(그건 각 단계의 produces).",
      ),
      drow(
        "anchor-table",
        field(s.anchorTable, { mono: true }, setOpt("anchorTable")),
        "앵커 테이블(선택). 프롬프트에 이 테이블명이 등장하면 곧바로 이 스킬로 라우팅됩니다.",
      ),
      drow(
        "intro",
        field(s.intro, { kind: "area" }, (n, v) => (n.intro = v)),
        "도메인 주의사항 도입부. 실행 프레이밍 문장은 렌더러가 고정으로 붙이므로 도메인 이야기만 씁니다. 첫 줄이 화면 상단 부제로 노출됩니다.",
      ),
      drow(
        "discipline",
        field(s.discipline, { kind: "area" }, setOpt("discipline")),
        "실행 규율(선택). 비워 두면 렌더러의 고정 규율 블록이 들어갑니다.",
      ),
    ]),
  );

  // ── 조회 절차 ─────────────────────────────────────────────────────────
  // A procedure is a numbered flow, not a key:value dump — the layout says
  // so: rail number + title/→produces header, SQL as a code block, branches
  // as when → then rows, lead/notes as secondary lines.
  sec(
    "조회 절차",
    addBtn("+ 단계 추가", (n) => n.steps.push({ title: "새 단계", sql: "SELECT 1" })),
  );
  const stepsWrap = el("div", { class: "sk-steps" });
  (s.steps || []).forEach((st, i) => {
    const branches = el("div", { class: "sk-branches" });
    (st.branches || []).forEach((br, j) => {
      branches.appendChild(
        el("div", { class: "sk-branch" }, [
          el("span", { class: "br-when" }, [
            field(br.when, { mono: true }, (n, v) => (n.steps[i].branches[j].when = v)),
          ]),
          el("span", { class: "br-arrow", text: "→" }),
          el("span", { class: "br-then" }, [
            field(br.then, { kind: "area" }, (n, v) => (n.steps[i].branches[j].then = v)),
          ]),
          delBtn(true, (n) => {
            n.steps[i].branches.splice(j, 1);
            if (n.steps[i].branches.length === 0) delete n.steps[i].branches;
          }),
        ]),
      );
    });
    const addBranch = addBtn("+ 분기", (n) => {
      if (!n.steps[i].branches) n.steps[i].branches = [];
      n.steps[i].branches.push({ when: "조건", then: "동작" });
    });
    if (addBranch) branches.appendChild(addBranch);
    const showBranches = (st.branches || []).length > 0 || canEdit;
    stepsWrap.appendChild(
      el("div", { class: "sk-step" }, [
        el("div", { class: "sk-step-rail" }, [
          el("span", { class: "sk-step-num", text: String(i + 1) }),
        ]),
        el("div", { class: "sk-step-body" }, [
          el("div", { class: "sk-step-h" }, [
            el("span", { class: "sk-step-title" }, [
              field(st.title, {}, (n, v) => (n.steps[i].title = v)),
            ]),
            el("span", { class: "sk-produces" }, [
              el("span", { class: "sk-produces-arrow", text: "→ " }),
              field(st.produces, { empty: "(produces)" }, setOpt2(i, "steps", "produces")),
            ]),
            el("span", { class: "mla" }),
            delBtn((s.steps || []).length > 1, (n) => n.steps.splice(i, 1)),
          ]),
          st.lead || canEdit
            ? el("div", { class: "sk-lead" }, [
                field(st.lead, { empty: "(lead — 실행 전 안내 한 줄)" }, setOpt2(i, "steps", "lead")),
              ])
            : null,
          el("div", { class: "sqlblock" }, [
            field(st.sql, { kind: "area", mono: true, block: true }, (n, v) => (n.steps[i].sql = v)),
          ]),
          showBranches ? branches : null,
          st.notes || canEdit
            ? el("div", { class: "sk-notes" }, [
                field(st.notes, { kind: "area", empty: "(notes)" }, setOpt2(i, "steps", "notes")),
              ])
            : null,
        ]),
      ]),
    );
  });
  wrap.appendChild(stepsWrap);

  // ── 출력 ──────────────────────────────────────────────────────────────
  sec("출력");
  wrap.appendChild(
    el("h3", { class: "sk-h3" }, [
      "하지 말 것 (avoid)",
      addBtn("+ 추가", (n) => n.output.avoid.push("끌리는 오추론 예시 — 그걸 금하는 데이터 사실")),
    ]),
  );
  const avoidWrap = el("div", { class: "sk-list" });
  (s.output?.avoid || []).forEach((a, i) => {
    avoidWrap.appendChild(
      el("div", { class: "sk-li" }, [
        field(a, {}, (n, v) => (n.output.avoid[i] = v)),
        delBtn((s.output?.avoid || []).length > 3, (n) => n.output.avoid.splice(i, 1)),
      ]),
    );
  });
  wrap.appendChild(avoidWrap);

  wrap.appendChild(
    el("h3", { class: "sk-h3" }, [
      "예시 (examples)",
      addBtn("+ 예시 추가", (n) => n.output.examples.push({ ask: "질문 예시", answer: "답변 예시" })),
    ]),
  );
  const exWrap = el("div", {});
  (s.output?.examples || []).forEach((ex, i) => {
    exWrap.appendChild(
      el("div", { class: "sk-item" }, [
        el("div", { class: "sk-item-h" }, [
          el("span", { class: "sk-item-n", text: `예시 ${i + 1}` }),
          el("span", { class: "mla" }),
          delBtn((s.output?.examples || []).length > 2, (n) => n.output.examples.splice(i, 1)),
        ]),
        el("div", { class: "sk-def" }, [
          drow("ask", field(ex.ask, {}, (n, v) => (n.output.examples[i].ask = v))),
          drow("answer", field(ex.answer, { kind: "area" }, (n, v) => (n.output.examples[i].answer = v))),
        ]),
      ]),
    );
  });
  wrap.appendChild(exWrap);

  // ── 의존성 ────────────────────────────────────────────────────────────
  // Read-only by design (사용자 결정 2026-07-22): the JSON keeps carrying
  // dependencies, but they change when the procedure changes — hand-editing
  // them here would only let the two drift apart. Placed last: metadata for
  // the machine, not something a reader of the procedure needs first.
  sec("의존성");
  const depsWrap = el("div", { class: "dep-list" });
  (s.dependencies || []).forEach((dep) => {
    depsWrap.appendChild(
      el("div", { class: "dep-card" }, [
        el("div", { class: "dep-mcp" }, [
          el("span", { class: "dep-kind", text: "MCP" }),
          dep.mcp,
        ]),
        (dep.tools || []).length
          ? el(
              "div",
              { class: "dep-tools" },
              (dep.tools || []).map((t) => el("span", { class: "toolchip", text: t })),
            )
          : null,
        dep.why ? el("div", { class: "dep-why", text: dep.why }) : null,
      ]),
    );
  });
  wrap.appendChild(depsWrap);

  // 설치 — curl 원커맨드 하나만 안내한다(#39). 구 방식(브라우저 다운로드 후
  // mv ~/Downloads/…)은 다운로드 폴더가 사람마다 달라(브라우저 설정, 한글 로케일
  // XDG = ~/다운로드, "매번 묻기") mv 가 추측이 됐다. curl 은 서버의 raw md
  // 엔드포인트(?format=md)를 직접 받으므로 출발지 추측이 없다. 목적지는
  // ~/.claude/skills 고정 안내(CC·opencode 공통 탐색 경로, install-skills.mjs 와
  // 동일) — 다른 경로를 쓰는 사람은 명령의 경로만 바꾼다(분기 없음).
  // AKG_ANON_READ=0 배포에서는 Authorization 헤더가 필요하므로 힌트 한 줄을
  // 함께 보인다 — 실토큰은 절대 카피 텍스트에 넣지 않는다($AKG_TOKEN 참조만).
  let installAside = null;
  if (md) {
    const dest = `~/.claude/skills/${s.name}`;
    const installCmd =
      `mkdir -p ${dest}\n` +
      `curl -fsS "${location.origin}/api/docs/domain-skill/${encodeURIComponent(doc.id)}?format=md" \\\n` +
      `  -o ${dest}/SKILL.md`;
    installAside = el("aside", { class: "sk-aside" }, [
      el("div", { class: "sk-install" }, [
        el("div", { class: "sk-install-top" }, [
          el("h2", { class: "sk-h", text: "설치" }),
        ]),
        el("p", { class: "dim install-lead" }, [
          "아래 명령 하나로 설치합니다 — Claude Code·opencode 모두 ",
          el("code", { text: "~/.claude/skills" }),
          " 를 읽습니다. 다른 경로를 쓰면 그 부분만 바꾸세요.",
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
        el("p", { class: "dim install-note" }, [
          "토큰이 필요한 서버면 curl 에 ",
          el("code", { text: '-H "Authorization: Bearer $AKG_TOKEN"' }),
          " 을 추가하세요.",
        ]),
        el("p", {
          class: "dim",
          text: "설치 후 새 세션(또는 스킬 새로고침)부터 이 스킬을 쓸 수 있습니다.",
        }),
      ]),
    ]);
  }

  // 본문(좌) + 설치 패널(우) — 스크롤 끝이 아니라 본문 오른쪽 빈 공간에 상시
  // 보인다(#39). 패널이 없으면(el 이 null 을 걸러) 본문이 그대로 한 폭을 쓴다.
  return el("div", { class: "sk-layout" }, [wrap, installAside]);
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
