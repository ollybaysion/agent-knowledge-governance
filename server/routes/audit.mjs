// §6 GET /api/audit — the audit trail IS `git log` (design §D2), parsed, not
// a separate log table. Every commit's --author is the acting user (S12-safe
// argv, never shell-interpolated — see server/store.mjs commitFiles).
import { git } from "../git.mjs";

const REC_SEP = "\x1e";
const FIELD_SEP = "\x1f";

function parseWindowArg(window) {
  const m = /^(\d+)(h|d|w)$/.exec(window ?? "");
  if (!m) return null;
  const unit = { h: "hours", d: "days", w: "weeks" }[m[2]];
  return `${m[1]} ${unit} ago`;
}

export function registerAuditRoutes(app) {
  const { storeDir } = app.akg;

  app.get(
    "/api/audit",
    { config: { roles: ["viewer"] } },
    async (request, reply) => {
      const { doc, window } = request.query ?? {};
      const args = [
        "log",
        `--format=%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${REC_SEP}`,
      ];

      const since = parseWindowArg(window);
      if (since) args.push(`--since=${since}`);

      if (doc) {
        const [type, id] = String(doc).split("/");
        if (!type || !id)
          return reply.code(400).send({ error: "invalid_doc_param" });
        args.push("--", `${type}/${id}.json`);
      }

      let out;
      try {
        out = git(storeDir, args);
      } catch {
        out = "";
      }
      const entries = out
        .split(REC_SEP)
        .map((rec) => rec.replace(/^\n/, ""))
        .filter(Boolean)
        .map((rec) => {
          const [rev, author, at, message] = rec.split(FIELD_SEP);
          return { rev, author, at, message };
        });
      return { entries };
    },
  );
}
