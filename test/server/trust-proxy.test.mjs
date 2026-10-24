// Behind nginx every request arrives from 127.0.0.1. The failed-auth rate limit
// keys on request.ip, so before trustProxy one client's twenty bad tokens made
// every client 429. app.inject's peer is 127.0.0.1, the same loopback hop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { clearAuthFailures, hashToken, saveUsers } from "../../server/auth.mjs";

const auth = (token) => ({ authorization: `Bearer ${token}` });

test("the rate limit counts the forwarded client address, not the loopback proxy", async () => {
  const home = mkdtempSync(join(tmpdir(), "akg-trust-proxy-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
  ]);
  const app = await buildApp({
    storeDir: join(home, "store"),
    usersPath: join(home, "users.json"),
  });
  const get = (ip, token) =>
    app.inject({
      method: "GET",
      url: "/api/proposals",
      headers: { ...auth(token), "x-forwarded-for": ip },
    });

  for (let i = 0; i < 20; i++) {
    assert.equal((await get("10.77.0.1", "wrong")).statusCode, 401);
  }
  assert.equal((await get("10.77.0.1", "wrong")).statusCode, 429);
  assert.equal((await get("10.77.0.2", "edtok")).statusCode, 200);

  clearAuthFailures("10.77.0.1");
  await app.close();
  rmSync(home, { recursive: true, force: true });
});
