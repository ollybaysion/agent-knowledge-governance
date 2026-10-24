// Two ways in, one identity out. A person comes in with the SESSION cookie BE
// set at login; an agent comes in with a Bearer value. On a Keycloak server
// the Bearer value is a realm access token; on a server without Keycloak it is
// an agent line's password from the same file BE reads.
import { AuthBootError, loadUserFile, matchAgent } from "./auth.mjs";
import { discoverKeycloak } from "./keycloak.mjs";
import { openSessionStore } from "./session.mjs";

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
 * (Keycloak reachable, or the password file valid), and Redis.
 * @param {ReturnType<typeof authConfigFromEnv> & {fetchImpl?: typeof fetch}} config
 */
export async function openAuth(config) {
  const fdcUrl = config.fdcUrl?.replace(/\/$/, "");
  if (!fdcUrl) {
    throw new AuthBootError(
      "AKG_FDC_URL 이 비었습니다 — 로그인은 FE 에서 하므로, 로그인하지 않은 사람을 보낼 FE 주소가 있어야 뜹니다",
    );
  }
  const keycloak = config.keycloakIssuer
    ? await discoverKeycloak({
        issuer: config.keycloakIssuer,
        clientId: config.keycloakClientId || "fdc-voc-agent",
        fetchImpl: config.fetchImpl,
      })
    : null;
  const users = keycloak ? null : loadUserFile(config.usersFile);
  const sessions = await openSessionStore({
    url: config.redisUrl,
    namespace: config.sessionNamespace,
  });

  return {
    path: keycloak
      ? `Keycloak ${config.keycloakIssuer}`
      : `비밀번호 파일 ${config.usersFile}`,
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
