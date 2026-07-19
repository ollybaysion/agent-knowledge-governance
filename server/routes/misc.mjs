// §6: GET /health (public), GET /api/schemas/:type (public),
// GET /api/index/:type (viewer), GET /api/bundle (viewer).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

      const r = spawnSync("tar", ["-czf", "-", "-C", storeDir, "rendered"], {
        encoding: "buffer",
      });
      if (r.status !== 0) {
        return reply
          .code(500)
          .send({ error: "bundle_failed", message: r.stderr?.toString() });
      }
      reply.header("etag", headRev);
      reply.header("content-type", "application/gzip");
      return reply.send(r.stdout);
    },
  );
}
