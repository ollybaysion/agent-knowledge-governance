// GET /api/docs rows carry updatedAt (the 문서 탭's "최근 수정 순") and the
// body's [[ ]] (the graph's thin edges and 끊긴 연결).
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

test("a list row carries its body's [[ ]] with where each points, and none when the body has none", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-wikirows-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const app = await buildApp({ storeDir: join(home, "store"), auth });
  try {
    const post = (doc) => app.inject({ method: "POST", url: "/api/docs/voc", headers: as("a"), payload: doc });
    assert.equal((await post(voc("a"))).statusCode, 201);
    const b = voc("b");
    b.body.markdown = "# b\n\n## 정리\n\n[[a]] 와 [[nowhere]]\n";
    assert.equal((await post(b)).statusCode, 201);
    const rows = (await app.inject({ method: "GET", url: "/api/docs?type=voc", headers: as("a") })).json().docs;
    const rowB = rows.find((r) => r.id === "b");
    assert.deepEqual(rowB.wikilinks, [
      { text: "a", type: "voc", id: "a", found: true },
      { text: "nowhere", type: null, id: "nowhere", found: false },
    ]);
    assert.equal(rows.find((r) => r.id === "a").wikilinks, undefined);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
