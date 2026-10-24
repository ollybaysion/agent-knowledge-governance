// Test sign-in: what BE leaves behind after a login, without BE. A person
// (admin · user) gets a session in the test Redis in BE's exact shape and
// signs requests with the SESSION cookie + X-CSRF-TOKEN; an agent signs with
// Bearer <its password line>. `as(token)` hands back the headers for whoever
// `signIn` registered under that token.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "redis";

export const REDIS_URL = process.env.FDC_AUTH_REDIS_URL || "redis://localhost:6379";
export const NAMESPACE = "akg-test:session";
export const FDC_URL = "http://fdc.test";

const signed = new Map(); // token -> headers

let client = null;
async function redis() {
  if (!client) {
    client = createClient({ url: REDIS_URL });
    await client.connect();
    client.unref?.(); // let the test process exit with the connection open
  }
  return client;
}

/** A session in BE's shape. @returns the session id */
export async function writeSession(identity, { csrf = randomUUID(), lastAccessedTime = Date.now(), maxInactiveInterval = 1800 } = {}) {
  const id = randomUUID();
  const key = `${NAMESPACE}:sessions:${id}`;
  const r = await redis();
  await r.hSet(key, {
    creationTime: String(lastAccessedTime),
    lastAccessedTime: String(lastAccessedTime),
    maxInactiveInterval: String(maxInactiveInterval),
    "sessionAttr:fdc.identity": JSON.stringify({ "@class": "java.util.LinkedHashMap", ...identity }),
    ...(csrf
      ? {
          "sessionAttr:fdc.csrf": JSON.stringify({
            "@class": "org.springframework.security.web.csrf.DefaultCsrfToken",
            headerName: "X-CSRF-TOKEN",
            parameterName: "_csrf",
            token: csrf,
          }),
        }
      : {}),
  });
  await r.pExpire(key, 10 * 60 * 1000);
  return id;
}

export const sessionCookie = (id) => `SESSION=${Buffer.from(id).toString("base64")}`;

export async function readSession(id) {
  const r = await redis();
  const key = `${NAMESPACE}:sessions:${id}`;
  return { fields: await r.hGetAll(key), pttl: await r.pTTL(key) };
}

/**
 * Writes the password file into `home` and signs every person in.
 * @param {string} home
 * @param {{id: string, group: "admin"|"user"|"agent", token: string}[]} people
 * @returns the `auth` option for buildApp
 */
export async function signIn(home, people) {
  // Every server signs in a plain reader too: `as("reader")` is a read with
  // no other point than being signed in.
  if (!people.some((p) => p.token === "reader")) people = [...people, { id: "test-reader", group: "user", token: "reader" }];
  const usersFile = join(home, "users.yml");
  const lines = people.map((p) => `  - { id: ${JSON.stringify(p.id)}, group: ${p.group}, password: ${JSON.stringify(p.token)} }`);
  writeFileSync(usersFile, `users:\n${lines.join("\n")}\n`, { mode: 0o600 });
  for (const p of people) {
    if (p.group === "agent") {
      signed.set(p.token, { authorization: `Bearer ${p.token}` });
    } else {
      const csrf = randomUUID();
      const id = await writeSession({ id: p.id, group: p.group }, { csrf });
      signed.set(p.token, { cookie: sessionCookie(id), "x-csrf-token": csrf });
    }
  }
  return authConfig(usersFile);
}

export function authConfig(usersFile) {
  return {
    keycloakIssuer: "",
    usersFile,
    redisUrl: REDIS_URL,
    sessionNamespace: NAMESPACE,
    fdcUrl: FDC_URL,
  };
}

/** Headers for the person or agent `signIn` registered under `token`; an unknown token goes as a Bearer value. */
export function as(token) {
  return { ...(signed.get(token) ?? { authorization: `Bearer ${token}` }) };
}
