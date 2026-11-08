// Two ways in, one identity out. A person comes in with the SESSION cookie BE
// set at login; an agent comes in with a Bearer value. On a Keycloak server
// the Bearer value is a realm access token; on a server without Keycloak it is
// an agent line's password from the same file BE reads.
import { AuthBootError, loadUserFile, matchAgent, redactUrl } from "./auth.mjs";
import { discoverKeycloak } from "./keycloak.mjs";
import { openSessionStore } from "./session.mjs";

const noLog = () => {};
const elapsed = (start) => `${Math.round(performance.now() - start)} ms`;
const groupCounts = (users) =>
  ["admin", "user", "agent"].map((g) => `${g} ${users.filter((u) => u.group === g).length}`).join(" · ");

/** The FDC_AUTH_* values BE also reads (config repo env/auth.env), plus AKG_FDC_URL. */
export function authConfigFromEnv(env) {
  return {
    keycloakIssuer: env.FDC_AUTH_KEYCLOAK_ISSUER ?? "",
    keycloakClientId: env.FDC_AUTH_KEYCLOAK_CLIENT_ID || "fdc-voc-agent",
    usersFile: env.FDC_AUTH_USERS_FILE ?? "",
    redisUrl: env.FDC_AUTH_REDIS_URL || "redis://localhost:6379",
    sessionNamespace: env.FDC_AUTH_SESSION_NAMESPACE || "spring:session",
    fdcUrl: env.AKG_FDC_URL ?? "",
  };
}

/**
 * Boot-time checks, all fail-closed (S1): the FE address, the login path
 * (Keycloak reachable, or the password file valid), and Redis. `log` gets a
 * line as each check starts and ends, for the boot log.
 * @param {ReturnType<typeof authConfigFromEnv> & {fetchImpl?: typeof fetch}} config
 * @param {(line: string) => void} [log]
 */
export async function openAuth(config, log = noLog) {
  const fdcUrl = config.fdcUrl?.replace(/\/$/, "");
  if (!fdcUrl) {
    throw new AuthBootError(
      "AKG_FDC_URL 이 비었습니다 — 로그인은 FE 에서 하므로, 로그인하지 않은 사람을 보낼 FE 주소가 있어야 뜹니다",
    );
  }
  const issuer = config.keycloakIssuer;
  const clientId = config.keycloakClientId || "fdc-voc-agent";
  let keycloak = null;
  let users = null;
  if (issuer) {
    log(`로그인 길: Keycloak ${redactUrl(issuer)} — discovery · JWKS 읽는 중`);
    const start = performance.now();
    keycloak = await discoverKeycloak({ issuer, clientId, fetchImpl: config.fetchImpl });
    log(`로그인 길: Keycloak ${redactUrl(issuer)} · client ${clientId} · 서명 키 ${keycloak.keyCount()} · ${elapsed(start)}`);
  } else {
    users = loadUserFile(config.usersFile);
    log(`로그인 길: 비밀번호 파일 ${config.usersFile} · 사용자 ${users.length} (${groupCounts(users)})`);
  }
  log(`Redis: ${redactUrl(config.redisUrl)} 접속 중 — 세션 키 ${config.sessionNamespace}:sessions:*`);
  const start = performance.now();
  const sessions = await openSessionStore({
    url: config.redisUrl,
    namespace: config.sessionNamespace,
  });
  log(`Redis: 접속 · PING · ${elapsed(start)}`);

  return {
    sessions,
    /** The FE address: the page's 채팅 · 관리 links and the one origin that may frame it. */
    feUrl: fdcUrl,
    /** Where a person without a session logs in — BE's two login paths. */
    loginUrl: keycloak ? `${fdcUrl}/oauth2/authorization/keycloak` : `${fdcUrl}/login`,
    logoutUrl: `${fdcUrl}/logout`,
    /** @returns {Promise<{id: string, group: "agent"} | null>} */
    async agentOf(bearer) {
      const identity = keycloak ? await keycloak.identityOf(bearer) : matchAgent(users, bearer);
      // The Bearer way in is for agents only — a person signs in through BE.
      return identity?.group === "agent" ? identity : null;
    },
    close: () => sessions.close(),
  };
}
