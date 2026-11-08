// Personal read tokens, managed from the AKG page (#/read-tokens). Cookie
// session only (config.sessionOnly): a read token or an agent gets 403
// session_only. The writes carry the session's CSRF token like every other
// session write.
//   GET    /api/read-tokens       → {tokens: [{id, label, createdAt, expiresAt, lastUsedAt}], limit}
//   POST   /api/read-tokens       {label, days?} → 201 {id, label, createdAt, expiresAt, token}
//   DELETE /api/read-tokens/:id   → 204
import {
  READ_TOKEN_DAYS,
  READ_TOKEN_DEFAULT_DAYS,
  READ_TOKEN_LABEL_MAX,
  READ_TOKEN_LIMIT,
  cleanLabel,
} from "../read-tokens.mjs";

const config = { roles: ["user"], sessionOnly: true };

export function registerReadTokensRoutes(app) {
  const store = () => app.akg.auth.readTokens;

  app.get("/api/read-tokens", { config }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    return { tokens: await store().list(request.user.id), limit: READ_TOKEN_LIMIT };
  });

  app.post("/api/read-tokens", { config }, async (request, reply) => {
    const body = request.body ?? {};
    const label = cleanLabel(body.label);
    if (label === null)
      return reply.code(400).send({
        error: "invalid_label",
        message: `이름은 1~${READ_TOKEN_LABEL_MAX}자 한 줄입니다`,
      });
    const days = body.days ?? READ_TOKEN_DEFAULT_DAYS;
    if (!READ_TOKEN_DAYS.includes(days))
      return reply.code(400).send({
        error: "invalid_days",
        allowed: READ_TOKEN_DAYS,
        message: `기간은 ${READ_TOKEN_DAYS.join(" · ")}일 가운데 하나입니다`,
      });
    const issued = await store().issue(request.user.id, { label, days });
    if (!issued) return reply.code(409).send({ error: "read_token_limit", limit: READ_TOKEN_LIMIT });
    // The plain token is in this answer alone: no cache keeps it.
    reply.header("cache-control", "no-store");
    return reply.code(201).send(issued);
  });

  app.delete("/api/read-tokens/:id", { config }, async (request, reply) => {
    if (!(await store().revoke(request.user.id, request.params.id)))
      return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });
}
