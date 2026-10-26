// Fastify app builder (design §D7, §11). Separated from server/main.mjs so
// tests can `app.inject()` without binding a real port. Boot is fail-closed
// (S1): buildApp() throws (AuthBootError / StoreError) instead of returning
// an app that would silently run without auth or on a dirty store.
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContractSchemas, loadSchemas } from "../src/envelope.mjs";
import { initStore, isValidId } from "./store.mjs";
import {
  hasGroup,
  isRateLimited,
  recordAuthFailure,
  AuthBootError,
} from "./auth.mjs";
import { openAuth } from "./identity.mjs";
import { CSRF_HEADER } from "./session.mjs";
import { createQueue } from "./queue.mjs";
import { createTypes } from "./types.mjs";
import { registerTypesRoutes } from "./routes/types.mjs";
import { registerDocsRoutes } from "./routes/docs.mjs";
import { registerPromoteRoutes } from "./routes/promote.mjs";
import { registerProposalsRoutes } from "./routes/proposals.mjs";
import { registerAuditRoutes } from "./routes/audit.mjs";
import { registerMiscRoutes } from "./routes/misc.mjs";
import { MERMAID_FRAME, registerDashboardRoutes } from "./routes/dashboard.mjs";
import { registerAssetsRoutes, ASSET_LIMIT } from "./routes/assets.mjs";
import { registerScoreRoutes } from "./routes/score.mjs";
import { registerSchemaIndexRoutes } from "./routes/schema-index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, "..", "schemas");
const BODY_LIMIT = 512 * 1024; // S13

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function sameToken(given, expected) {
  if (typeof given !== "string" || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 'self' plus the FE origin, when the FE address is a URL. */
export function frameAncestors(feUrl) {
  try {
    const { origin, protocol } = new URL(feUrl);
    if (protocol === "http:" || protocol === "https:") return `'self' ${origin}`;
  } catch {
    /* not a URL: only this origin may frame the page */
  }
  return "'self'";
}

/**
 * @param {{storeDir: string, auth: Parameters<typeof openAuth>[0], schemasDir?: string}} opts
 * @returns {Promise<import("fastify").FastifyInstance>}
 */
export async function buildApp({ storeDir, auth: authConfig, schemasDir = SCHEMAS_DIR }) {
  // Fail-closed checks run BEFORE the app object is even constructed —
  // there is no window where an app exists but auth/store are unverified.
  initStore(storeDir);
  const auth = await openAuth(authConfig); // throws AuthBootError: no FE address, Keycloak unreachable, bad password file, Redis unreachable

  const refs = loadSchemas(schemasDir);
  const contracts = loadContractSchemas(schemasDir);
  const queue = createQueue();
  const types = createTypes(storeDir, refs);

  // nginx on the same host forwards every request from 127.0.0.1. The
  // failed-auth rate limit keys on request.ip, so without trusting that
  // loopback hop's X-Forwarded-For, twenty bad tokens from anyone made every
  // client 429. Only a loopback peer is trusted, and request.ip is the
  // nearest address it did not add itself.
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: false,
    trustProxy: "loopback",
  });

  app.decorate("akg", { storeDir, auth, refs, contracts, queue, types });
  app.addHook("onClose", () => auth.close());

  // S2: strict CSP + no-sniff on every response, dashboard and API alike.
  // frame-ancestors: the page opens inside FE's drawer (?embed=1), and
  // nowhere else.
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors ${frameAncestors(auth.feUrl)}`;
  // The mermaid frame alone takes inline style: mermaid draws with <style>
  // and style="" in its own document. Its scripts stay 'self'.
  const frameCsp = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors ${frameAncestors(auth.feUrl)}`;
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("content-security-policy", request.routeOptions?.url === MERMAID_FRAME ? frameCsp : csp);
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
  // `config.roles` allowlist (groups) — there is no default-allow path.
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

    const authz = request.headers.authorization ?? "";
    if (authz.startsWith("Bearer ")) {
      // An agent. A Bearer request carries no cookie-borne ambient authority,
      // so it needs no CSRF token.
      const agent = await auth.agentOf(authz.slice(7));
      if (!agent) {
        recordAuthFailure(ip);
        return reply.code(401).send({ error: "unauthorized" });
      }
      request.user = agent;
    } else {
      let session;
      try {
        session = await auth.sessions.load(request.headers.cookie);
      } catch (err) {
        return reply
          .code(503)
          .send({ error: "session_store_down", message: `세션 저장소(Redis)에 닿지 않습니다: ${err.message}` });
      }
      if (!session) {
        return reply.code(401).send({ error: "unauthorized", login: auth.loginUrl });
      }
      if (WRITE_METHODS.has(request.method) && !sameToken(request.headers[CSRF_HEADER], session.csrf)) {
        return reply.code(403).send({ error: "invalid_csrf" });
      }
      request.user = session.identity;
      request.session = session;
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
    if (!hasGroup(request.user, roles)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  });

  registerDashboardRoutes(app);
  registerMiscRoutes(app);
  registerTypesRoutes(app);
  registerDocsRoutes(app);
  registerAssetsRoutes(app);
  registerPromoteRoutes(app);
  registerProposalsRoutes(app);
  registerAuditRoutes(app);
  registerScoreRoutes(app);
  registerSchemaIndexRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: "not_found", path: request.url });
  });

  // The batch route (#12) is the one place a caller routinely approaches the
  // body limit, and it is a machine that has to decide what to do next.
  // Fastify's default 413 says the body was too large but not that the fix is
  // to send fewer documents — measured, ~200 db-schema docs fit in 512 KiB.
  app.setErrorHandler((err, request, reply) => {
    if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      // The capture upload has its own, larger limit and nothing to split.
      if (request.routeOptions?.url === "/api/assets")
        return reply.code(413).send({
          error: "payload_too_large",
          limitBytes: ASSET_LIMIT,
          message: "캡처는 2MB 까지 올릴 수 있습니다.",
        });
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
