import { $ } from "./dom.mjs";
import { renderDraftScreen } from "./drafts.mjs";
import { currentUser, lastDoc } from "./state.mjs";
import { renderAudit } from "./tabs/audit.mjs";
import { renderDocScreen } from "./tabs/doc-view.mjs";
import { renderGraph } from "./tabs/graph.mjs";
import { renderOverview } from "./tabs/overview.mjs";
import { renderQueue } from "./tabs/review.mjs";

// ---------- navigation (prototype: section.on + nav button.on) ----------
export function go(screen) {
  for (const s of document.querySelectorAll("main > section"))
    s.classList.toggle("on", s.id === screen);
  for (const b of document.querySelectorAll("nav button"))
    b.classList.toggle("on", b.dataset.go === screen);
  window.scrollTo(0, 0);
}
for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    const screen = btn.dataset.go;
    if ((screen === "doc" || screen === "graph") && lastDoc)
      location.hash = `#/${screen}/${lastDoc.type}/${encodeURIComponent(lastDoc.id)}`;
    else location.hash = `#/${screen}`;
  });
}
window.addEventListener("hashchange", route);

export function route() {
  if (!currentUser) return;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "doc" && parts[1] && parts[2]) {
    go("doc");
    renderDocScreen(parts[1], decodeURIComponent(parts[2]));
    return;
  }
  if (parts[0] === "graph") {
    go("graph");
    renderGraph(parts[1] && parts[2] ? `${parts[1]}/${decodeURIComponent(parts[2])}` : null);
    return;
  }
  if (parts[0] === "draft" && parts[1] && parts[2]) {
    go("draft");
    renderDraftScreen(parts[1], parts[2]);
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

// A doc picked in the tree or search opens its screen — or, while the graph is
// open, becomes the graph's selection and the graph stays.
export function openDoc(type, id) {
  const screen = $("graph").classList.contains("on") ? "graph" : "doc";
  location.hash = `#/${screen}/${type}/${encodeURIComponent(id)}`;
}
