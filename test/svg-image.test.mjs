import { test } from "node:test";
import assert from "node:assert/strict";

import { imageHead } from "../src/image-head.mjs";
import { svgHead, svgProblems } from "../src/svg-image.mjs";
import { svgBytes } from "./fixtures/images.mjs";

const svg = (attrs, inner = "") => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`);

test("svgHead reads the size from width · height, px units, the viewBox, and one side scaled by the viewBox", () => {
  assert.deepEqual(svgHead(svgBytes(640, 360)), { mediaType: "image/svg+xml", width: 640, height: 360 });
  assert.deepEqual(imageHead(svgBytes(640, 360)), { mediaType: "image/svg+xml", width: 640, height: 360 });
  assert.deepEqual(svgHead(svg(`width="120.4px" height='80px'`)), { mediaType: "image/svg+xml", width: 120, height: 80 });
  assert.deepEqual(svgHead(svg(`viewBox="0 0 2656 1312"`)), { mediaType: "image/svg+xml", width: 2656, height: 1312 });
  assert.deepEqual(svgHead(svg(`width="100%" viewBox="0,0,200,100"`)), { mediaType: "image/svg+xml", width: 200, height: 100 });
  assert.deepEqual(svgHead(svg(`width="400" viewBox="0 0 200 100"`)), { mediaType: "image/svg+xml", width: 400, height: 200 });
});

test("svgHead walks past a BOM, the prolog, comments and a plain DOCTYPE", () => {
  const doc = `\uFEFF<?xml version="1.0"?>\n<!-- drawn by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"/>`;
  assert.deepEqual(svgHead(Buffer.from(doc)), { mediaType: "image/svg+xml", width: 32, height: 16 });
});

test("svgHead answers null without a size, for another root, for text and for binary bytes", () => {
  assert.equal(svgHead(svg("")), null);
  assert.equal(svgHead(svg(`width="100%" height="100%"`)), null);
  assert.equal(svgHead(Buffer.from(`<html><svg width="1" height="1"/></html>`)), null);
  assert.equal(svgHead(Buffer.from("svg width=10 height=10, in words")), null);
  assert.equal(svgHead(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x00, 0xff, 0xfe, 0x20, 0x20, 0x20, 0x20, 0x20])), null);
  assert.equal(imageHead(svg(`width="0" height="10"`)), null);
});

test("svgProblems passes a drawn figure: shapes, inline style, its own parts, carried raster and font bytes", () => {
  const inner =
    `<defs><marker id="ar"><path d="M0,0 L10,5 L0,10 z"/></marker><linearGradient id="g"/></defs>` +
    `<style>@font-face { font-family: F; src: url(data:font/woff2;base64,AAAA); } .e { stroke: #111; fill: url(#g); }</style>` +
    `<path class="e" d="M0,0 L10,10" marker-end="url(#ar)"/><use href="#ar"/><text>read only = 1</text>` +
    `<image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/>`;
  assert.deepEqual(svgProblems(svgBytes(100, 50, inner)), []);
});

test("svgProblems refuses code, a document inside, entity declarations and every address that leaves the file", () => {
  const refused = [
    [`<script>alert(1)</script>`, /<script> 요소/],
    [`<g onload="alert(1)"/>`, /이벤트 속성이 있습니다: onload/],
    [`<a href="javascript:alert(1)"><rect/></a>`, /javascript: 주소/],
    [`<a href="&#106;ava&#x73;cript&#58;alert(1)"><rect/></a>`, /javascript: 주소/],
    [`<a href="java\tscript:alert(1)"><rect/></a>`, /javascript: 주소/],
    [`<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>`, /<foreignObject> 요소/],
    [`<image href="https://example.com/a.png"/>`, /파일 밖을 가리키는 주소가 있습니다: https:\/\/example.com\/a.png/],
    [`<use xlink:href="other.svg#x"/>`, /파일 밖을 가리키는 주소/],
    [`<image href="data:image/svg+xml;base64,AAAA"/>`, /파일 밖을 가리키는 주소/],
    [`<style>@import url(a.css);</style>`, /CSS @import/],
    [`<rect fill="url(https://example.com/p.svg#g)"/>`, /파일 밖을 가리키는 주소/],
    [`<rect title="a>b" onclick="x()"/>`, /이벤트 속성이 있습니다: onclick/],
    [`<rect onload=alert(1)>`, /읽지 못한 태그/],
    [`<svg:script xmlns:svg="http://www.w3.org/2000/svg">alert(1)</svg:script>`, /<svg:script> 요소/],
  ];
  for (const [inner, why] of refused) {
    const problems = svgProblems(svgBytes(100, 50, inner));
    assert.ok(problems.some((p) => why.test(p)), `${inner} → ${JSON.stringify(problems)}`);
  }
  const entity = Buffer.from(`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!ENTITY a "b"></svg>`);
  assert.ok(svgProblems(entity).some((p) => /ENTITY/.test(p)));
  const bare = Buffer.from(`<svg width="10" height="10"><rect/></svg>`);
  assert.ok(svgProblems(bare).some((p) => /xmlns/.test(p)));
});
