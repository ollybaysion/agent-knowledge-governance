// §6: GET /health (public), GET /api/schemas/:type (public),
// GET /api/index/:type (viewer), GET /api/bundle (viewer).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { git } from "../git.mjs";
import { readJson } from "../store.mjs";

const VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export function registerMiscRoutes(app) {
  const { storeDir, refs } = app.akg;

  app.get("/health", { config: { public: true } }, async () => {
    let rev = null;
    try {
      rev = git(storeDir, ["rev-parse", "HEAD"]).trim();
    } catch {
      /* empty store, no commits yet — rev stays null */
    }
    return { version: VERSION, storeRev: rev };
  });

  // Not in design §6's table — added so the dashboard can show "logged in as
  // X (role)" and gate the promote button client-side without guessing.
  app.get(
    "/api/me",
    { config: { roles: ["viewer", "editor", "approver"] } },
    async (request) => {
      return { id: request.user.id, role: request.user.role };
    },
  );

  app.get(
    "/api/schemas/:type",
    { config: { public: true } },
    async (request, reply) => {
      const schema = refs[`${request.params.type}/v1`];
      if (!schema) return reply.code(404).send({ error: "not_found" });
      return schema;
    },
  );

  app.get(
    "/api/index/:type",
    { config: { roles: ["viewer"] } },
    async (request, reply) => {
      const { type } = request.params;
      const rev =
        git(storeDir, [
          "log",
          "-1",
          "--format=%H",
          "--",
          `rendered/${type}/index.json`,
        ]).trim() || null;
      if (rev && request.headers["if-none-match"] === rev)
        return reply.code(304).send();
      const index = readJson(storeDir, `rendered/${type}/index.json`) ?? [];
      if (rev) reply.header("etag", rev);
      return index;
    },
  );

  // Bundle = a tar.gz of rendered/ (the injectable derivative), not store/
  // (the editable JSON) — akg sync only ever needs the former (design §8.1).
  app.get(
    "/api/bundle",
    { config: { roles: ["viewer"] } },
    async (request, reply) => {
      let headRev = null;
      try {
        headRev = git(storeDir, ["rev-parse", "HEAD"]).trim();
      } catch {
        return reply.code(404).send({ error: "empty_store" });
      }
      if (request.query.since === headRev) return reply.code(304).send();
      if (!existsSync(join(storeDir, "rendered")))
        return reply.code(404).send({ error: "nothing_rendered_yet" });

      // Streamed, not buffered. The previous spawnSync had two problems that
      // both scale with the corpus: it blocked the event loop for the whole
      // tar (no other request could be served), and it capped output at
      // maxBuffer — 1MB by default. Crossing ~1MB gzipped turned this route
      // into a permanent 500 whose cause was invisible (the failure lands in
      // r.error, which was never read), and `akg sync` fails open, so every
      // mirror would have stopped updating without anyone being told.
      const child = spawn("tar", ["-czf", "-", "-C", storeDir, "rendered"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Distinguish "tar never started" (answerable with a clean 500, nothing
      // has been written yet) from "tar died mid-stream" (headers are already
      // out — see the destroy below).
      const started = await new Promise((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", () => resolve(false));
      });
      if (!started) {
        return reply
          .code(500)
          .send({ error: "bundle_failed", message: "tar를 실행하지 못했습니다" });
      }

      let stderr = "";
      child.stderr.on("data", (d) => {
        if (stderr.length < 4096) stderr += d.toString();
      });
      // A tar that dies mid-stream must not be mistaken for a complete bundle.
      // Destroying stdout truncates the gzip, and a truncated gzip fails to
      // extract — so the client rejects it rather than installing a partial
      // corpus.
      child.on("close", (code) => {
        if (code !== 0) {
          child.stdout.destroy(
            new Error(`tar exited ${code}: ${stderr.trim()}`),
          );
        }
      });

      reply.header("etag", headRev);
      reply.header("content-type", "application/gzip");
      return reply.send(child.stdout);
    },
  );
}
