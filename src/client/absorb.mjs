// akg CLI `absorb-mark` and `list`: the absorb skill marks a document as
// absorbed into a first-class document (PUT /api/docs/:type/:id/absorbed)
// and lists the documents still to absorb (GET /api/docs?absorbed=stale).
// Fail-closed like push: any refusal throws.
import { AkgApiError } from "./errors.mjs";

const base = (serverUrl) => String(serverUrl).replace(/\/+$/, "");
const docUrl = (serverUrl, type, id) => `${base(serverUrl)}/api/docs/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;

async function call(fetchImpl, url, { method = "GET", token, payload }) {
  const headers = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await fetchImpl(url, { method, headers, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function fail(what, { status, body }) {
  return new AkgApiError(`${what}: HTTP ${status}${body?.error ? ` (${body.error})` : ""}`, { status, body });
}

/**
 * Mark `type/id` absorbed at `rev`; without `rev`, at the document's current rev.
 * @param {{serverUrl: string, token: string, type: string, id: string, rev?: string|null, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{rev: string, absorbed: {rev: string, at: string, by: string}}>}
 */
export async function absorbMark({ serverUrl, token, type, id, rev = null, fetchImpl = fetch }) {
  const url = docUrl(serverUrl, type, id);
  let markRev = rev;
  if (!markRev) {
    const current = await call(fetchImpl, url, { token });
    if (current.status !== 200) throw fail("absorb-mark: 문서 읽기 실패", current);
    markRev = current.body.rev;
  }
  const res = await call(fetchImpl, `${url}/absorbed`, { method: "PUT", token, payload: { rev: markRev } });
  if (res.status === 409) throw new AkgApiError(`absorb-mark: 문서가 ${markRev} 뒤에 바뀌었습니다 — 다시 읽고 녹인 뒤 표시합니다`, res);
  if (res.status !== 200) throw fail("absorb-mark 실패", res);
  return res.body;
}

/**
 * The list rows of GET /api/docs.
 * @param {{serverUrl: string, token: string, type?: string|null, staleAbsorbed?: boolean, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<object[]>}
 */
export async function listDocs({ serverUrl, token, type = null, staleAbsorbed = false, fetchImpl = fetch }) {
  const query = new URLSearchParams();
  if (type) query.set("type", type);
  if (staleAbsorbed) query.set("absorbed", "stale");
  const qs = query.toString();
  const res = await call(fetchImpl, `${base(serverUrl)}/api/docs${qs ? `?${qs}` : ""}`, { token });
  if (res.status !== 200) throw fail("list 실패", res);
  return res.body.docs;
}
