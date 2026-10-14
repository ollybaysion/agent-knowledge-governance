// Serves the static dashboard (design §D7: bundle-free vanilla JS, JS split
// into /app.js per the strict-CSP `script-src 'self'` regime app.mjs sets).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");
const SRC_DIR = join(__dirname, "..", "..", "src");

const FILES = {
  "/": { path: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { path: "app.css", type: "text/css; charset=utf-8" },
  // The validator's own section splitter, so the editor splits where the
  // server checks. Served from src/ rather than copied into public/.
  "/skill-sections.mjs": {
    dir: SRC_DIR,
    path: "skill-sections.mjs",
    type: "text/javascript; charset=utf-8",
  },
  // The golden-set reader and the data-id reader it imports, for the golden
  // screen's question counts.
  "/golden-set.mjs": {
    dir: SRC_DIR,
    path: "golden-set.mjs",
    type: "text/javascript; charset=utf-8",
  },
  "/skill-data-ids.mjs": {
    dir: SRC_DIR,
    path: "skill-data-ids.mjs",
    type: "text/javascript; charset=utf-8",
  },
  "/search.mjs": { path: "search.mjs", type: "text/javascript; charset=utf-8" },
  // The server's own [[ ]] parser, so the page reads the brackets the way the
  // links were made. Served from src/ rather than copied into public/.
  "/wikilinks.mjs": {
    dir: SRC_DIR,
    path: "wikilinks.mjs",
    type: "text/javascript; charset=utf-8",
  },
};

export function registerDashboardRoutes(app) {
  for (const [route, { dir = PUBLIC_DIR, path, type }] of Object.entries(FILES)) {
    app.get(route, { config: { public: true } }, async (request, reply) => {
      reply.type(type);
      return reply.send(readFileSync(join(dir, path), "utf8"));
    });
  }
}
