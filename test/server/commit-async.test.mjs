// commitFiles runs git without blocking: a read is answered while a commit is
// running, and it sees the doc as it was before that commit — old content
// with its old rev — until the commit ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { buildApp } from "../../server/app.mjs";
import { signIn, as } from "../sign-in.mjs";

function table(name) {
  return {
    schema: "db-schema/v1",
    id: name,
    keywords: [{ kw: name, inject: "full" }],
    status: "active",
    body: {
      owner: "T",
      table: name.toUpperCase(),
      catalog: { columns: [{ name: "A", type: "NUMBER", nullable: false }], primaryKey: ["A"], fetchedAt: "2026-01-01T00:00:00Z" },
      purpose: { text: null, tier: "scaffold" },
      columnDescs: { A: { text: null, tier: "scaffold" } },
    },
  };
}

test("a GET during a running commit answers before the commit ends, with the doc as it was before it", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-commit-async-test-"));
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, auth: await signIn(home, [{ id: "renoir", group: "admin", token: "aptok" }]) });
  const call = (method, url, payload, headers = {}) =>
    app.inject({ method, url, headers: { ...as("aptok"), ...headers }, ...(payload !== undefined ? { payload } : {}) });
  try {
    for (const id of ["x", "y"]) assert.equal((await call("POST", "/api/docs/db-schema", table(id))).statusCode, 201);
    const before = (await call("GET", "/api/docs/db-schema/x")).json();

    // The next commit waits in a pre-commit hook until the reads are done.
    const started = join(home, "commit-started");
    const hook = join(storeDir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch "${started}"\nsleep 1\n`);
    chmodSync(hook, 0o755);

    let ended = false;
    const write = call("PUT", "/api/docs/db-schema/x/tags", { tags: ["t"] }, { "if-match": before.rev }).then((res) => {
      ended = true;
      return res;
    });
    while (!existsSync(started)) await wait(10);

    const other = await call("GET", "/api/docs/db-schema/y");
    assert.equal(other.statusCode, 200);
    const same = await call("GET", "/api/docs/db-schema/x");
    assert.equal(ended, false, "both reads were answered while the commit ran");
    assert.equal(same.json().rev, before.rev);
    assert.equal(same.json().json.tags, undefined);

    const res = await write;
    assert.equal(res.statusCode, 200, res.body);
    rmSync(hook);
    const after = (await call("GET", "/api/docs/db-schema/x")).json();
    assert.equal(after.rev, res.json().rev);
    assert.notEqual(after.rev, before.rev);
    assert.deepEqual(after.json.tags, ["t"]);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
