import { test } from "node:test";
import assert from "node:assert/strict";

import { imageHead } from "../src/image-head.mjs";
import { jpegBytes, pngBytes, webpBytes } from "./fixtures/images.mjs";

test("imageHead reads format and size from PNG, JPEG and all three WebP chunks", () => {
  assert.deepEqual(imageHead(pngBytes(1280, 720)), { mediaType: "image/png", width: 1280, height: 720 });
  assert.deepEqual(imageHead(jpegBytes(800, 600)), { mediaType: "image/jpeg", width: 800, height: 600 });
  for (const chunk of ["VP8 ", "VP8L", "VP8X"])
    assert.deepEqual(imageHead(webpBytes(chunk, 640, 360)), { mediaType: "image/webp", width: 640, height: 360 }, chunk);
});

test("imageHead answers null for anything that is not a readable image", () => {
  assert.equal(imageHead(Buffer.from("GIF89a................................")), null);
  assert.equal(imageHead(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), null);
  assert.equal(imageHead(pngBytes(1280, 720).subarray(0, 20)), null);
  assert.equal(imageHead(pngBytes(0, 720)), null);
});
