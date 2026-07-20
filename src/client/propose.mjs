// akg CLI `propose` (design §8.1): submit a slot-level proposal to the hub's
// review queue — POST /api/proposals (agent | editor role). This is the new
// exit for claude-hooks' db-schema-propose-codebase skill: it hands its
// proposal.json here instead of applying it to a local file.
import { AkgApiError } from "./errors.mjs";

function proposalsUrl(serverUrl) {
  return `${String(serverUrl).replace(/\/+$/, "")}/api/proposals`;
}

/**
 * @param {{serverUrl: string, token: string, type: string, id: string, slots: object, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{id: string, deduped: boolean}>}
 */
export async function propose({
  serverUrl,
  token,
  type,
  id,
  slots,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(proposalsUrl(serverUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ type, id, slots }),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 && res.status !== 201) {
    throw new AkgApiError(
      `propose failed: HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}`,
      { status: res.status, body },
    );
  }
  // 201 = new pending proposal; 200 = S8 dedup, an identical resubmission
  // returned the already-pending one (server/routes/proposals.mjs).
  return { id: body.id, deduped: body.deduped === true };
}
