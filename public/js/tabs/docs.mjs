import { api } from "../api.mjs";
import { $, el } from "../dom.mjs";
import { deriveDraftId, draftsOfType, renderTreeActions } from "../drafts.mjs";
import { openDoc } from "../router.mjs";
import { DOC_TYPES, TYPE_LABEL, lastDoc, typeInfo } from "../state.mjs";

const TREE_FOLD_KEY = "akg_tree_closed";
function closedGroups() {
  try {
    return new Set(JSON.parse(localStorage.getItem(TREE_FOLD_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function setGroupClosed(type, closed) {
  const set = closedGroups();
  if (closed) set.add(type);
  else set.delete(type);
  try {
    localStorage.setItem(TREE_FOLD_KEY, JSON.stringify([...set]));
  } catch {
    /* storage off: the fold lasts until the next draw */
  }
}

export async function renderDocTree() {
  if (!$("doc-tree")) return 0;
  renderTreeActions();
  const tree = $("doc-tree");
  tree.replaceChildren();
  let pendingTotal = 0;
  const pool = [];
  for (const type of DOC_TYPES) {
    const res = await api(`/api/docs?type=${type}`);
    // Inactive documents belong in the tree: they are readable by design and
    // invisible ones cannot be reviewed, let alone activated. Archived stays
    // hidden — that one is a decision to stop carrying the document.
    const docs = (res.ok ? res.data.docs : []).filter(
      (d) => d.status !== "archived",
    );
    pool.push(...docs.map((d) => ({ ...d, type })));
    // Local drafts (started but not saved) show in the tree immediately —
    // titled "(빈 문서)", "(빈 문서2)"… as they pile up — so every just-added
    // document is visible before it ever reaches the server. Named ones show
    // their name; the "(빈 문서N)" numbering counts only the still-unnamed ones.
    let unnamed = 0;
    const draftItems = draftsOfType(type).map((d) => {
      const did = deriveDraftId(type, d.body);
      let label;
      if (did) {
        label = did;
      } else {
        unnamed += 1;
        label = unnamed === 1 ? "(빈 문서)" : `(빈 문서${unnamed})`;
      }
      return el(
        "button",
        {
          type: "button",
          class: "doc-item draft-item",
          "data-draft-id": d.localId,
          onclick: () => (location.hash = `#/draft/${type}/${d.localId}`),
        },
        [
          el("span", { class: `nm${did ? "" : " untitled"}`, text: label }),
          el("span", { class: "mini" }, [
            el("span", { class: "mini-draft", text: "드래프트" }),
          ]),
        ],
      );
    });
    for (const d of docs) pendingTotal += d.tiers.inferred || 0;
    const docItem = (d, sub = false) =>
      el(
        "button",
        {
          type: "button",
          class: `doc-item${d.status === "inactive" ? " off" : ""}${sub ? " sub-item" : ""}`,
          "data-type": type,
          "data-id": d.id,
          onclick: () => openDoc(type, d.id),
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
    const items = el(
      "div",
      { class: "grp-items" },
      draftItems.concat(type === "domain-skill" ? skillTree(docs, docItem) : docs.map((d) => docItem(d))),
    );
    const off = typeInfo(type)?.status === "archived" ? " type-off" : "";
    const grp = el("div", { class: `${closedGroups().has(type) ? "grp closed" : "grp"}${off}` }, [
      el(
        "button",
        {
          type: "button",
          class: "grp-h",
          onclick: (e) => {
            const closed = e.currentTarget.closest(".grp").classList.toggle("closed");
            setGroupClosed(type, closed);
          },
        },
        [
          el("span", { class: "chev", text: "▾" }),
          ` ${TYPE_LABEL[type] ?? type} `,
          el("span", { class: "cnt", text: String(docs.length) }),
        ],
      ),
      items,
    ]);
    tree.appendChild(grp);
  }
  searchPool = pool;
  highlightTree();
  runSearch();
  return pendingTotal;
}
// domain-skill: each main, then the subs its links point at, indented. A sub
// two mains point at shows under both; a sub no main points at goes under
// 연결 없음 at the end.
export function skillTree(docs, docItem) {
  const subs = new Map(docs.filter((d) => d.role === "sub").map((d) => [d.id, d]));
  const reached = new Set();
  const out = [];
  for (const m of docs.filter((d) => d.role !== "sub")) {
    out.push(docItem(m));
    for (const l of m.links || []) {
      const sub = l.type === "domain-skill" ? subs.get(l.id) : null;
      if (!sub) continue;
      reached.add(sub.id);
      out.push(docItem(sub, true));
    }
  }
  const orphans = [...subs.values()].filter((d) => !reached.has(d.id));
  if (orphans.length)
    out.push(
      el("div", { class: "tree-note", text: "연결 없음" }),
      ...orphans.map((d) => docItem(d, true)),
    );
  return out;
}
export function highlightTree() {
  if (!$("doc-tree")) return;
  highlightResults();
  const draftHash = location.hash.match(/^#\/draft\/[\w-]+\/([\w-]+)/);
  for (const b of $("doc-tree").querySelectorAll(".doc-item")) {
    if (b.classList.contains("draft-item")) {
      b.classList.toggle(
        "on",
        !!draftHash && b.dataset.draftId === draftHash[1],
      );
      continue;
    }
    b.classList.toggle(
      "on",
      lastDoc && b.dataset.type === lastDoc.type && b.dataset.id === lastDoc.id,
    );
  }
}

// ---------- 문서 찾기 (사람용, 브라우저에서 거름) ----------
// The tree's own list envelopes are the corpus: no request per keystroke.
// While there is a query, results replace the tree, grouped by type.
export let searchPool = [];
export const searchState = { q: "" };
export const searchLib = import("/lib/search.mjs").catch(() => null);

export async function runSearch() {
  const lib = await searchLib;
  const out = $("search-results");
  const active = searchState.q.trim() !== "";
  $("doc-tree").hidden = active;
  out.hidden = !active;
  if (!active) return;
  if (!lib) {
    out.replaceChildren(el("p", { class: "dim search-empty", text: "검색을 불러오지 못했습니다." }));
    return;
  }
  const groups = lib.searchDocs(searchPool, { q: searchState.q, order: DOC_TYPES });
  out.replaceChildren(
    ...(groups.length
      ? groups.map((g) =>
          el("div", { class: "grp" }, [
            el("div", { class: "grp-h" }, [` ${TYPE_LABEL[g.type]} `, el("span", { class: "cnt", text: String(g.docs.length) })]),
            el(
              "div",
              { class: "grp-items" },
              g.docs.map((d) =>
                el(
                  "button",
                  {
                    type: "button",
                    class: d.status === "inactive" ? "doc-item off" : "doc-item",
                    "data-type": g.type,
                    "data-id": d.id,
                    onclick: () => openDoc(g.type, d.id),
                  },
                  [
                    el("span", { class: "nm", text: d.id }),
                    d.title && d.title.toLowerCase() !== d.id
                      ? el("span", { class: "search-title", text: d.title })
                      : null,
                  ],
                ),
              ),
            ),
          ]),
        )
      : [el("p", { class: "dim search-empty", text: "찾는 문서가 없습니다." })]),
  );
  highlightResults();
}
export function highlightResults() {
  if (!$("search-results")) return;
  for (const b of $("search-results").querySelectorAll(".doc-item"))
    b.classList.toggle("on", !!lastDoc && b.dataset.type === lastDoc.type && b.dataset.id === lastDoc.id);
}
/** The left tree panel's parts: search · results · tree · 새 문서. */
export function treeParts() {
  const input = el("input", {
    id: "search-input",
    type: "search",
    placeholder: "문서 찾기 — id · 키워드 · 제목",
    "aria-label": "문서 찾기",
    autocomplete: "off",
  });
  input.addEventListener("input", (e) => {
    searchState.q = e.currentTarget.value;
    runSearch();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.currentTarget.value) {
      e.currentTarget.value = "";
      searchState.q = "";
      runSearch();
    }
  });
  return [
    el("div", { id: "doc-search" }, input),
    el("div", { id: "search-results", hidden: true }),
    el("div", { id: "doc-tree" }),
    el("div", { id: "tree-actions" }),
  ];
}
