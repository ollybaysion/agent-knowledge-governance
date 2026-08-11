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

// Anonymous read: a request carrying NO token may pass on routes that opt in
// with `config.anonOk`. This does not loosen S1 — S1's rule is "유효 토큰 없는
// 쓰기 = 무조건 401", and the threat S3 describes (a doc becoming a prompt
// injection channel for every session) is a write-side threat. The defense
// line for reads is the network boundary (S2: loopback + reverse proxy).
// Default ON so an in-house deploy needs no flag; AKG_ANON_READ=0 requires a
// viewer token for reads too.
const ANON_READ = process.env.AKG_ANON_READ !== "0";
// Frozen: this object is shared across requests, so a handler must not mutate it.
const ANON_USER = Object.freeze({ id: null, role: "viewer", anon: true });

// S14 + S2: behind a reverse proxy every request arrives from the proxy's own
// address, so the failed-auth rate limit — which keys on request.ip — would
// treat the whole company as one client and lock everyone out over one
// person's mistyped token. Fastify only reads X-Forwarded-For when told to,
// and that trust has to be declared rather than assumed: on a directly
// reachable server, trusting the header lets any client forge its address and
// makes the rate limit unenforceable. Hence default OFF, and a deployment
// states what sits in front of it.
//
//   unset / ""      → ignore X-Forwarded-For (direct exposure; the default)
//   <n>             → trust n proxy hops. This is what a normal deployment
//                     wants: `1` behind a single reverse proxy.
//   <ip|cidr>[,...] → trust only these addresses
//   true            → trust the whole header chain, i.e. take its LEFTMOST
//                     entry as the client. Almost never right. Every common
//                     proxy config appends to the header rather than replacing
//                     it (nginx's $proxy_add_x_forwarded_for does), so the
//                     leftmost entry is whatever the client sent — which hands
//                     request.ip to the client and lets anyone both dodge the
//                     rate limit and pin it on somebody else's address. Binding
//                     to loopback does not help: the attacker reaches the proxy
//                     the same way everyone else does. Use a hop count.
function parseTrustProxy(raw) {
  const value = (raw ?? "").trim();
  if (value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value; // Fastify accepts an IP, a CIDR, or a comma-separated list
}

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

  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: false,
    trustProxy: parseTrustProxy(process.env.AKG_TRUST_PROXY),
  });

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

    const authz = request.headers.authorization ?? "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    // Only a request with NO credential at all can fall through to the
    // anonymous identity. A token that is present but wrong/expired is a
    // failed authentication, not an anonymous visit — it still 401s and still
    // counts toward the rate limit, so anonymous read can never be used to
    // probe tokens for free.
    if (!token && ANON_READ && cfg.anonOk) {
      request.user = ANON_USER;
      // Deliberately no rate-limit check and no users.json read on this path.
      // An anonymous request cannot produce an authentication failure, so
      // gating it on the failure counter only means one person's typo storm
      // takes the read-only dashboard down for everybody — which is exactly
      // what happens behind a shared-IP reverse proxy. The counter exists to
      // slow brute-forcing a token; a request that presents none isn't
      // brute-forcing anything.
    } else {
      // From here on this is an authentication attempt, so it is the thing the
      // limit is meant to throttle. Checked before touching users.json so a
      // rate-limited flood costs no file I/O.
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

      const user = token ? authenticate(users, token) : null;
      if (!user) {
        recordAuthFailure(ip);
        return reply.code(401).send({ error: "unauthorized" });
      }
      request.user = user;
    }

    const roles = cfg.roles;
    if (!roles) {
      // A route with no public/roles config is a bug in this codebase, not a
      // client error — deny rather than silently defaulting to allow.
      return reply.code(500).send({
        error: "route_misconfigured",
        message: "이 경로는 config.roles가 없습니다",
      });
    }
    if (!hasRole(request.user, roles)) {
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

  // The batch route (#12) is the one place a caller routinely approaches the
  // body limit, and it is a machine that has to decide what to do next.
  // Fastify's default 413 says the body was too large but not that the fix is
  // to send fewer documents — measured, ~200 db-schema docs fit in 512 KiB.
  app.setErrorHandler((err, request, reply) => {
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({
        error: "payload_too_large",
        limitBytes: BODY_LIMIT,
        message:
          "요청 본문이 상한을 넘었습니다. 배치를 더 작게 나눠 여러 번 보내세요.",
      });
    }
    reply.send(err);
  });

  return app;
}

export { AuthBootError };
