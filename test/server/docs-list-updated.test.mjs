// GET /api/docs rows carry updatedAt: when the doc's file last changed, for
// the 문서 탭's "최근 수정 순".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { changedAtOfPath, revOfPath } from "../../server/store.mjs";
import { signIn, as } from "../sign-in.mjs";

const voc = (name) => ({
  schema: "voc/v1",
  id: name,
  keywords: [{ kw: name, inject: "pointer" }],
  status: "active",
  body: { name, markdown: `# ${name}\n\n## 받은 말\n\n글\n` },
});

test("each list row has updatedAt, the author time of the doc's last commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-updated-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  try {
    for (const id of ["a", "b"]) {
      const r = await app.inject({ method: "POST", url: "/api/docs/voc", headers: as("a"), payload: voc(id) });
      assert.equal(r.statusCode, 201);
    }
    const res = await app.inject({ method: "GET", url: "/api/docs?type=voc", headers: as("a") });
    const rows = res.json().docs;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const expected = execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%aI", "--", `voc/${row.id}.json`], { encoding: "utf8" }).trim();
      assert.equal(row.updatedAt, expected);
      assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
    assert.equal(changedAtOfPath(storeDir, "voc/a.json"), rows.find((r) => r.id === "a").updatedAt);
    assert.equal(revOfPath(storeDir, "voc/a.json"), rows.find((r) => r.id === "a").rev);
    assert.equal(changedAtOfPath(storeDir, "voc/none.json"), null);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
