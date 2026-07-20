// akg CLI `catalog-push` (design §8.1): push a fresh describe_table result
// (agent-db-plugin MCP output shape — columns/primaryKey/foreignKeys/indexes/
// numRows/lastAnalyzed/tableComment) into a db-schema doc's `catalog` field —
// PUT /api/docs/db-schema/:id/catalog (editor | agent role). This only ever
// replaces the AUTO/fact half of the doc; the server derives columnDescs
// deprecation for vanished columns and leaves every other slot untouched
// (server/routes/docs.mjs). The target doc must already exist — this route
// does not create one (404 if it doesn't).
import { AkgApiError } from "./errors.mjs";

function catalogUrl(serverUrl, id) {
  return `${String(serverUrl).replace(/\/+$/, "")}/api/docs/db-schema/${encodeURIComponent(id)}/catalog`;
}

/**
 * @param {{serverUrl: string, token: string, id: string, catalog: object, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{rev: string}>}
 */
export async function catalogPush({
  serverUrl,
  token,
  id,
  catalog,
  fetchImpl = fetch,
}) {
  const res = await fetchImpl(catalogUrl(serverUrl, id), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(catalog),
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    throw new AkgApiError(
      `catalog-push failed: HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}`,
      { status: res.status, body },
    );
  }
  return { rev: body.rev };
}
