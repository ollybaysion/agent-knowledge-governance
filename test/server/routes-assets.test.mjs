import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { saveUsers, hashToken } from "../../server/auth.mjs";
import { git } from "../../server/git.mjs";
import { jpegBytes, pngBytes } from "../fixtures/images.mjs";

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-assets-test-"));
  saveUsers(join(home, "users.json"), [
    { id: "renoir", role: "editor", tokenHash: hashToken("edtok") },
    { id: "reader", role: "viewer", tokenHash: hashToken("vtok") },
  ]);
  const storeDir = join(home, "store");
  const app = await buildApp({ storeDir, usersPath: join(home, "users.json") });
  return {
    app,
    storeDir,
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const upload = (app, bytes, contentType, token = "edtok") =>
  app.inject({
    method: "POST",
    url: "/api/assets",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType },
    payload: bytes,
  });

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const head = (storeDir) => git(storeDir, ["rev-parse", "HEAD"]).trim();

test("POST stores bytes + meta in one commit (201); the same bytes again are 200 existed with no commit", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const png = pngBytes(1280, 720);
    const first = await upload(app, png, "image/png");
    assert.equal(first.statusCode, 201, first.body);
    assert.deepEqual(first.json(), {
      sha256: sha(png),
      mediaType: "image/png",
      width: 1280,
      height: 720,
      existed: false,
    });
    assert.deepEqual(readFileSync(join(storeDir, "assets", sha(png))), png);
    const meta = JSON.parse(readFileSync(join(storeDir, "assets", `${sha(png)}.json`), "utf8"));
    assert.equal(meta.uploadedBy, "renoir");
    assert.equal(meta.bytes, png.length);
    const files = git(storeDir, ["show", "--name-only", "--format=", "HEAD"]).trim().split("\n");
    assert.deepEqual(files.sort(), [`assets/${sha(png)}`, `assets/${sha(png)}.json`]);

    const before = head(storeDir);
    const again = await upload(app, png, "image/png");
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().existed, true);
    assert.equal(head(storeDir), before);
  } finally {
    await cleanup();
  }
});

test("POST refuses a header that disagrees with the magic bytes, unreadable bytes, other types, >2MB, and a viewer", async () => {
  const { app, storeDir, cleanup } = await setup();
  try {
    const mismatch = await upload(app, jpegBytes(800, 600), "image/png");
    assert.equal(mismatch.statusCode, 400);
    assert.equal(mismatch.json().error, "media_type_mismatch");
    assert.equal(mismatch.json().detected, "image/jpeg");

    const garbage = await upload(app, Buffer.from("not an image at all, just text"), "image/png");
    assert.equal(garbage.statusCode, 400);
    assert.equal(garbage.json().error, "unreadable_image");

    const gif = await upload(app, Buffer.from("GIF89a"), "image/gif");
    assert.equal(gif.statusCode, 415);

    const big = await upload(app, pngBytes(1280, 720, 2 * 1024 * 1024), "image/png");
    assert.equal(big.statusCode, 413);
    assert.equal(big.json().limitBytes, 2 * 1024 * 1024);

    // Above the global 512 KiB, below 2 MB: this route's own limit applies.
    const mid = await upload(app, pngBytes(1280, 720, 1024 * 1024), "image/png");
    assert.equal(mid.statusCode, 201, mid.body);

    const viewer = await upload(app, pngBytes(10, 10), "image/png", "vtok");
    assert.equal(viewer.statusCode, 403);
    assert.equal(existsSync(join(storeDir, "assets", sha(pngBytes(10, 10)))), false);
  } finally {
    await cleanup();
  }
});

test("GET: 400 for a non-hex name, 404 when absent, bytes with type · immutable cache · ETag, 304 on If-None-Match", async () => {
  const { app, cleanup } = await setup();
  try {
    const bad = await app.inject({ method: "GET", url: "/api/assets/..%2F..%2Fusers.json" });
    assert.equal(bad.statusCode, 400);
    const upper = await app.inject({ method: "GET", url: `/api/assets/${"A".repeat(64)}` });
    assert.equal(upper.statusCode, 400);

    const absent = await app.inject({ method: "GET", url: `/api/assets/${"0".repeat(64)}` });
    assert.equal(absent.statusCode, 404);

    const jpg = jpegBytes(800, 600);
    await upload(app, jpg, "image/jpeg");
    const got = await app.inject({ method: "GET", url: `/api/assets/${sha(jpg)}` });
    assert.equal(got.statusCode, 200);
    assert.equal(got.headers["content-type"], "image/jpeg");
    assert.equal(got.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(got.headers.etag, `"${sha(jpg)}"`);
    assert.deepEqual(got.rawPayload, jpg);

    const cached = await app.inject({
      method: "GET",
      url: `/api/assets/${sha(jpg)}`,
      headers: { "if-none-match": `"${sha(jpg)}"` },
    });
    assert.equal(cached.statusCode, 304);
  } finally {
    await cleanup();
  }
});
