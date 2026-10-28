// akg CLI `asset-push`, and the local pictures `push` uploads: POST
// /api/assets with the agent token. The media type is the file's own header
// (src/image-head.mjs), the same read the server makes. Fail-closed: any
// refusal throws.
import { readFileSync } from "node:fs";
import { imageHead } from "../image-head.mjs";
import { AkgApiError } from "./errors.mjs";

const base = (serverUrl) => String(serverUrl).replace(/\/+$/, "");

/**
 * A local picture, read and checked before anything is written.
 * @returns {{path: string, bytes: Buffer, mediaType: string, width: number, height: number}}
 * @throws {AkgApiError} bad_file: unreadable, or not PNG · JPEG · WebP
 */
export function readImage(path, readFile = readFileSync) {
  let bytes;
  try {
    bytes = readFile(path);
  } catch (err) {
    throw new AkgApiError(`그림 파일을 읽지 못했습니다: ${path}`, { status: 0, body: { error: "bad_file", details: [`${path}: ${err.message}`] } });
  }
  const head = imageHead(bytes);
  if (!head)
    throw new AkgApiError(`그림 파일이 PNG · JPEG · WebP 가 아닙니다: ${path}`, { status: 0, body: { error: "bad_file", details: [path] } });
  return { path, bytes, ...head };
}

/**
 * Upload one read picture. The same bytes again are the stored ones (existed).
 * @returns {Promise<{sha256: string, mediaType: string, width: number, height: number, existed: boolean}>}
 */
export async function uploadImage({ serverUrl, token, image, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base(serverUrl)}/api/assets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": image.mediaType },
    body: image.bytes,
  });
  const body = await res.json().catch(() => null);
  if (res.status !== 200 && res.status !== 201)
    throw new AkgApiError(`그림 올리기 실패 (${image.path}): HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}`, { status: res.status, body });
  return body;
}

/**
 * A stored picture's size, read from its bytes' header.
 * @returns {Promise<{width: number, height: number}>}
 */
export async function storedImageSize({ serverUrl, token, sha256, fetchImpl = fetch }) {
  const res = await fetchImpl(`${base(serverUrl)}/api/assets/${sha256}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 200)
    throw new AkgApiError(`저장소에 없는 그림입니다: asset:${sha256} — akg asset-push 로 먼저 올립니다`, { status: res.status, body: null });
  const head = imageHead(Buffer.from(await res.arrayBuffer()));
  if (!head) throw new AkgApiError(`저장소 그림을 읽지 못했습니다: ${sha256}`, { status: res.status, body: null });
  return { width: head.width, height: head.height };
}

/** `akg asset-push <파일>`: read, then upload. */
export async function assetPush({ serverUrl, token, path, fetchImpl = fetch, readFile = readFileSync }) {
  return uploadImage({ serverUrl, token, image: readImage(path, readFile), fetchImpl });
}
