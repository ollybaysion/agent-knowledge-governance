// Fastify app builder (design §D7, §11). Separated from server/main.mjs so
// tests can `app.inject()` without binding a real port. Boot is fail-closed
// (S1): buildApp() throws (AuthBootError / StoreError) instead of returning
// an app that would silently run without auth or on a dirty store.
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";

import { loadContractSchemas, loadSchemas } from "../src/envelope.mjs";
import { initStore, isValidId, warmRevCache } from "./store.mjs";
import {
  hasGroup,
  isRateLimited,
  recordAuthFailure,
  AuthBootError,
} from "./auth.mjs";
import { openAuth } from "./identity.mjs";
import { CSRF_HEADER } from "./session.mjs";
import { READ_TOKEN_PREFIX } from "./read-tokens.mjs";
import { createQueue } from "./queue.mjs";
import { createTypes, syncRenderedTypes } from "./types.mjs";
import { createCatalog } from "./catalog.mjs";
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
import { registerReadTokensRoutes } from "./routes/read-tokens.mjs";
import { registerCurationRoutes } from "./routes/curation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = join(__dirname, "..", "schemas");
const BODY_LIMIT = 512 * 1024; // S13

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** What a read token may do, and what a cross-origin browser may read. */
const READ_METHODS = new Set(["GET", "HEAD"]);

// CORS, reads only (consuming.md "다른 앱에서 AKG 문서 읽기"). A local app
// (WorkBench: file:// · localhost) reads /api/* with a read token. The answer
// names every origin and carries no Allow-Credentials, so a browser shows an
// answer to a cookie-borne cross-origin request to nobody.
const CORS_READ = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "ETag",
};
const CORS_PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD",
  "access-control-allow-headers": "Authorization, If-None-Match",
  "access-control-max-age": "600",
};

const gzip = promisify(gzipCallback);

const noLog = () => {};
const elapsed = (start) => `${Math.round(performance.now() - start)} ms`;
const typeLabel = (t) => `${t.id}${t.kind === "md" ? "(md)" : ""}${t.status === "archived" ? "(archived)" : ""}`;
// JSON and text (js · css · md · html) answers over 1 KB go gzipped; captures are already compressed.
const GZIP_TYPES = /^(?:application\/(?:json|javascript)|text\/)/i;
const GZIP_MIN_BYTES = 1024;

