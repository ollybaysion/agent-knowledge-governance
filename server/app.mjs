// Fastify app builder (design §D7, §11). Separated from server/main.mjs so
// tests can `app.inject()` without binding a real port. Boot is fail-closed
// (S1): buildApp() throws (AuthBootError / StoreError) instead of returning
// an app that would silently run without auth or on a dirty store.
import Fastify from "fastify";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemas } from "../src/envelope.mjs";
import { initStore, isValidId } from "./store.mjs";
import {
  loadUsers,
  authenticate,
  hasRole,
  isRateLimited,
  recordAuthFailure,
  AuthBootError,
} from "./auth.mjs";
import { createQueue } from "./queue.mjs";
import { registerDocsRoutes } from "./routes/docs.mjs";
import { registerPromoteRoutes } from "./routes/promote.mjs";
import { registerProposalsRoutes } from "./routes/proposals.mjs";
import { registerAuditRoutes } from "./routes/audit.mjs";
import { registerMiscRoutes } from "./routes/misc.mjs";
import { registerDashboardRoutes } from "./routes/dashboard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, "..", "schemas");
const BODY_LIMIT = 512 * 1024; // S13

/**
 * @param {{storeDir: string, usersPath: string, schemasDir?: string}} opts
 * @returns {Promise<import("fastify").FastifyInstance>}
 */
export async function buildApp({
  storeDir,
  usersPath,
  schemasDir = SCHEMAS_DIR,
}) {
  // Fail-closed checks run BEFORE the app object is even constructed —
  // there is no window where an app exists but auth/store are unverified.
  initStore(storeDir);
  loadUsers(usersPath); // throws AuthBootError if missing/empty/wrong perms — validated eagerly so misconfig is caught at boot, not on first request

  const refs = loadSchemas(schemasDir);
  const queue = createQueue();

  const app = Fastify({ bodyLimit: BODY_LIMIT, logger: false });

  app.decorate("akg", { storeDir, usersPath, refs, queue });

  // S2: strict CSP + no-sniff on every response, dashboard and API alike.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(
      "content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'",
    );
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  // CS7: route params that name a stored object become file path segments.
  // Guarding them here rather than per-route means a newly added route cannot
  // reintroduce the traversal by forgetting to validate — the same reason the
  // auth hook below is global. `:type` is separately allowlisted by its route;
  // it is included because it is also a path segment.
  app.addHook("onRequest", async (request, reply) => {
    for (const key of ["id", "pid", "type"]) {
      const value = request.params?.[key];
      if (value !== undefined && !isValidId(value)) {
        return reply
          .code(400)
          .send({ error: "invalid_path_param", param: key });
      }
    }
  });

  // S1/S14: every route must opt into either `config.public` or an explicit
  // `config.roles` allowlist — there is no default-allow path.
  app.addHook("preHandler", async (request, reply) => {
    // No route matched — let the notFound handler answer (a 404), don't run
    // auth against a nonexistent endpoint (which would 500 on the missing
    // roles config).
    if (!request.routeOptions?.url) return;
    const cfg = request.routeOptions?.config ?? {};
    if (cfg.public) return;

    const ip = request.ip;
    if (isRateLimited(ip)) {
      return reply.code(429).send({
        error: "rate_limited",
        message: "인증 실패가 너무 많습니다. 잠시 후 다시 시도하세요.",
      });
    }

    let users;
    try {
      users = loadUsers(usersPath); // re-read so CLI revoke/add takes effect without a restart
    } catch (err) {
      return reply
        .code(500)
        .send({ error: "auth_store_broken", message: err.message });
    }

    const authz = request.headers.authorization ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    const user = token ? authenticate(users, token) : null;
    if (!user) {
      recordAuthFailure(ip);
      return reply.code(401).send({ error: "unauthorized" });
    }
    request.user = user;

    const roles = cfg.roles;
    if (!roles) {
      // A route with no public/roles config is a bug in this codebase, not a
      // client error — deny rather than silently defaulting to allow.
      return reply.code(500).send({
        error: "route_misconfigured",
        message: "이 경로는 config.roles가 없습니다",
      });
    }
    if (!hasRole(user, roles)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  registerDashboardRoutes(app);
  registerMiscRoutes(app);
  registerDocsRoutes(app);
  registerPromoteRoutes(app);
  registerProposalsRoutes(app);
  registerAuditRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "not_found", path: request.url });
  });

  return app;
}

export { AuthBootError };
