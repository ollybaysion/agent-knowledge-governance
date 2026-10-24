// Hash routes → screens. The hash alone moves around inside the page, so the
// address's ?embed · ?from · ?section stay as they are on every move.
import { $, el } from "./dom.mjs";
import { cols, panel, screen, setActiveTab, setCrumbs } from "./shell.mjs";
import { currentUser, lastDoc, setLastDoc } from "./state.mjs";
import { renderOverview } from "./tabs/overview.mjs";
import { renderDocScreen } from "./tabs/doc-view.mjs";
import { renderGraph } from "./tabs/graph.mjs";
import { renderQueue } from "./tabs/review.mjs";
import { renderAudit } from "./tabs/audit.mjs";
import { renderDraftScreen } from "./drafts.mjs";
import { renderDocTree, treeParts } from "./tabs/docs.mjs";

// A screen with unsaved work sets a guard: the message to confirm before
// leaving, or null when there is nothing to lose.
let guard = null;
let current = location.hash;
export function setLeaveGuard(fn) {
  guard = fn;
}
window.addEventListener("hashchange", () => {
  const msg = guard?.();
  if (msg && !confirm(msg)) {
    history.replaceState(null, "", current);
    return;
  }
  guard = null;
  current = location.hash;
  route();
});
window.addEventListener("beforeunload", (e) => {
  if (guard?.()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/** The hash parts, each decoded: #/doc/db-schema/fdc_x → ["doc", "db-schema", "fdc_x"]. */
export function hashParts(hash = location.hash) {
  return hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}
export const docHash = (type, id) => `#/doc/${type}/${encodeURIComponent(id)}`;
export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/** A doc picked from a list opens its screen — or, on the graph, becomes its selection. */
export function openDoc(type, id) {
  const onGraph = document.body.dataset.tab === "graph";
  location.hash = onGraph ? `#/graph/${type}/${encodeURIComponent(id)}` : docHash(type, id);
}

function wide(tab, crumbs, id) {
  setActiveTab(tab);
  setCrumbs(crumbs);
  const main = el("main", { class: "main wide" }, el("section", { id, class: "on" }));
  screen().appendChild(cols({ main, className: "wide" }));
}

function withTree(tab, id) {
  setActiveTab(tab);
  const main = el("main", { class: "main" }, el("section", { id, class: "on" }));
  screen().appendChild(cols({ left: panel("left tree-panel", treeParts(), "문서 트리"), main }));
  renderDocTree();
}

export function route() {
  if (!currentUser) return;
  const parts = hashParts();
  window.scrollTo(0, 0);
  if (parts[0] === "doc" && parts[1] && parts[2]) {
    withTree("docs", "doc");
    setCrumbs([{ label: "문서", href: "#/docs" }, { label: parts[2] }]);
    renderDocScreen(parts[1], parts[2]);
    return;
  }
  if (parts[0] === "draft" && parts[1] && parts[2]) {
    withTree("docs", "draft");
    setCrumbs([{ label: "문서", href: "#/docs" }, { label: "새 문서" }]);
    renderDraftScreen(parts[1], parts[2]);
    return;
  }
  if (parts[0] === "graph") {
    wide("graph", [{ label: "그래프" }], "graph");
    renderGraph(parts[1] && parts[2] ? `${parts[1]}/${parts[2]}` : null);
    return;
  }
  if (parts[0] === "docs" || parts[0] === "agents") {
    withTree(parts[0], "doc");
    setCrumbs([{ label: parts[0] === "docs" ? "문서" : "에이전트" }]);
    if (lastDoc) renderDocScreen(lastDoc.type, lastDoc.id);
    else $("doc").replaceChildren(el("p", { class: "loading", text: "왼쪽에서 문서를 고르세요." }));
    return;
  }
  if (parts[0] === "review" || parts[0] === "queue") {
    wide("review", [{ label: "검토" }], "queue");
    renderQueue();
    return;
  }
  if (parts[0] === "audit") {
    wide("audit", [{ label: "감사" }], "audit");
    renderAudit();
    return;
  }
  setLastDoc(lastDoc);
  wide("overview", [{ label: "개요" }], "corpus");
  renderOverview();
}
