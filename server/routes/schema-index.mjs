// GET /api/schema-index: every live db-schema document as {table, columns},
// for the reading view's SQL — table names become links, column names links
// with their description. Built again when db-schema/ gets a new commit.
import { listIds, readJson, revOfPath } from "../store.mjs";

const GONE = new Set(["inactive", "archived"]);

/**
 * {id: {table, columns: {COL: {text}}}} from the db-schema documents.
 * text = columnDescs[COL].text, else catalog.columns[].comment, else null.
 * @param {{id: string, status?: string, body?: object}[]} docs
 */
export function schemaIndex(docs) {
  const out = {};
  for (const doc of docs) {
    if (!doc?.id || GONE.has(doc.status)) continue;
    const body = doc.body ?? {};
    const columns = {};
    for (const c of body.catalog?.columns ?? []) {
      if (c?.name) columns[c.name] = { text: body.columnDescs?.[c.name]?.text || c.comment || null };
    }
    for (const [name, slot] of Object.entries(body.columnDescs ?? {})) {
      if (!columns[name] && slot?.text) columns[name] = { text: slot.text };
    }
    out[doc.id] = { table: body.table ?? doc.id.toUpperCase(), columns };
  }
  return out;
}

export function registerSchemaIndexRoutes(app) {
  const { storeDir } = app.akg;
  let cached = { rev: undefined, index: null };
  app.get("/api/schema-index", { config: { roles: ["user", "agent"] } }, async () => {
    const rev = revOfPath(storeDir, "db-schema");
    if (cached.rev !== rev || !cached.index) {
      const docs = listIds(storeDir, "db-schema").map((id) => readJson(storeDir, `db-schema/${id}.json`));
      cached = { rev, index: schemaIndex(docs.filter(Boolean)) };
    }
    return cached.index;
  });
}
