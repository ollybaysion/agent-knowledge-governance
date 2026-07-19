// Dashboard SPA — vanilla JS, no build step, no inline handlers (CSP
// script-src 'self'). All dynamic strings go through textContent, never
// innerHTML, so a malicious doc body can't inject markup into the page.
"use strict";

const TOKEN_KEY = "akg_token";
let currentUser = null; // {id, role} from /api/me

// ---------- tiny DOM helper ----------
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

// ---------- API client ----------
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(t) {
  localStorage.setItem(TOKEN_KEY, t);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

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
    /* fail-soft: some responses (304, md text) have no JSON body */
  }
  return {
    ok: res.ok,
    status: res.status,
    etag: res.headers.get("etag"),
    data,
  };
}

// ---------- slot address helpers (mirrors server/slots.mjs parsing) ----------
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

// ---------- shell ----------
const appRoot = document.getElementById("app");
const loginSection = document.getElementById("login");
const whoEl = document.getElementById("who");

function showLogin(message) {
  document.getElementById("topbar").hidden = true;
  appRoot.hidden = true;
  loginSection.hidden = false;
  document.getElementById("login-error").textContent = message || "";
}

function showApp() {
  document.getElementById("topbar").hidden = false;
  appRoot.hidden = false;
  loginSection.hidden = true;
}

function renderWho() {
  whoEl.replaceChildren(
    el("span", { text: `${currentUser.id} (${currentUser.role})` }),
    el("button", { type: "button", onclick: doLogout, text: "로그아웃" }),
  );
}

function doLogout() {
  clearToken();
  currentUser = null;
  location.hash = "";
  showLogin();
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
  renderWho();
  showApp();
  return true;
}

document.getElementById("token-submit").addEventListener("click", async () => {
  const val = document.getElementById("token-input").value.trim();
  if (!val) return;
  const ok = await tryLogin(val);
  if (ok) route();
});

// ---------- routing ----------
const SCREENS = ["corpus", "queue", "audit"];
for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    location.hash = `#/${btn.dataset.screen}`;
  });
}
window.addEventListener("hashchange", route);

function setActiveTab(screen) {
  for (const btn of document.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.screen === screen);
  }
}

function route() {
  if (!currentUser) return;
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "doc" && parts[1] && parts[2]) {
    setActiveTab(null);
    renderDocScreen(parts[1], decodeURIComponent(parts[2]));
    return;
  }
  const screen = SCREENS.includes(parts[0]) ? parts[0] : "corpus";
  setActiveTab(screen);
  if (screen === "corpus") renderCorpusScreen();
  else if (screen === "queue") renderQueueScreen();
  else if (screen === "audit") renderAuditScreen();
}

// ---------- tier badges ----------
function tierBadges(tiers) {
  return el(
    "span",
    {},
    ["scaffold", "inferred", "confirmed", "deprecated"].map((t) =>
      el("span", {
        class: `tier-badge tier-${t}`,
        text: `${t}:${tiers[t] ?? 0}`,
      }),
    ),
  );
}

// ================= Screen 1: 코퍼스 =================
const DOC_TYPES = ["db-schema", "msg-format", "domain-skill"];

