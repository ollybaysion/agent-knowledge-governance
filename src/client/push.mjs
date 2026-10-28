// akg CLI `push`: write one document with the agent token — a new document
// (POST /api/docs/:type), an edit (PUT /api/docs/:type/:id, with the
// envelope's assets beside the body), its links (PUT …/links) and its tags
// (PUT …/tags). The server keeps every slot at inferred or below (D4), so a
// push never confirms anything. Fail-closed like propose: any refusal throws.
//
// The file is either the whole document (.json: envelope + body) or, for a
// type whose body is { name, markdown } (every md type, domain-skill,
// domain), the markdown text (.md): the body's markdown is replaced and the
// envelope and links stay as the server has them. An .md's ![글](./경로.png)
// is uploaded (POST /api/assets) and written as ![글](asset:<sha256>), and
// every asset: picture the md shows joins the envelope's assets[].
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mdImages, replaceImageSrc } from "../md-images.mjs";
import { readImage, storedImageSize, uploadImage } from "./asset-push.mjs";
import { AkgApiError } from "./errors.mjs";

/** Envelope keys push writes; the others belong to their own admin routes. */
const WRITTEN_KEYS = new Set(["schema", "id", "body", "links", "tags", "assets"]);

// A URL (http:, asset:, data: …) or a protocol-relative one is not a file.
const NOT_A_FILE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * The local files an md's pictures name, read and checked before anything is
 * written: src → readImage(). Paths are from `baseDir` (the md file's folder).
 * @throws {AkgApiError} bad_file naming every file that fails
 */
export function readLocalImages(markdown, baseDir = ".", readFile = readFileSync) {
  const out = new Map();
  const details = [];
  for (const { src } of mdImages(markdown)) {
    if (src === "" || NOT_A_FILE.test(src) || out.has(src)) continue;
    try {
      out.set(src, readImage(resolve(baseDir, src), readFile));
    } catch (err) {
      if (!(err instanceof AkgApiError)) throw err;
      details.push(...(err.body?.details ?? [err.message]));
    }
  }
  if (details.length)
    throw new AkgApiError("push: md 의 그림 파일을 읽지 못했습니다 — 아무것도 쓰지 않았습니다", { status: 0, body: { error: "bad_file", details } });
  return out;
}

/**
 * Upload the local pictures, write their addresses as asset:<sha256> and add
 * every asset: picture the md shows to `have` (the server's assets[]):
 * alt = the md's ![글], the size from the upload or the stored bytes.
 * @returns {Promise<{markdown: string, assets: object[], uploaded: {src: string, sha256: string}[]}>}
 */
async function attachImages({ serverUrl, token, fetchImpl, markdown, locals, have }) {
  const sent = new Map(); // src → upload answer
  for (const [src, image] of locals) sent.set(src, await uploadImage({ serverUrl, token, image, fetchImpl }));
  const out = replaceImageSrc(markdown, ({ src }) => (sent.has(src) ? `asset:${sent.get(src).sha256}` : null));
  const assets = [...have];
  const known = new Set(have.map((a) => a.sha256));
  const sizes = new Map([...sent.values()].map((r) => [r.sha256, r]));
  for (const img of mdImages(out)) {
    if (!img.sha256 || known.has(img.sha256)) continue;
    known.add(img.sha256);
    const size = sizes.get(img.sha256) ?? (await storedImageSize({ serverUrl, token, sha256: img.sha256, fetchImpl }));
    assets.push({ sha256: img.sha256, ...(img.alt ? { alt: img.alt } : {}), width: size.width, height: size.height });
  }
  return { markdown: out, assets, uploaded: [...sent].map(([src, r]) => ({ src, sha256: r.sha256 })) };
}

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
  if (doc.tags !== undefined && !Array.isArray(doc.tags)) problems.push("tags 는 배열이어야 합니다");
  if (doc.assets !== undefined && !Array.isArray(doc.assets)) problems.push("assets 는 배열이어야 합니다");
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
function newMdDoc(type, id, markdown, assets = []) {
  return {
    schema: `${type}/v1`,
    id,
    keywords: [{ kw: id, inject: "full" }],
    ...(assets.length ? { assets } : {}),
    status: "inactive",
    body: { name: id, markdown },
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {{
 *   serverUrl: string, token: string, type: string, id: string,
 *   file: {kind: "json", doc: any} | {kind: "md", markdown: string, baseDir?: string},
 *   create?: boolean, note?: string|null, rev?: string|null,
 *   fetchImpl?: typeof fetch, readFile?: typeof readFileSync,
 * }} opts  baseDir: where an .md's relative picture paths start (its folder)
 * @returns {Promise<{action: "created"|"edited", rev: string, kept: string[], uploaded: {src: string, sha256: string}[]}>}
 *   kept: envelope keys the file changes that push leaves as the server has them;
 *   uploaded: the .md's local pictures, as they went up
 */
export async function push({ serverUrl, token, type, id, file, create = false, note = null, rev = null, fetchImpl = fetch, readFile = readFileSync }) {
  const problems = checkPushFile({ type, id, file });
  if (problems.length)
    throw new AkgApiError(`push: 파일 모양이 맞지 않습니다`, { status: 0, body: { error: "bad_file", details: problems } });
  const locals = file.kind === "md" ? readLocalImages(file.markdown, file.baseDir, readFile) : new Map();

  const url = docUrl(serverUrl, type, id);
  const current = await send(fetchImpl, url, { method: "GET", token });
  if (current.status !== 404 && current.status !== 200) throw fail("push: 문서 읽기 실패", current);
  if (current.status === 404 && !create)
    throw new AkgApiError(`push: 없는 문서 ${type}/${id} — --create 로 만든다`, { status: 404, body: current.body });

  const server = current.status === 200 ? current.body.json : null;
  const have = server?.assets ?? [];
  const md =
    file.kind === "md" ? await attachImages({ serverUrl, token, fetchImpl, markdown: file.markdown, locals, have }) : null;
  const uploaded = md?.uploaded ?? [];

  if (!server) {
    const doc = md ? newMdDoc(type, id, md.markdown, md.assets) : file.doc;
    const res = await send(fetchImpl, `${base(serverUrl)}/api/docs/${encodeURIComponent(type)}`, { method: "POST", token, payload: doc });
    if (res.status === 409 && res.body?.error === "already_exists")
      throw new AkgApiError(`push: ${type}/${id} 가 방금 생겼습니다 — sync 뒤 다시`, res);
    if (res.status !== 201) throw fail("push: 새 문서 실패", res);
    return { action: "created", rev: res.body.rev, kept: [], uploaded };
  }

  const ifMatch = rev ?? current.body.rev;
  // The envelope's assets ride beside the body when they change.
  const assets = md ? md.assets : file.doc.assets;
  const withAssets = Array.isArray(assets) && !same(assets, have) ? { assets } : {};
  const body = md ? { ...server.body, markdown: md.markdown } : file.doc.body;
  const edited = await send(fetchImpl, url, { method: "PUT", token, rev: ifMatch, note, payload: { ...body, ...withAssets } });
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
    // The file's tags as they are; the same tags as the server's: nothing to write.
    const tags = doc.tags;
    if (Array.isArray(tags) && JSON.stringify(tags) !== JSON.stringify(edited.body.json?.tags ?? [])) {
      const tagged = await send(fetchImpl, `${url}/tags`, { method: "PUT", token, rev: newRev, payload: { tags } });
      if (isStale(tagged)) throw new AkgApiError(`push: 본문은 들어갔고 tags 는 서버가 앞섭니다 — sync 뒤 다시`, tagged);
      if (tagged.status !== 200) throw fail("push: 본문은 들어갔고 tags 실패", tagged);
      newRev = tagged.body.rev;
    }
    for (const key of Object.keys(doc)) {
      if (WRITTEN_KEYS.has(key)) continue;
      if (JSON.stringify(doc[key]) !== JSON.stringify(server[key])) kept.push(key);
    }
  }
  return { action: "edited", rev: newRev, kept, uploaded };
}
