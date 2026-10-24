// The shared login session BE writes (Spring Session, RedisSessionRepository).
// AKG reads only the identity field and the CSRF token, and keeps the session
// alive the way Spring does on every request: lastAccessedTime = now, key
// expiry = now + maxInactiveInterval.
//
// Redis shape (JSON serializer, BE AuthConfig):
//   <ns>:sessions:<id>  hash
//     lastAccessedTime     1792852175264
//     maxInactiveInterval  1800
//     sessionAttr:fdc.identity  {"@class":"java.util.LinkedHashMap","id":"lee","group":"user"}
//     sessionAttr:fdc.csrf      {"@class":"…DefaultCsrfToken","headerName":"X-CSRF-TOKEN","parameterName":"_csrf","token":"…"}
// The SESSION cookie carries the session id in Base64.
import { randomUUID } from "node:crypto";
import { createClient } from "redis";

import { AuthBootError, isIdentity } from "./auth.mjs";

export const SESSION_COOKIE = "SESSION";
export const CSRF_HEADER = "x-csrf-token";
const IDENTITY = "sessionAttr:fdc.identity";
const CSRF = "sessionAttr:fdc.csrf";
const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;

// Touch only a session that still exists — a logout between the read and the
// write must not leave a stray hash behind.
const TOUCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lastAccessedTime', ARGV[1])
if tonumber(ARGV[2]) < 0 then redis.call('PERSIST', KEYS[1])
else redis.call('PEXPIREAT', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]) * 1000) end
return 1`;

const ENSURE_CSRF = `
if redis.call('EXISTS', KEYS[1]) == 0 then return false end
redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
return redis.call('HGET', KEYS[1], ARGV[1])`;

function csrfField(token) {
  return JSON.stringify({
    "@class": "org.springframework.security.web.csrf.DefaultCsrfToken",
    headerName: "X-CSRF-TOKEN",
    parameterName: "_csrf",
    token,
  });
}

function parseJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** SESSION cookie value from a Cookie header, decoded to the session id. */
export function sessionIdOf(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const id = Buffer.from(part.slice(eq + 1).trim(), "base64").toString("utf8");
    return SESSION_ID.test(id) ? id : null;
  }
  return null;
}

/**
 * Connects and PINGs once — an unreachable Redis refuses boot (S1).
 * @param {{url: string, namespace: string}} opts
 */
export async function openSessionStore({ url, namespace }) {
  const client = createClient({
    url,
    // Boot must fail, not retry forever, when Redis is not there.
    socket: { reconnectStrategy: (retries) => (retries > 3 ? false : 200) },
  });
  client.on("error", () => {}); // surfaced per command; an unhandled 'error' would crash the process
  try {
    await client.connect();
    await client.ping();
  } catch (err) {
    try {
      client.destroy();
    } catch {
      /* already closed by the failed connect */
    }
    throw new AuthBootError(
      `Redis(${url})에 닿지 않습니다 — 세션 저장소 없이는 뜨지 않습니다: ${err.message}`,
    );
  }
  const keyOf = (id) => `${namespace}:sessions:${id}`;

  return {
    /**
     * The live session behind a SESSION cookie, touched; null when there is
     * none, it expired, or it has no identity (a visit before login).
     * @returns {Promise<{id: string, identity: {id: string, group: string}, csrf: string | null} | null>}
     */
    async load(cookieHeader, { now = Date.now() } = {}) {
      const id = sessionIdOf(cookieHeader);
      if (!id) return null;
      const [last, maxInactive, identityRaw, csrfRaw] = await client.hmGet(
        keyOf(id),
        ["lastAccessedTime", "maxInactiveInterval", IDENTITY, CSRF],
      );
      if (last == null) return null;
      const ttl = Number(maxInactive ?? 1800);
      if (ttl >= 0 && Number(last) + ttl * 1000 <= now) return null;
      const stored = parseJson(identityRaw);
      if (!isIdentity(stored)) return null;
      await client.eval(TOUCH, { keys: [keyOf(id)], arguments: [String(now), String(ttl)] });
      return {
        id,
        identity: { id: stored.id, group: stored.group },
        csrf: parseJson(csrfRaw)?.token ?? null,
      };
    },

    /** The session's CSRF token, written in BE's shape first when the session has none yet. */
    async ensureCsrf(session) {
      if (session.csrf) return session.csrf;
      const raw = await client.eval(ENSURE_CSRF, {
        keys: [keyOf(session.id)],
        arguments: [CSRF, csrfField(randomUUID())],
      });
      return parseJson(raw)?.token ?? null;
    },

    async close() {
      await client.close?.();
    },
  };
}