async function renderCorpusScreen() {
  const container = el("div", {});
  const typeTabs = el(
    "nav",
    { class: "tab-row" },
    DOC_TYPES.map((t) =>
      el(
        "button",
        { type: "button", class: "tab", onclick: () => loadCorpus(t) },
        t,
      ),
    ),
  );
  const searchInput = el("input", { type: "search", placeholder: "id 검색" });
  const results = el("div", { id: "corpus-results" }, "불러오는 중…");
  container.append(
    el("h1", { text: "코퍼스" }),
    typeTabs,
    searchInput,
    results,
  );
  appRoot.replaceChildren(container);

  let activeType = DOC_TYPES[0];
  async function loadCorpus(type) {
    activeType = type;
    for (const b of typeTabs.querySelectorAll(".tab"))
      b.classList.toggle("active", b.textContent === type);
    await refresh();
  }
  async function refresh() {
    const q = searchInput.value.trim();
    const res = await api(
      `/api/docs?type=${encodeURIComponent(activeType)}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    );
    if (!res.ok) {
      results.replaceChildren(
        el("p", {
          class: "error",
          text: `목록을 불러오지 못했습니다 (${res.status})`,
        }),
      );
      return;
    }
    if (res.data.docs.length === 0) {
      results.replaceChildren(el("p", { text: "문서가 없습니다." }));
      return;
    }
    const table = el("table", {}, [
      el(
        "thead",
        {},
        el("tr", {}, [
          el("th", { text: "id" }),
          el("th", { text: "상태" }),
          el("th", { text: "티어" }),
        ]),
      ),
      el(
        "tbody",
        {},
        res.data.docs.map((d) =>
          el(
            "tr",
            {
              class: "doc-row",
              onclick: () =>
                (location.hash = `#/doc/${d.type}/${encodeURIComponent(d.id)}`),
            },
            [
              el("td", { text: d.id }),
              el("td", { text: d.status }),
              el("td", {}, tierBadges(d.tiers)),
            ],
          ),
        ),
      ),
    ]);
    results.replaceChildren(table);
  }
  searchInput.addEventListener("input", () => refresh());
  await loadCorpus(activeType);
}

// ================= Screen 2: 문서 =================
async function renderDocScreen(type, id) {
  appRoot.replaceChildren(el("p", { text: "불러오는 중…" }));
  const res = await api(`/api/docs/${type}/${encodeURIComponent(id)}`);
  if (!res.ok) {
    appRoot.replaceChildren(
      el("p", {
        class: "error",
        text: `문서를 불러오지 못했습니다 (${res.status})`,
      }),
    );
    return;
  }
  let { json: doc, md, rev, slots } = res.data;

  const backBtn = el("button", {
    type: "button",
    onclick: () => (location.hash = "#/corpus"),
    text: "← 코퍼스로",
  });
  const title = el("h1", { text: `${type}/${id}` });
  const notice = el("div", { id: "doc-notice" });
  const mdPreview = el("pre", { class: "md-preview", text: md || "" });

  const editorList = el("div", { id: "slot-editors" });
  const canApprove = currentUser.role === "approver";
  const canEdit =
    currentUser.role === "editor" || currentUser.role === "approver";

  const inputsByAddress = {};
  for (const slot of slots) {
    const textArea = el("textarea", { text: slot.text ?? "" });
    const evidenceInput = el("input", {
      type: "text",
      value: (slot.evidence || []).join("; "),
      placeholder: "근거 (세미콜론 구분)",
    });
    inputsByAddress[slot.address] = { textArea, evidenceInput };

    const buttons = [];
    if (canApprove && slot.tier === "inferred") {
      buttons.push(
        el("button", {
          type: "button",
          onclick: () => promoteSlot(slot.address),
          text: "승격",
        }),
      );
    }
    if (canEdit && (slot.tier === "inferred" || slot.tier === "confirmed")) {
      buttons.push(
        el("button", {
          type: "button",
          onclick: () => deprecateSlot(slot.address),
          text: "폐기",
        }),
      );
    }

    editorList.append(
      el("div", { class: "slot-editor" }, [
        el("strong", { text: slot.address }),
        el("span", {
          class: `tier-badge tier-${slot.tier}`,
          text: ` ${slot.tier}`,
        }),
        textArea,
        evidenceInput,
        el("div", {}, buttons),
      ]),
    );
  }

  const saveBtn = canEdit
    ? el("button", { type: "button", onclick: saveEdit, text: "저장" })
    : null;

  appRoot.replaceChildren(
    el("div", {}, [
      backBtn,
      title,
      notice,
      el("div", { class: "doc-layout" }, [
        el("div", {}, [el("h2", { text: "렌더된 md" }), mdPreview]),
        el("div", {}, [el("h2", { text: "슬롯 편집" }), editorList, saveBtn]),
      ]),
    ]),
  );

  async function reload() {
    const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}`);
    if (r.ok) {
      doc = r.data.json;
      md = r.data.md;
      rev = r.data.rev;
      slots = r.data.slots;
    }
    renderDocScreen(type, id);
  }

  async function saveEdit() {
    const clientBody = structuredClone(doc.body);
    for (const [address, inputs] of Object.entries(inputsByAddress)) {
      const text = inputs.textArea.value.trim();
      const evidence = inputs.evidenceInput.value
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      const existing = getSlot(clientBody, address) || {};
      setSlot(clientBody, address, {
        text: text || null,
        tier: existing.tier,
        evidence,
      });
    }
    const res2 = await api(`/api/docs/${type}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "if-match": rev },
      body: clientBody,
    });
    if (res2.status === 409) {
      notice.replaceChildren(
        el("div", { class: "notice" }, [
          el("strong", {
            text: "충돌 — 다른 사용자가 같은 슬롯을 먼저 고쳤습니다: ",
          }),
          el("span", { text: (res2.data.overlap || []).join(", ") }),
          el("button", {
            type: "button",
            onclick: reload,
            text: "다시 불러오기",
          }),
        ]),
      );
      return;
    }
    if (!res2.ok) {
      notice.replaceChildren(
        el("p", { class: "error", text: `저장 실패 (${res2.status})` }),
      );
      return;
    }
    await reload();
  }

  async function promoteSlot(address) {
    const r = await api(`/api/docs/${type}/${encodeURIComponent(id)}/promote`, {
      method: "POST",
      headers: { "if-match": rev },
      body: { slots: [address] },
    });
    if (!r.ok) {
      notice.replaceChildren(
        el("p", {
          class: "error",
          text: `승격 실패 (${r.status}): ${JSON.stringify(r.data)}`,
        }),
      );
      return;
    }
    await reload();
  }

  async function deprecateSlot(address) {
    const r = await api(
      `/api/docs/${type}/${encodeURIComponent(id)}/deprecate`,
      {
        method: "POST",
        headers: { "if-match": rev },
        body: { slots: [address] },
      },
    );
    if (!r.ok) {
      notice.replaceChildren(
        el("p", {
          class: "error",
          text: `폐기 실패 (${r.status}): ${JSON.stringify(r.data)}`,
        }),
      );
      return;
    }
    await reload();
  }
}

