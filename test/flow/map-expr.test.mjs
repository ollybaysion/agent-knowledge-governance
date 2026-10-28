// The spec's 식 표본 (flow-map-node-spec.md) — the same table BE tests.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseExpr, splitMapLine } from "../../src/flow/map-expr.mjs";

test("식 표본: 읽히는 식은 쓰는 이름과 $eqp[n].이름 을 낸다", () => {
  const ok = {
    "a + b * 2": [["a", "b"], []],
    "(a + b) * 2": [["a", "b"], []],
    "-a": [["a"], []],
    'a > 1 ? "x" : b < 2 ? "y" : "z"': [["a", "b"], []],
    "!(a == b) && c != null": [["a", "b", "c"], []],
    '"a\\"b"': [[], []],
    "$eqp.index == 1": [[], []],
    "$eqp[0].param_index": [[], [{ n: 0, name: "param_index" }]],
    "$eqp.size": [[], []],
  };
  for (const [expr, [names, eqp]] of Object.entries(ok)) assert.deepEqual(parseExpr(expr), { names, eqp }, expr);
});

test("식 표본: 틀린 식은 자리나 뜻을 낸다", () => {
  const bad = {
    "a +": "식이 덜 끝났다",
    "f(a)": "메서드 호출은 받지 않는다",
    "a[0]": "$eqp 밖의 대괄호는 받지 않는다",
    "a = b": "대입은 받지 않는다",
    "a ?: b": "4 번째 글자 :",
    "$eqp[x].a": "$eqp[n] 의 n 은 0 이상 정수다",
    "$eqp.foo": "$eqp 뒤에는 .index · .size · [n].이름 이 온다",
    $eqp: "$eqp 뒤에는 .index · .size · [n].이름 이 온다",
    $foo: "$foo 는 없다 — 특수 변수는 $eqp 하나다",
  };
  for (const [expr, why] of Object.entries(bad)) assert.deepEqual(parseExpr(expr), { error: why }, expr);
});

test("Java 밖의 것은 받지 않는다: new · 비트 연산 · 홑따옴표 · 다른 이스케이프 · 필드", () => {
  assert.deepEqual(parseExpr("new Foo"), { error: "new 는 받지 않는다" });
  for (const e of ["a & b", "a | b", "a ^ b", "~a", "a << 1", "a >> 1"]) assert.deepEqual(parseExpr(e), { error: "비트 연산은 받지 않는다" }, e);
  assert.match(parseExpr("'x'").error, /글은 "…" 로 적는다/);
  assert.match(parseExpr('"a\\nb"').error, /이스케이프는/);
  assert.match(parseExpr('"abc').error, /글이 닫히지 않았다/);
  assert.deepEqual(parseExpr("a.b"), { error: ". 는 $eqp 뒤에만 쓴다" });
  assert.deepEqual(parseExpr("$eqp.index(1)"), { error: "메서드 호출은 받지 않는다" });
  assert.deepEqual(parseExpr("$eqp[0]"), { error: "$eqp 뒤에는 .index · .size · [n].이름 이 온다" });
  assert.deepEqual(parseExpr(""), { error: "식이 없다" });
  assert.deepEqual(parseExpr("+a"), { error: "1 번째 글자 +" });
  assert.deepEqual(parseExpr("a b"), { error: "3 번째 글자 b" });
});

test("겹친 삼항 · 글 이어 붙이기 · 같은 이름은 한 번", () => {
  assert.deepEqual(parseExpr('a ? b ? "x" : "y" : c'), { names: ["a", "b", "c"], eqp: [] });
  assert.deepEqual(parseExpr('"E-" + eqp_id'), { names: ["eqp_id"], eqp: [] });
  assert.deepEqual(parseExpr("$eqp.size > 1 ? $eqp[1].v + $eqp[1].v : v * 1.1 % 2"), { names: ["v"], eqp: [{ n: 1, name: "v" }] });
});

test("map 줄은 == · != · <= · >= 밖의 첫 = 에서 나눈다", () => {
  assert.deepEqual(splitMapLine("grade    = value > upper_limit ? \"HIGH\" : \"OK\""), { name: "grade", expr: 'value > upper_limit ? "HIGH" : "OK"' });
  assert.deepEqual(splitMapLine("go = $eqp.index == 1"), { name: "go", expr: "$eqp.index == 1" });
  assert.deepEqual(splitMapLine("x=a<=b"), { name: "x", expr: "a<=b" });
  assert.deepEqual(splitMapLine("x = a = b"), { name: "x", expr: "a = b" });
  for (const line of ["a == b", "a <= b", "$eqp = 1", "x =", "1x = a", "= a"]) assert.equal(splitMapLine(line), null, line);
});
