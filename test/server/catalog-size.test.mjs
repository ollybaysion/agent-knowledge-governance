import { test } from "node:test";
import assert from "node:assert/strict";

import { sizeOf } from "../../server/catalog.mjs";

test("sizeOf: markdown 을 가진 본문은 그 글의 글자 수, 그 밖의 본문은 JSON 으로 적은 길이", () => {
  assert.equal(sizeOf({ name: "a", markdown: "# 제목\n\n본문" }), 8);
  assert.equal(sizeOf({ markdown: "" }), 0);
  assert.equal(sizeOf({ table: "T" }), '{"table":"T"}'.length);
  assert.equal(sizeOf(undefined), 0);
  assert.equal(sizeOf(null), 0);
});