/** Whether an Accept-Encoding value takes gzip (named, without q=0). */
export function acceptsGzip(value) {
  if (typeof value !== "string") return false;
  return value.split(",").some((part) => {
    const [name, ...params] = part.split(";").map((x) => x.trim().toLowerCase());
    if (name !== "gzip") return false;
    const q = params.find((x) => x.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

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
 * @param {{storeDir: string, auth: Parameters<typeof openAuth>[0], schemasDir?: string, log?: (line: string) => void}} opts
 *   log gets one line as each boot step starts and ends — server/main.mjs
 *   prints them; a step that can take long (rev 표 · Keycloak · Redis ·
 *   카탈로그) logs before it runs, so a boot that hangs shows where.
 * @returns {Promise<import("fastify").FastifyInstance>}
 */
export async function buildApp({ storeDir, auth: authConfig, schemasDir = SCHEMAS_DIR, log = noLog }) {
  // Fail-closed checks run BEFORE the app object is even constructed —
  // there is no window where an app exists but auth/store are unverified.
  let start = performance.now();
  log(`store: ${storeDir} 여는 중`);
  const created = initStore(storeDir);
  log(
    created
      ? `store: 새로 만듦 — git init · "init store" 커밋 · ${elapsed(start)}`
      : `store: 기존 레포 · 깨끗함 · ${elapsed(start)}`,
  );
  // Every list answer carries each document's rev: one walk of the history
  // here instead of one `git log -1` per document on the first list.
  log("rev 표: git 이력 읽는 중");
  const revs = await warmRevCache(storeDir);
  log(
    revs
      ? `rev 표: 커밋 ${revs.commits} · 경로 ${revs.paths} · ${revs.ms} ms`
      : "rev 표: git 이력을 읽지 못했습니다 — rev 는 경로마다 처음 읽을 때 셉니다",
  );
  const auth = await openAuth(authConfig, log); // throws AuthBootError: no FE address, Keycloak unreachable, bad password file, Redis unreachable

  start = performance.now();
  const refs = loadSchemas(schemasDir);
  const contracts = loadContractSchemas(schemasDir);
  log(`스키마: ${schemasDir} · 문서 ${Object.keys(refs).length} · 계약 ${Object.keys(contracts).length} · ${elapsed(start)}`);
  const queue = createQueue();
  const types = createTypes(storeDir, refs);
  const typeList = types.entries();
  log(`타입: ${typeList.length} — ${typeList.map(typeLabel).join(" · ")}`);
  const typesCommit = await syncRenderedTypes(storeDir);
  log(typesCommit ? `타입 목록 파일: rendered/types.json 을 다시 씀 (${typesCommit.slice(0, 7)})` : "타입 목록 파일: 그대로");
  // The documents as the list routes read them, read once here.
  log("카탈로그: 문서 읽는 중");
  const heapBefore = process.memoryUsage().heapUsed;
  start = performance.now();
  const catalog = createCatalog(storeDir, types);
  const loaded = catalog.load();
  for (const t of loaded.types) log(`카탈로그: ${t.type} ${t.docs} · ${t.ms} ms`);
  const heapMB = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10;
  log(`카탈로그: 문서 ${loaded.docs} · ${elapsed(start)} · heap ${heapMB >= 0 ? "+" : ""}${heapMB} MB`);

  start = performance.now();
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

  app.decorate("akg", { storeDir, auth, refs, contracts, queue, types, catalog });
  app.addHook("onClose", () => auth.close());
  app.addHook("onClose", async () => catalog.close());

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
  // Every GET · HEAD answer under /api/ — 401 · 403 · 404 · 429 · 503 too —
  // so the local app can read why a read failed. Write answers go out as
  // they are.
  app.addHook("onSend", async (request, reply, payload) => {
    if (READ_METHODS.has(request.method) && request.url.startsWith("/api/")) reply.headers(CORS_READ);
    return payload;
  });
  // After the hooks above: the answer as it goes out, gzipped when the client takes it.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "HEAD" || reply.statusCode === 304 || reply.statusCode === 204) return payload;
    if (reply.hasHeader("content-encoding")) return payload;
    if (typeof payload !== "string" && !Buffer.isBuffer(payload)) return payload;
    if (!GZIP_TYPES.test(String(reply.getHeader("content-type") ?? ""))) return payload;
    if (Buffer.byteLength(payload) <= GZIP_MIN_BYTES) return payload;
    const vary = reply.getHeader("vary");
    reply.header("vary", vary ? `${vary}, accept-encoding` : "accept-encoding");
    if (!acceptsGzip(request.headers["accept-encoding"])) return payload;
    const packed = await gzip(payload);
    reply.header("content-encoding", "gzip");
    reply.header("content-length", packed.length);
    return packed;
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
    if (authz.startsWith(`Bearer ${READ_TOKEN_PREFIX}`)) {
      // A person's read token, from a local app. It reads as a `user` — an
      // admin's token too — and the method check below keeps it to reads.
      let owner;
      try {
        owner = await auth.readTokens.ownerOf(authz.slice(7));
      } catch (err) {
        return reply
          .code(503)
          .send({ error: "session_store_down", message: `세션 저장소(Redis)에 닿지 않습니다: ${err.message}` });
      }
      if (!owner) {
        recordAuthFailure(ip);
        return reply.code(401).send({ error: "unauthorized", reason: "read_token_invalid" });
      }
      request.user = { id: owner, group: "user", via: "read-token" };
    } else if (authz.startsWith("Bearer ")) {
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

    // The read-token routes manage tokens from the AKG page alone: a token or
    // an agent cannot issue more tokens.
    if (cfg.sessionOnly && !request.session) {
      return reply.code(403).send({ error: "session_only" });
    }
    if (request.user.via === "read-token" && !READ_METHODS.has(request.method)) {
      return reply.code(403).send({ error: "read_only_token" });
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

  // The browser's preflight before a cross-origin read with Authorization.
  // Public: the answer is the same for everyone and tells nothing about the
  // store. A read (GET · HEAD) gets the grant; any other method gets a bare
  // 204, and the browser stops there.
  app.options("/api/*", { config: { public: true } }, async (request, reply) => {
    if (READ_METHODS.has(request.headers["access-control-request-method"]))
      reply.headers(CORS_PREFLIGHT);
    return reply.code(204).send();
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
  registerReadTokensRoutes(app);
  registerCurationRoutes(app);

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

  log(`경로: 등록 · ${elapsed(start)}`);
  return app;
}

export { AuthBootError };
