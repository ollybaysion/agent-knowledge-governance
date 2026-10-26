// akg CLI `push`: write one document with the agent token — a new document
// (POST /api/docs/:type), an edit (PUT /api/docs/:type/:id) and its links
// (PUT …/links). The server keeps every slot at inferred or below (D4), so a
// push never confirms anything. Fail-closed like propose: any refusal throws.
//
// The file is either the whole document (.json: envelope + body) or, for a
// type whose body is { name, markdown } (every md type, domain-skill,
// domain), the markdown text (.md): the body's markdown is replaced and the
// envelope and links stay as the server has them.
import { AkgApiError } from "./errors.mjs";

/** Envelope keys push writes; the others belong to their own admin routes. */
const WRITTEN_KEYS = new Set(["schema", "id", "body", "links"]);

function base(serverUrl) {
  return String(serverUrl).replace(/\/+$/, "");
}

function docUrl(serverUrl, type, id) {
  return `${base(serverUrl)}/api/docs/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

/**
 * What the file says, checked without the server — the --dry-run check.
 * @param {{type: string, id: string, file: {kind: "json", doc: any} | {kind: "md", markdown: string}}} opts
 * @returns {string[]} problems; empty = the shape is fine
 */
export function checkPushFile({ type, id, file }) {
  const problems = [];
  if (file.kind === "md") {
    if (typeof file.markdown !== "string" || !/\S/.test(file.markdown))
      problems.push("md 파일이 비었습니다");
    return problems;
  }
  const doc = file.doc;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    problems.push("JSON 파일은 문서 하나(객체)여야 합니다");
    return problems;
  }
  if (doc.schema !== `${type}/v1`)
    problems.push(`schema 가 "${type}/v1" 이어야 합니다 (파일: ${JSON.stringify(doc.schema)})`);
  if (doc.id !== id) problems.push(`id 가 "${id}" 이어야 합니다 (파일: ${JSON.stringify(doc.id)})`);
  if (!doc.body || typeof doc.body !== "object" || Array.isArray(doc.body))
    problems.push("body 객체가 없습니다");
  if (doc.links !== undefined && !Array.isArray(doc.links)) problems.push("links 는 배열이어야 합니다");
  return problems;
}

async function send(fetchImpl, url, { method, token, rev, note, payload }) {
  const headers = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers["content-type"] = "application/json";
  if (rev) headers["if-match"] = rev;
  if (note) headers["x-akg-note"] = encodeURIComponent(note);
  const res = await fetchImpl(url, {
    method,
    headers,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

// The 409s that mean "the server moved past your rev". The other 409s
// (data_id_conflict, type_archived) are refusals of the content itself.
const isStale = ({ status, body }) =>
  status === 409 && (body?.error === "slot_conflict" || body?.error === "unknown_base_rev");

function fail(what, { status, body }) {
  const code = body?.error ? ` (${body.error})` : "";
  return new AkgApiError(`${what}: HTTP ${status}${code}`, { status, body });
}

/** The new document a .md file makes: inactive, like a new draft on the screen. */
function newMdDoc(type, id, markdown) {
  return {
    schema: `${type}/v1`,
    id,
    keywords: [{ kw: id, inject: "full" }],
    status: "inactive",
    body: { name: id, markdown },
  };
}

/**
 * @param {{
 *   serverUrl: string, token: string, type: string, id: string,
 *   file: {kind: "json", doc: any} | {kind: "md", markdown: string},
 *   create?: boolean, note?: string|null, rev?: string|null,
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<{action: "created"|"edited", rev: string, kept: string[]}>}
 *   kept: envelope keys the file changes that push leaves as the server has them
 */
export async function push({ serverUrl, token, type, id, file, create = false, note = null, rev = null, fetchImpl = fetch }) {
  const problems = checkPushFile({ type, id, file });
  if (problems.length)
    throw new AkgApiError(`push: 파일 모양이 맞지 않습니다`, { status: 0, body: { error: "bad_file", details: problems } });

  const url = docUrl(serverUrl, type, id);
  const current = await send(fetchImpl, url, { method: "GET", token });

  if (current.status === 404) {
    if (!create)
      throw new AkgApiError(`push: 없는 문서 ${type}/${id} — --create 로 만든다`, { status: 404, body: current.body });
    const doc = file.kind === "md" ? newMdDoc(type, id, file.markdown) : file.doc;
    const res = await send(fetchImpl, `${base(serverUrl)}/api/docs/${encodeURIComponent(type)}`, { method: "POST", token, payload: doc });
    if (res.status === 409 && res.body?.error === "already_exists")
      throw new AkgApiError(`push: ${type}/${id} 가 방금 생겼습니다 — sync 뒤 다시`, res);
    if (res.status !== 201) throw fail("push: 새 문서 실패", res);
    return { action: "created", rev: res.body.rev, kept: [] };
  }
  if (current.status !== 200) throw fail("push: 문서 읽기 실패", current);

  const server = current.body.json;
  const ifMatch = rev ?? current.body.rev;
  const body = file.kind === "md" ? { ...server.body, markdown: file.markdown } : file.doc.body;
  const edited = await send(fetchImpl, url, { method: "PUT", token, rev: ifMatch, note, payload: body });
  if (isStale(edited)) throw new AkgApiError(`push: 서버가 앞섭니다 — sync 뒤 다시`, edited);
  if (edited.status !== 200) throw fail("push: 수정 실패", edited);
  let newRev = edited.body.rev;

  const kept = [];
  if (file.kind === "json") {
    const doc = file.doc;
    const links = doc.links;
    if (Array.isArray(links) && JSON.stringify(links) !== JSON.stringify(edited.body.json?.links ?? [])) {
      const linked = await send(fetchImpl, `${url}/links`, { method: "PUT", token, rev: newRev, payload: { links } });
      if (isStale(linked)) throw new AkgApiError(`push: 본문은 들어갔고 links 는 서버가 앞섭니다 — sync 뒤 다시`, linked);
      if (linked.status !== 200) throw fail("push: 본문은 들어갔고 links 실패", linked);
      newRev = linked.body.rev;
    }
    for (const key of Object.keys(doc)) {
      if (WRITTEN_KEYS.has(key)) continue;
      if (JSON.stringify(doc[key]) !== JSON.stringify(server[key])) kept.push(key);
    }
  }
  return { action: "edited", rev: newRev, kept };
}
