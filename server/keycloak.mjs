// Agent authentication on a Keycloak server: the Bearer value is an access
// token from realm fdc-voc-agent (client credentials of fdc-voc-agent-a2a).
// Signature by the realm JWKS, issuer, expiry; group from
// resource_access.<clientId>.roles, the same field BE reads.
import { constants, createPublicKey, verify } from "node:crypto";

import { AuthBootError, groupOfClientRoles } from "./auth.mjs";

const SKEW_S = 60; // Spring's JwtTimestampValidator default
const JWKS_REFETCH_MS = 30 * 1000;
const ALGS = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  PS384: { hash: "sha384", pss: true },
  PS512: { hash: "sha512", pss: true },
  ES256: { hash: "sha256", ec: true },
  ES384: { hash: "sha384", ec: true },
  ES512: { hash: "sha512", ec: true },
};

const b64json = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * Reads the realm's discovery document at boot — an unreachable Keycloak
 * refuses boot, as BE does.
 * @param {{issuer: string, clientId: string, fetchImpl?: typeof fetch}} opts
 */
export async function discoverKeycloak({ issuer, clientId, fetchImpl = fetch }) {
  let config;
  try {
    const res = await fetchImpl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (err) {
    throw new AuthBootError(
      `Keycloak(${issuer})의 discovery 문서를 읽지 못했습니다 — 뜨지 않습니다: ${err.message}`,
    );
  }
  if (config.issuer !== issuer || !config.jwks_uri) {
    throw new AuthBootError(
      `Keycloak discovery 문서의 issuer(${config.issuer})가 FDC_AUTH_KEYCLOAK_ISSUER(${issuer})와 다르거나 jwks_uri 가 없습니다`,
    );
  }

  let keys = new Map(); // kid -> KeyObject
  let fetchedAt = 0;
  async function refresh() {
    fetchedAt = Date.now();
    const res = await fetchImpl(config.jwks_uri);
    if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
    const { keys: jwks = [] } = await res.json();
    const next = new Map();
    for (const jwk of jwks) {
      if (jwk.use && jwk.use !== "sig") continue;
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
      } catch {
        /* a key type this node cannot load is skipped, not fatal */
      }
    }
    keys = next;
  }
  // A key rotated in after the last fetch: fetch again, but not more than
  // once per window, so garbage kids cannot turn into a request flood.
  async function keyFor(kid) {
    if (!keys.has(kid) && Date.now() - fetchedAt > JWKS_REFETCH_MS) {
      // Keycloak down mid-run: the known keys keep working, an unknown kid stays unknown.
      await refresh().catch(() => {});
    }
    return keys.get(kid) ?? null;
  }
  try {
    await refresh();
  } catch (err) {
    throw new AuthBootError(`Keycloak JWKS(${config.jwks_uri})를 읽지 못했습니다 — 뜨지 않습니다: ${err.message}`);
  }

  return {
    /**
     * @returns {Promise<{id: string, group: string} | null>} null when the
     * token is not a valid, current access token of this realm.
     */
    async identityOf(token, { now = Date.now() } = {}) {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      let header, claims;
      try {
        header = b64json(parts[0]);
        claims = b64json(parts[1]);
      } catch {
        return null;
      }
      const alg = ALGS[header.alg];
      if (!alg || (header.typ && header.typ !== "JWT")) return null;
      const key = await keyFor(header.kid);
      if (!key) return null;
      let ok;
      try {
        ok = verify(
        alg.hash,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        {
          key,
          ...(alg.pss ? { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : {}),
          ...(alg.ec ? { dsaEncoding: "ieee-p1363" } : {}),
        },
        Buffer.from(parts[2], "base64url"),
        );
      } catch {
        return null; // header alg and the kid's key type disagree
      }
      if (!ok) return null;
      const nowS = now / 1000;
      if (claims.iss !== issuer) return null;
      if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= nowS) return null;
      if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > nowS) return null;
      // An ID or refresh token of the same realm is signed by the same keys.
      if (claims.typ !== "Bearer") return null;
      const roles = claims.resource_access?.[clientId]?.roles;
      const id = claims.preferred_username ?? claims.sub;
      if (typeof id !== "string" || id === "") return null;
      return {
        id,
        group: groupOfClientRoles(Array.isArray(roles) ? roles.map(String) : []),
      };
    },
    refresh,
  };
}
