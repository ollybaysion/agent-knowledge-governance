// X-AKG-Note: the section editor names the saved section in the commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { commitNote } from "../../server/routes/docs.mjs";
import { signIn, as } from "../sign-in.mjs";

test("commitNote decodes one line, drops control characters and caps the length", () => {
  assert.equal(commitNote(encodeURIComponent("절 저장: 도메인 지식")), "절 저장: 도메인 지식");
  assert.equal(commitNote(encodeURIComponent("a\nb\r\tc")), "a b c");
  assert.equal(commitNote(encodeURIComponent("x".repeat(200))).length, 80);
  assert.equal(commitNote("%E0%A4%A"), null);
  assert.equal(commitNote(""), null);
  assert.equal(commitNote(undefined), null);
  assert.equal(commitNote(encodeURIComponent(" \n ")), null);
});

test("PUT with X-AKG-Note puts the note after edit <type>/<id> in the commit", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-note-test-"));
  const auth = await signIn(home, [{ id: "renoir", group: "admin", token: "a" }]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth });
  const last = () => execFileSync("git", ["-C", storeDir, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim();
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/docs/voc",
      headers: as("a"),
      payload: { schema: "voc/v1", id: "n", keywords: [{ kw: "n", inject: "pointer" }], status: "active", body: { name: "n", markdown: "# n\n\n## 정리\n\n글\n" } },
    });
    assert.equal(created.statusCode, 201);
    const put = (rev, markdown, note) =>
      app.inject({
        method: "PUT",
        url: "/api/docs/voc/n",
        headers: { ...as("a"), "if-match": rev, ...(note ? { "x-akg-note": encodeURIComponent(note) } : {}) },
        payload: { name: "n", markdown },
      });
    const r1 = await put(created.json().rev, "# n\n\n## 정리\n\n고친 글\n", "절 저장: 정리");
    assert.equal(r1.statusCode, 200);
    assert.equal(last(), "edit voc/n · 절 저장: 정리");
    const r2 = await put(r1.json().rev, "# n\n\n## 정리\n\n또 고친 글\n");
    assert.equal(r2.statusCode, 200);
    assert.equal(last(), "edit voc/n");
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
