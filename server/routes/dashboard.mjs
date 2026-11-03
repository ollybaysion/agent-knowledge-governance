// Serves the static dashboard (design §D7: bundle-free vanilla JS as ES
// modules, under the strict-CSP `script-src 'self'` regime app.mjs sets).
// Every route here is a public GET; nothing writes. The files are read once
// per process: each answer carries its content's etag and
// cache-control: no-cache, and a matching If-None-Match gets a 304.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { etagOf, noneMatchHits } from "../etag.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");
const SRC_DIR = join(__dirname, "..", "..", "src");

const JS = "text/javascript; charset=utf-8";

// The hidden frame that runs mermaid for ```mermaid fences; app.mjs gives it
// its own CSP (inline style allowed) so the page keeps style-src 'self'.
export const MERMAID_FRAME = "/mermaid-frame.html";

const FILES = {
  "/": { path: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { path: "app.css", type: "text/css; charset=utf-8" },
  "/ui.css": { path: "ui.css", type: "text/css; charset=utf-8" },
  [MERMAID_FRAME]: { path: "mermaid-frame.html", type: "text/html; charset=utf-8" },
  // mermaid 11.17.2 (MIT, public/vendor/mermaid/LICENSE), copied from node_modules/mermaid/dist.
  "/vendor/mermaid/mermaid.min.js": { path: "vendor/mermaid/mermaid.min.js", type: JS },
};

// The server's own modules the page runs as they are, so the page splits,
// links and draws exactly as the server checks: /lib/shared/<name>.mjs.
export const SHARED_MODULES = new Set([
  "skill-sections.mjs",
  "verify-set.mjs",
  "sql-bind.mjs",
  "graph-model.mjs",
  "wikilinks.mjs",
  "flow/agent-md.mjs",
  "flow/chart-fence.mjs",
  "flow/flow-compiler.mjs",
  "flow/flow-error.mjs",
  "flow/flow-grammar.mjs",
  "flow/flow-maps.mjs",
  "flow/flow-rules.mjs",
  "flow/map-expr.mjs",
]);

// A module path below /js/ or /lib/: lower-case words, one level of folder.
const MODULE_PATH = /^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.mjs$/;

const loaded = (file, type) => {
  const body = readFileSync(file, "utf8");
  return { body, type, etag: etagOf(body) };
};

/** The modules below `dir` a MODULE_PATH names (`names` limits them), by path. */
function loadModules(dir, names = null) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true })) {
    if (MODULE_PATH.test(name) && (!names || names.has(name))) out.set(name, loaded(join(dir, name), JS));
  }
  return out;
}

function send(request, reply, file) {
  if (!file) return reply.code(404).send({ error: "not_found" });
  reply.header("etag", file.etag);
  reply.header("cache-control", "no-cache");
  if (noneMatchHits(request.headers["if-none-match"], file.etag)) return reply.code(304).send();
  reply.type(file.type);
  return reply.send(file.body);
}

// Read at the first registration; every app in the process serves the same files.
let files = null;
const loadAll = () => ({
  fixed: new Map(Object.entries(FILES).map(([route, { path, type }]) => [route, loaded(join(PUBLIC_DIR, path), type)])),
  js: loadModules(join(PUBLIC_DIR, "js")),
  lib: loadModules(join(PUBLIC_DIR, "lib")),
  shared: loadModules(SRC_DIR, SHARED_MODULES),
});

export function registerDashboardRoutes(app) {
  const { fixed, js, lib, shared } = (files ??= loadAll());
  for (const [route, file] of fixed) {
    app.get(route, { config: { public: true } }, async (request, reply) => send(request, reply, file));
  }
  app.get("/js/*", { config: { public: true } }, async (request, reply) => send(request, reply, js.get(request.params["*"])));
  app.get("/lib/shared/*", { config: { public: true } }, async (request, reply) =>
    send(request, reply, shared.get(request.params["*"])),
  );
  app.get("/lib/*", { config: { public: true } }, async (request, reply) => send(request, reply, lib.get(request.params["*"])));
}