// ================= Screen 3: 검토 대기열 =================
async function renderQueueScreen() {
  const container = el("div", {}, [el("h1", { text: "검토 대기열" })]);
  appRoot.replaceChildren(container);

  // --- pending proposals ---
  const proposalsSection = el("section", {}, [
    el("h2", { text: "제안 (pending)" }),
    el("p", { text: "불러오는 중…" }),
  ]);
  container.appendChild(proposalsSection);
  const propRes = await api("/api/proposals?state=pending");
  if (propRes.status === 403) {
    proposalsSection.replaceChildren(
      el("h2", { text: "제안 (pending)" }),
      el("p", { text: "editor 이상만 볼 수 있습니다." }),
    );
  } else if (!propRes.ok) {
    proposalsSection.replaceChildren(
      el("h2", { text: "제안 (pending)" }),
      el("p", { class: "error", text: `불러오기 실패 (${propRes.status})` }),
    );
  } else if (propRes.data.proposals.length === 0) {
    proposalsSection.replaceChildren(
      el("h2", { text: "제안 (pending)" }),
      el("p", { text: "대기 중인 제안이 없습니다." }),
    );
  } else {
    const list = el("div", {});
    for (const p of propRes.data.proposals) {
      const slotLines = Object.entries(p.slots).map(([addr, v]) =>
        el("div", {}, `${addr}: ${v.text} [${(v.evidence || []).join("; ")}]`),
      );
      const row = el("div", { class: "slot-editor" }, [
        el("strong", { text: `${p.type}/${p.docId}` }),
        el("span", { text: ` — ${p.submittedBy}, ${p.createdAt}` }),
        el("div", {}, slotLines),
        el("div", {}, [
          el("button", {
            type: "button",
            onclick: () => adopt(p),
            text: "채택",
          }),
          el("button", {
            type: "button",
            onclick: () => reject(p),
            text: "기각",
          }),
        ]),
      ]);
      list.appendChild(row);
    }
    proposalsSection.replaceChildren(
      el("h2", { text: "제안 (pending)" }),
      list,
    );
  }

  async function adopt(p) {
    const docRes = await api(
      `/api/docs/${p.type}/${encodeURIComponent(p.docId)}`,
    );
    if (!docRes.ok) return;
    const r = await api(`/api/proposals/${p.id}/adopt`, {
      method: "POST",
      headers: { "if-match": docRes.data.rev },
      body: {},
    });
    if (r.ok) renderQueueScreen();
  }
  async function reject(p) {
    const r = await api(`/api/proposals/${p.id}/reject`, {
      method: "POST",
      body: {},
    });
    if (r.ok) renderQueueScreen();
  }

  // --- slot lists by tier (inferred = review queue, deprecated = orphan/withdrawn) ---
  async function slotSection(title, tier) {
    const section = el("section", {}, [
      el("h2", { text: title }),
      el("p", { text: "불러오는 중…" }),
    ]);
    container.appendChild(section);
    const rows = [];
    for (const type of DOC_TYPES) {
      const listRes = await api(`/api/docs?type=${type}&tier=${tier}`);
      if (!listRes.ok) continue;
      for (const d of listRes.data.docs) {
        const detail = await api(
          `/api/docs/${type}/${encodeURIComponent(d.id)}`,
        );
        if (!detail.ok) continue;
        for (const slot of detail.data.slots.filter((s) => s.tier === tier)) {
          rows.push(
            el("div", { class: "slot-editor" }, [
              el("a", {
                href: `#/doc/${type}/${encodeURIComponent(d.id)}`,
                text: `${type}/${d.id} — ${slot.address}`,
              }),
              el("div", { text: slot.text || "" }),
            ]),
          );
        }
      }
    }
    section.replaceChildren(
      el("h2", { text: title }),
      rows.length ? el("div", {}, rows) : el("p", { text: "없습니다." }),
    );
  }
  await slotSection("추정 슬롯 (승격 대기)", "inferred");
  await slotSection("폐기된 슬롯", "deprecated");
}

