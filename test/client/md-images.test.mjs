// ![글](asset:<sha256>): the reading view's parse (block · inline), the
// figure data, and the md scan the save check reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { inlineRuns, parseBlocks } from "../../public/lib/md-parse.mjs";
import { assetSrc, figureOf } from "../../public/lib/doc-assets.mjs";
import { assetRef, mdImages } from "../../src/md-images.mjs";

const A = createHash("sha256").update("a").digest("hex");
const B = createHash("sha256").update("b").digest("hex");

test("a picture alone on its line is a block; it ends the paragraph above it", () => {
  const blocks = parseBlocks(`글 한 줄\n![관리도](asset:${A})\n\n  ![](asset:${B})  \n뒤 글`);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["p", "img", "img", "p"],
  );
  assert.deepEqual(blocks[1], { type: "img", alt: "관리도", sha256: A, line: 1 });
  assert.deepEqual(blocks[2], { type: "img", alt: "", sha256: B, line: 3 });
});

test("a picture inside a line is an inline run; an address other than asset: stays text", () => {
  assert.deepEqual(inlineRuns(`센서 ![아이콘](asset:${A}) 를 누른다`), [
    { text: "센서 " },
    { img: A, alt: "아이콘" },
    { text: " 를 누른다" },
  ]);
  assert.deepEqual(inlineRuns("![x](https://a.b/c.png)"), [{ text: "!" }, { link: "x", href: "https://a.b/c.png" }]);
  assert.deepEqual(inlineRuns("![x](./c.png)"), [{ text: "![x](./c.png)" }]);
  assert.deepEqual(parseBlocks("![x](./c.png)")[0].type, "p");
  assert.deepEqual(inlineRuns(`\`![x](asset:${A})\``), [{ code: `![x](asset:${A})` }]);
});

test("figureOf: the md's alt first, the entry's alt for an empty one, the entry's size", () => {
  const entry = { sha256: A, alt: "첨부 글", width: 640, height: 320 };
  assert.deepEqual(figureOf(A, { alt: "본문 글", entry }), { sha256: A, src: `/api/assets/${A}`, alt: "본문 글", width: 640, height: 320 });
  assert.equal(figureOf(A, { alt: "", entry }).alt, "첨부 글");
  assert.deepEqual(figureOf(A), { sha256: A, src: assetSrc(A), alt: "", width: null, height: null });
});

test("mdImages: every picture with its md line, fenced code and inline code left out", () => {
  const md = [
    "# 제목",
    `![a](asset:${A}) 와 ![b](http://x/y.png)`,
    "```",
    "![c](./in-fence.png)",
    "```",
    "`![d](./in-code.png)` 뒤 ![e](./e.png)",
    "![f]()",
  ].join("\n");
  assert.deepEqual(mdImages(md), [
    { line: 2, alt: "a", src: `asset:${A}`, sha256: A },
    { line: 2, alt: "b", src: "http://x/y.png", sha256: null },
    { line: 6, alt: "e", src: "./e.png", sha256: null },
    { line: 7, alt: "f", src: "", sha256: null },
  ]);
  assert.equal(assetRef(`asset:${A.toUpperCase()}`), null);
});
