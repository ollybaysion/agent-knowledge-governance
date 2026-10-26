// Hash routes → screens. The hash alone moves around inside the page, so the
// address's ?embed · ?from · ?section stay as they are on every move.
import { el } from "./dom.mjs";
import { cols, screen, setActiveTab, setCrumbs } from "./shell.mjs";
import { currentUser, isAdmin, lastDoc } from "./state.mjs";
import { splitHash } from "/lib/cmdk.mjs";

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

/** The hash parts, each decoded: #/doc/db-schema/fdc_x → ["doc", "db-schema", "fdc_x"]. A ?col=… after them is not a part. */
export function hashParts(hash = location.hash) {
  return splitHash(hash)
    .path.replace(/^#\/?/, "")
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

/** A doc picked from a list opens its screen — or, on the graph, becomes its selection. */
export function openDoc(type, id) {
  const onGraph = document.body.dataset.tab === "graph";
  location.hash = onGraph ? `#/graph/${type}/${encodeURIComponent(id)}` : docHash(type, id);
}

/** A screen of its own module, loaded on first use. */
const screens = {
  overview: () => import("./tabs/overview.mjs"),
  agents: () => import("./tabs/agents.mjs"),
  docs: () => import("./tabs/docs.mjs"),
  doc: () => import("./tabs/doc-view.mjs"),
  edit: () => import("./tabs/editor.mjs"),
  draft: () => import("./drafts.mjs"),
  graph: () => import("./tabs/graph.mjs"),
  review: () => import("./tabs/review.mjs"),
  audit: () => import("./tabs/audit.mjs"),
  types: () => import("./tabs/types.mjs"),
};

function notAllowed(tab, label) {
  setActiveTab(tab);
  setCrumbs([{ label }]);
  screen().appendChild(cols({ main: el("main", { class: "main" }, el("p", { class: "loading", text: "admin 만 볼 수 있습니다." })) }));
}

let routeTicket = 0;
export async function route() {
  if (!currentUser) return;
  const ticket = ++routeTicket;
  const parts = hashParts();
  const [head] = parts;
  if (!(head === "doc" && parts[1] === lastDoc?.type && parts[2] === lastDoc?.id)) window.scrollTo(0, 0);
  const load = async (name) => {
    const m = await screens[name]();
    return ticket === routeTicket ? m : null;
  };
  let m;
  if (head === "doc" && parts[1] && parts[2]) {
    const { col } = splitHash(location.hash);
    if ((m = await load("doc"))) m.renderDocScreen(parts[1], parts[2], col ? { col } : {});
  } else if (head === "edit" && parts[1] && parts[2]) {
    if ((m = await load("edit"))) m.renderEditor(parts[1], parts[2], parts[3] ?? null);
  } else if (head === "draft" && parts[1] && parts[2]) {
    if ((m = await load("draft"))) m.renderDraftScreen(parts[1], parts[2]);
  } else if (head === "agents") {
    if ((m = await load("agents"))) m.renderAgents();
  } else if (head === "docs") {
    if ((m = await load("docs"))) m.renderBrowse(parts[1] ?? null);
  } else if (head === "graph") {
    if ((m = await load("graph"))) m.renderGraph(parts[1] && parts[2] ? `${parts[1]}/${parts[2]}` : null);
  } else if (head === "review" || head === "queue") {
    if ((m = await load("review"))) m.renderReview();
  } else if (head === "audit") {
    if ((m = await load("audit"))) m.renderAuditScreen();
  } else if (head === "types") {
    if (!isAdmin()) return notAllowed("types", "타입");
    if ((m = await load("types"))) m.renderTypes();
  } else if ((m = await load("overview"))) m.renderOverviewScreen();
}
