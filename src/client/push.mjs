// akg CLI `push` (issue #18): put a whole document into the hub — the write
// the CLI was missing. `propose` offers slot edits for review and
// `catalog-push` replaces one db-schema field; neither can CREATE a document,
// so the only way in was the dashboard or raw curl.
//
// The file may be a bare body (agent-skill-foundry emits spec.json, which IS
// a domain-skill body) or a full envelope. A bare body gets its envelope
// derived here, using src/envelope.mjs's deriveId — the same rule the server
// validates against, so a pushed doc agrees with a validated doc by
// construction.
//
// Create vs update is decided by the server, not by a flag: POST first, and
// fall back to PUT when it answers `already_exists`. A caller that just
// re-ran the factory should not have to know whether this is the first push.
import { deriveId, loadSchemas, validateDocument } from "../envelope.mjs";
import { AkgApiError } from "./errors.mjs";

const base = (serverUrl) => String(serverUrl).replace(/\/+$/, "");
const docsUrl = (serverUrl, type) => `${base(serverUrl)}/api/docs/${encodeURIComponent(type)}`;
const docUrl = (serverUrl, type, id) =>
  `${docsUrl(serverUrl, type)}/${encodeURIComponent(id)}`;

/** A parsed JSON file is an envelope when it carries the two keys only an envelope has. */
export function isEnvelope(parsed) {
  return Boolean(
    parsed &&
      typeof parsed === "object" &&
      typeof parsed.schema === "string" &&
      parsed.body &&
      typeof parsed.body === "object",
  );
}

/**
 * Turn what was in the file into a full document.
 *
 * @param {string} type
 * @param {object} parsed  bare body or full envelope
 * @param {{keywords?: {kw: string, inject: string}[], status?: string}} [opts]
 * @returns {{doc: object, derived: boolean}}
 */
export function buildDocument(type, parsed, { keywords, status } = {}) {
  const schema = `${type}/v1`;

  if (isEnvelope(parsed)) {
    if (parsed.schema !== schema) {
      throw new Error(
        `문서의 schema 가 "${parsed.schema}" 인데 type 은 "${type}" 입니다 — 둘이 같은 타입을 가리켜야 합니다`,
      );
    }
    // Explicit flags still win over what the file carried, so the same file
    // can be pushed active or inactive without editing it.
    const doc = { ...parsed };
    if (keywords) doc.keywords = keywords;
    if (status) doc.status = status;
    return { doc, derived: false };
  }

  const id = deriveId(schema, parsed);
  if (!id) {
    throw new Error(
      `${type} 의 id 를 body 에서 파생할 수 없습니다 — ` +
        (schema === "domain-skill/v1"
          ? "`name` 이 필요합니다"
          : schema === "db-schema/v1"
            ? "`table` 이 필요합니다"
            : schema === "msg-format/v1"
              ? "`command` 가 필요합니다"
              : "이 타입은 bare body 를 받지 않습니다 — envelope 로 주세요"),
    );
  }

  return {
    doc: {
      schema,
      id,
      // One keyword matching the id is the honest default: it is the only
      // string we know names this document. domain-skill ships as a skill
      // tree rather than an injection doc, so its keywords never reach an
      // index — but the envelope requires at least one either way.
      keywords: keywords ?? [{ kw: id, inject: "full" }],
      status: status ?? "active",
      body: parsed,
    },
    derived: true,
  };
}

/** Local validation, before any network call — the same check the server runs. */
export function validateForPush(doc, refs = loadSchemas()) {
  return validateDocument(doc, refs);
}

async function readJsonBody(res) {
  return res.json().catch(() => null);
}

function apiError(action, res, body) {
  return new AkgApiError(
    `${action} failed: HTTP ${res.status}${body?.error ? ` (${body.error})` : ""}`,
    { status: res.status, body },
  );
}

/**
 * Create the document, or update it in place when it already exists.
 *
 * @param {{serverUrl: string, token: string, type: string, doc: object, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{created: boolean, rev: string, rebased?: boolean, envelopeIgnored?: boolean}>}
 */
export async function push({
  serverUrl,
  token,
  type,
  doc,
  fetchImpl = fetch,
}) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  const created = await fetchImpl(docsUrl(serverUrl, type), {
    method: "POST",
    headers,
    body: JSON.stringify(doc),
  });
  const createdBody = await readJsonBody(created);
  if (created.status === 201) return { created: true, rev: createdBody.rev };
  if (!(created.status === 409 && createdBody?.error === "already_exists")) {
    throw apiError("push", created, createdBody);
  }

  // It exists — update it. The rev has to come from the server rather than
  // from anything we hold, because If-Match is what makes a concurrent edit
  // visible instead of silently overwritten (S4/S5).
  const current = await fetchImpl(docUrl(serverUrl, type, doc.id), {
    headers: { authorization: `Bearer ${token}` },
  });
  const currentBody = await readJsonBody(current);
  if (current.status !== 200) throw apiError("push (read rev)", current, currentBody);

  const updated = await fetchImpl(docUrl(serverUrl, type, doc.id), {
    method: "PUT",
    headers: { ...headers, "if-match": currentBody.rev },
    // PUT takes the body alone: the envelope on an existing document belongs
    // to whoever curates it, and this route deliberately cannot rewrite it.
    body: JSON.stringify(doc.body),
  });
  const updatedBody = await readJsonBody(updated);
  if (updated.status !== 200) throw apiError("push (update)", updated, updatedBody);

  // Say so when the envelope we built differs from the stored one, rather
  // than letting the caller believe --keyword/--status took effect.
  const stored = currentBody.json ?? {};
  const envelopeIgnored =
    JSON.stringify(stored.keywords) !== JSON.stringify(doc.keywords) ||
    stored.status !== doc.status;

  return {
    created: false,
    rev: updatedBody.rev,
    rebased: updatedBody.rebased,
    envelopeIgnored,
  };
}