// ================= Screen 4: 감사 =================
async function renderAuditScreen() {
  const docInput = el("input", { type: "text", placeholder: "type/id (선택)" });
  const windowSelect = el("select", {}, [
    el("option", { value: "", text: "전체 기간" }),
    el("option", { value: "24h", text: "최근 24시간" }),
    el("option", { value: "7d", text: "최근 7일" }),
    el("option", { value: "4w", text: "최근 4주" }),
  ]);
  const goBtn = el("button", {
    type: "button",
    onclick: () => load(),
    text: "조회",
  });
  const results = el("div", { id: "audit-results" });
  appRoot.replaceChildren(
    el("div", {}, [
      el("h1", { text: "감사" }),
      docInput,
      windowSelect,
      goBtn,
      results,
    ]),
  );

  async function load() {
    const params = new URLSearchParams();
    if (docInput.value.trim()) params.set("doc", docInput.value.trim());
    if (windowSelect.value) params.set("window", windowSelect.value);
    const res = await api(`/api/audit?${params.toString()}`);
    if (!res.ok) {
      results.replaceChildren(
        el("p", { class: "error", text: `조회 실패 (${res.status})` }),
      );
      return;
    }
    if (res.data.entries.length === 0) {
      results.replaceChildren(el("p", { text: "기록이 없습니다." }));
      return;
    }
    const table = el("table", {}, [
      el(
        "thead",
        {},
        el("tr", {}, [
          el("th", { text: "rev" }),
          el("th", { text: "작성자" }),
          el("th", { text: "시각" }),
          el("th", { text: "메시지" }),
        ]),
      ),
      el(
        "tbody",
        {},
        res.data.entries.map((e) =>
          el("tr", {}, [
            el("td", { text: (e.rev || "").slice(0, 8) }),
            el("td", { text: e.author }),
            el("td", { text: e.at }),
            el("td", { text: e.message }),
          ]),
        ),
      ),
    ]);
    results.replaceChildren(table);
  }
  await load();
}

// ---------- boot ----------
(async function boot() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }
  const ok = await tryLogin(token);
  if (ok) route();
})();
