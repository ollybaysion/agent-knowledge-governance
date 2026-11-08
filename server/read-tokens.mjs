// Personal read tokens. A person issues one on the AKG page (cookie session)
// and pastes it into a local app such as WorkBench. The app then reads with
// `Authorization: Bearer akgr_…`; the token reads the same GET routes a
// `user` reads, and nothing else.
//
// Redis shape (the same Redis the session store uses):
//   <prefix>:read-token:<sha256 hex>   hash  owner · label · createdAt · expiresAt · lastUsedAt (ms)
//                                      PEXPIREAT = expiresAt
//   <prefix>:read-tokens:<owner>       zset  member = sha256 hex, score = createdAt
// AKG keeps only the sha256 of a token. The plain token shows once, in the
// answer to the issue request. A token's id (list · revoke) is the first 12
// hex characters of its sha256.
//
// The scripts below read token keys by name from the index, so they run on a
// single Redis (the session store's), as BE's Spring Session does.
import { createHash, randomBytes } from "node:crypto";

export const READ_TOKEN_PREFIX = "akgr_";
export const READ_TOKEN_PATTERN = /^akgr_[A-Za-z0-9_-]{43}$/;
export const READ_TOKEN_LIMIT = 5;
export const READ_TOKEN_DAYS = [30, 90, 365];
export const READ_TOKEN_DEFAULT_DAYS = 90;
export const READ_TOKEN_LABEL_MAX = 40;
const ID_LENGTH = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
/** lastUsedAt moves at most once in this window, so a read is not a write each time. */
export const LAST_USED_WINDOW_MS = 60 * 60 * 1000;

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (ms) => (ms == null || ms === "" ? null : new Date(Number(ms)).toISOString());

// Counts the live tokens (and drops index entries whose token expired or was
// deleted) and writes the new one only under the limit, in one step: two
// issue requests at once cannot both take the fifth place.
const ISSUE = `
local members = redis.call('ZRANGE', KEYS[1], 0, -1)
local live = 0
for _, m in ipairs(members) do
  if redis.call('EXISTS', ARGV[1] .. m) == 1 then live = live + 1
  else redis.call('ZREM', KEYS[1], m) end
end
if live >= tonumber(ARGV[2]) then return -1 end
redis.call('HSET', KEYS[2], 'owner', ARGV[3], 'label', ARGV[4], 'createdAt', ARGV[5], 'expiresAt', ARGV[6])
redis.call('PEXPIREAT', KEYS[2], ARGV[6])
redis.call('ZADD', KEYS[1], ARGV[5], ARGV[7])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 or tonumber(ARGV[5]) + ttl < tonumber(ARGV[6]) then redis.call('PEXPIREAT', KEYS[1], ARGV[6]) end
return live + 1`;

// lastUsedAt on a token that still exists — a revoke between the read and
// this write must not leave a hash behind without its owner.
const TOUCH = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'lastUsedAt', ARGV[1])
return 1`;

/** label → the trimmed label, or null when it is not a 1~40 character string. */
export function cleanLabel(label) {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > READ_TOKEN_LABEL_MAX) return null;
  // One line of plain text: the label shows in a table row.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * @param {{client: import("redis").RedisClientType, prefix?: string}} opts
 *   prefix: the key namespace, "akg" on a server; the tests use their own.
 */
export function createReadTokenStore({ client, prefix = "akg" }) {
  const tokenKey = (hash) => `${prefix}:read-token:${hash}`;
  const indexKey = (owner) => `${prefix}:read-tokens:${owner}`;

  return {
    /**
     * A new token for `owner`. null when the owner already has the limit.
     * @returns {Promise<{id: string, label: string, createdAt: string, expiresAt: string, token: string} | null>}
     */
    async issue(owner, { label, days = READ_TOKEN_DEFAULT_DAYS }, { now = Date.now() } = {}) {
      const token = READ_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const hash = sha256(token);
      const expiresAt = now + days * DAY_MS;
      const placed = await client.eval(ISSUE, {
        keys: [indexKey(owner), tokenKey(hash)],
        arguments: [
          `${prefix}:read-token:`,
          String(READ_TOKEN_LIMIT),
          owner,
          label,
          String(now),
          String(expiresAt),
          hash,
        ],
      });
      if (Number(placed) < 0) return null;
      return { id: hash.slice(0, ID_LENGTH), label, createdAt: iso(now), expiresAt: iso(expiresAt), token };
    },

    /**
     * The owner's live tokens, newest first. Index entries whose token is gone are removed here.
     * @returns {Promise<{id: string, label: string, createdAt: string, expiresAt: string, lastUsedAt: string | null}[]>}
     */
    async list(owner, { now = Date.now() } = {}) {
      const members = (await client.zRange(indexKey(owner), 0, -1)).reverse();
      const tokens = [];
      const gone = [];
      for (const hash of members) {
        const [label, createdAt, expiresAt, lastUsedAt] = await client.hmGet(tokenKey(hash), [
          "label",
          "createdAt",
          "expiresAt",
          "lastUsedAt",
        ]);
        if (createdAt == null || Number(expiresAt) <= now) {
          gone.push(hash);
          continue;
        }
        tokens.push({
          id: hash.slice(0, ID_LENGTH),
          label,
          createdAt: iso(createdAt),
          expiresAt: iso(expiresAt),
          lastUsedAt: iso(lastUsedAt),
        });
      }
      if (gone.length) await client.zRem(indexKey(owner), gone);
      return tokens;
    },

    /** Deletes the owner's token with this id. false when the owner has no such token. */
    async revoke(owner, id) {
      if (typeof id !== "string" || !/^[0-9a-f]{12}$/.test(id)) return false;
      const members = await client.zRange(indexKey(owner), 0, -1);
      const hash = members.find((m) => m.startsWith(id));
      if (!hash) return false;
      const deleted = await client.del(tokenKey(hash));
      await client.zRem(indexKey(owner), hash);
      return deleted > 0;
    },

    /**
     * The owner of a live token, or null. Moves lastUsedAt when the last
     * write is an hour old or more.
     * @returns {Promise<string | null>}
     */
    async ownerOf(token, { now = Date.now() } = {}) {
      if (typeof token !== "string" || !READ_TOKEN_PATTERN.test(token)) return null;
      const key = tokenKey(sha256(token));
      const [owner, expiresAt, lastUsedAt] = await client.hmGet(key, ["owner", "expiresAt", "lastUsedAt"]);
      if (!owner || !(Number(expiresAt) > now)) return null;
      if (lastUsedAt == null || now - Number(lastUsedAt) >= LAST_USED_WINDOW_MS) {
        await client.eval(TOUCH, { keys: [key], arguments: [String(now)] });
      }
      return owner;
    },
  };
}
