// Serves the static dashboard (design §D7: bundle-free vanilla JS, JS split
// into /app.js per the strict-CSP `script-src 'self'` regime app.mjs sets).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "..", "public");

const FILES = {
  "/": { path: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { path: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { path: "app.css", type: "text/css; charset=utf-8" },
};

export function registerDashboardRoutes(app) {
  for (const [route, { path, type }] of Object.entries(FILES)) {
    app.get(route, { config: { public: true } }, async (request, reply) => {
      reply.type(type);
      return reply.send(readFileSync(join(PUBLIC_DIR, path), "utf8"));
    });
  }
}
