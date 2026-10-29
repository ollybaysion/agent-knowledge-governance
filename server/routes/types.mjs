// The document type list: GET for everyone who reads, register · edit ·
// order · close for admin. Each write is one commit of store/types.json and
// its rendered/types.json copy.
import { commitFiles } from "../store.mjs";
import {
  COLOR_RE,
  RESERVED_TYPE_IDS,
  TYPE_ID_RE,
  UNCLASSIFIED,
  isBuiltinTypeId,
  readTypesFile,
  typeEntries,
  typesWrites,
} from "../types.mjs";
import { priorityOf } from "./docs.mjs";

const LABEL_MAX = 40;
const DESCRIPTION_MAX = 200;
const FIELDS = new Set(["label", "color", "description"]);

/** The registered type's fields from a PUT body, or {errors}. */
function typeFields(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { errors: ["몸은 { label, color, description? } 객체입니다"] };
  const errors = [];
  for (const key of Object.keys(body))
    if (!FIELDS.has(key)) errors.push(`모르는 칸입니다 — ${key}`);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > LABEL_MAX) errors.push(`label 은 비지 않은 ${LABEL_MAX}자 이하 문자열입니다`);
  const color = typeof body.color === "string" ? body.color.toLowerCase() : "";
  if (!COLOR_RE.test(color)) errors.push("color 는 #rrggbb 입니다");
  let description;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== "string" || body.description.length > DESCRIPTION_MAX)
      errors.push(`description 은 ${DESCRIPTION_MAX}자 이하 문자열입니다`);
    else description = body.description.trim() || undefined;
  }
  if (errors.length) return { errors };
  return { fields: { label, color, ...(description ? { description } : {}) } };
}

export function registerTypesRoutes(app) {
  const { storeDir, queue, types } = app.akg;

  // Runs `change(file)` on the current types file inside the queue and commits
  // the {file, message} it returns; `change` answers {status, body} to refuse.
  const write = (request, change) =>
    queue.enqueue(
      async () => {
        const { rev, file } = readTypesFile(storeDir);
        const ifMatch = request.headers["if-match"];
        if (ifMatch !== undefined && ifMatch !== rev)
          return { status: 409, body: { error: "unknown_base_rev", currentRev: rev } };
        const next = change(structuredClone(file));
        if (next.status) return next;
        await commitFiles(storeDir, {
          author: request.user.id,
          message: next.message,
          writes: typesWrites(next.file),
        });
        return { status: next.created ? 201 : 200, body: types.list() };
      },
      { priority: priorityOf(request.user) },
    );

  app.get("/api/types", { config: { roles: ["user", "agent"] } }, async () => types.list());

  app.put(
    "/api/types/order",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const order = request.body?.order;
      if (!Array.isArray(order) || !order.every((x) => typeof x === "string"))
        return reply.code(400).send({ error: "order_required" });
      const result = await write(request, (file) => {
        const known = typeEntries(file).map((t) => t.id);
        const given = order.filter((x) => x !== UNCLASSIFIED.id);
        const unknown = given.filter((x) => !known.includes(x));
        const repeated = given.filter((x, i) => given.indexOf(x) !== i);
        const missing = known.filter((x) => x !== UNCLASSIFIED.id && !given.includes(x));
        if (unknown.length || repeated.length || missing.length || order.length - given.length > 1)
          return {
            status: 400,
            body: {
              error: "invalid_order",
              message: "모든 타입 id 를 한 번씩 적습니다 (unclassified 는 늘 마지막)",
              unknown,
              repeated: [...new Set(repeated)],
              missing,
            },
          };
        file.order = given;
        return { file, message: "타입 순서 변경" };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.put(
    "/api/types/:id",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { id } = request.params;
      if (isBuiltinTypeId(id))
        return reply.code(400).send({ error: "builtin_type", message: "코드 타입 · 미분류는 고칠 수 없습니다" });
      if (!TYPE_ID_RE.test(id))
        return reply.code(400).send({ error: "invalid_type_id", message: "id 는 ^[a-z][a-z0-9-]*$ 입니다" });
      if (RESERVED_TYPE_IDS.has(id))
        return reply.code(409).send({ error: "reserved_type_id", message: `${id} 는 예약어입니다` });
      const { fields, errors } = typeFields(request.body);
      if (errors) return reply.code(400).send({ error: "invalid_body", details: errors });

      const result = await write(request, (file) => {
        const registered = file.registered ?? [];
        const at = registered.findIndex((t) => t.id === id);
        if (at >= 0) {
          registered[at] = { id, ...fields, status: registered[at].status ?? "active" };
          file.registered = registered;
          return { file, message: `타입 고침 ${id}` };
        }
        registered.push({ id, ...fields, status: "active" });
        file.registered = registered;
        // A new type goes last, just before unclassified.
        file.order = [...(file.order ?? []).filter((x) => x !== id), id];
        return { file, message: `타입 등록 ${id}`, created: true };
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    "/api/types/:id/archive",
    { config: { roles: ["admin"] } },
    async (request, reply) => {
      const { id } = request.params;
      if (isBuiltinTypeId(id))
        return reply.code(400).send({ error: "builtin_type", message: "코드 타입 · 미분류는 닫을 수 없습니다" });
      const result = await write(request, (file) => {
        const current = (file.registered ?? []).find((t) => t.id === id);
        if (!current) return { status: 404, body: { error: "not_found" } };
        current.status = "archived";
        return { file, message: `타입 닫음 ${id}` };
      });
      return reply.code(result.status).send(result.body);
    },
  );
}
