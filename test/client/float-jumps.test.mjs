import { test } from "node:test";
import assert from "node:assert/strict";

import {
  floatJumps,
  floatRight,
  jumpState,
  jumpTo,
} from "../../public/lib/float-jumps.mjs";

const page = (scrollY) => ({ scrollY, scrollHeight: 5000, innerHeight: 900 });

// A window stand-in that records scrollTo.
function fakeWindow({
  reduce = false,
  scrollHeight = 5000,
  innerHeight = 900,
} = {}) {
  const calls = [];
  return {
    calls,
    innerHeight,
    document: { documentElement: { scrollHeight } },
    matchMedia: (q) => ({
      matches: reduce && q === "(prefers-reduced-motion: reduce)",
    }),
    scrollTo: (opts) => calls.push(opts),
  };
}

test("floatJumps: a db-schema floats 맨 위 · 맨 아래, the other types nothing", () => {
  assert.deepEqual(
    floatJumps("db-schema").map((j) => [j.where, j.label, j.aria, j.icon]),
    [
      ["top", "맨 위", "문서 맨 위로", "up-line"],
      ["bottom", "맨 아래", "문서 맨 아래로", "down-line"],
    ],
  );
  for (const type of [
    "msg-format",
    "domain-skill",
    "domain",
    "manual",
    "screen-map",
    "voc",
    "unclassified",
  ])
    assert.deepEqual(floatJumps(type), []);
});

test("jumpState: a page no longer than the screen by 200 hides the buttons", () => {
  assert.equal(
    jumpState({ scrollY: 0, scrollHeight: 1100, innerHeight: 900 }).show,
    false,
  );
  assert.equal(
    jumpState({ scrollY: 0, scrollHeight: 1101, innerHeight: 900 }).show,
    true,
  );
});

test("jumpState: at the top 맨 위 is off, in the middle both are on, at the bottom 맨 아래 is off", () => {
  assert.deepEqual(jumpState(page(0)), {
    show: true,
    top: true,
    bottom: false,
  });
  assert.deepEqual(jumpState(page(2000)), {
    show: true,
    top: false,
    bottom: false,
  });
  assert.deepEqual(jumpState(page(4100)), {
    show: true,
    top: false,
    bottom: true,
  });
  assert.equal(jumpState(page(4095)).bottom, true);
  assert.equal(jumpState(page(6)).top, true);
});

test("floatRight: 24 from the screen edge, or 24 left of a right panel beside the body", () => {
  assert.equal(floatRight({ viewportWidth: 1024 }), 24);
  assert.equal(floatRight({ viewportWidth: 1440, panelLeft: 1136 }), 328);
});

test("jumpTo: 맨 아래 scrolls to the last screen, 맨 위 to 0, smooth", () => {
  const win = fakeWindow();
  jumpTo("bottom", win);
  jumpTo("top", win);
  assert.deepEqual(win.calls, [
    { top: 4100, behavior: "smooth" },
    { top: 0, behavior: "smooth" },
  ]);
});

test("jumpTo: a reader who asks for less motion jumps at once", () => {
  const win = fakeWindow({ reduce: true });
  jumpTo("bottom", win);
  assert.deepEqual(win.calls, [{ top: 4100, behavior: "auto" }]);
});
