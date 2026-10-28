// Serves the static dashboard (design §D7: bundle-free vanilla JS as ES
// modules, under the strict-CSP `script-src 'self'` regime app.mjs sets).
// Every route here is a public GET; nothing writes.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function sendModule(reply, dir, rel) {
  if (!MODULE_PATH.test(rel)) return reply.code(404).send({ error: "not_found" });
  const file = join(dir, rel);
  if (!existsSync(file)) return reply.code(404).send({ error: "not_found" });
  reply.type(JS);
  return reply.send(readFileSync(file, "utf8"));
}

export function registerDashboardRoutes(app) {
  for (const [route, { path, type }] of Object.entries(FILES)) {
    app.get(route, { config: { public: true } }, async (request, reply) => {
      reply.type(type);
      return reply.send(readFileSync(join(PUBLIC_DIR, path), "utf8"));
    });
  }
  app.get("/js/*", { config: { public: true } }, async (request, reply) =>
    sendModule(reply, join(PUBLIC_DIR, "js"), request.params["*"]),
  );
  app.get("/lib/shared/*", { config: { public: true } }, async (request, reply) => {
    const file = request.params["*"];
    if (!SHARED_MODULES.has(file)) return reply.code(404).send({ error: "not_found" });
    return sendModule(reply, SRC_DIR, file);
  });
  app.get("/lib/*", { config: { public: true } }, async (request, reply) =>
    sendModule(reply, join(PUBLIC_DIR, "lib"), request.params["*"]),
  );
}
