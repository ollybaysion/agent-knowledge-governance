import { test } from "node:test";
import assert from "node:assert/strict";

import { acceptFrom, answerIdOf, embedCloseMessage, pushRecentAnswer } from "../../public/lib/from-url.mjs";

const FE = "https://fe.example/fdc";

test("an address inside the FE app is taken as it is", () => {
  assert.equal(acceptFrom("https://fe.example/fdc/chat?m=m_7f3a2c", FE), "https://fe.example/fdc/chat?m=m_7f3a2c");
  assert.equal(acceptFrom("https://fe.example/fdc", FE), "https://fe.example/fdc");
  assert.equal(acceptFrom("https://fe.example/x", "https://fe.example/"), "https://fe.example/x");
});

test("an address outside the FE address is refused", () => {
  for (const from of [
    "https://evil.example/fdc/chat",
    "http://fe.example/fdc/chat",
    "https://fe.example:8443/fdc/chat",
    "https://fe.example/fdcx/chat",
    "https://fe.example/other",
    "https://user:pw@fe.example/fdc/chat",
    "javascript:alert(1)",
    "//evil.example/fdc",
    "/fdc/chat",
    "",
  ])
    assert.equal(acceptFrom(from, FE), null, from);
});

test("without an FE address nothing is taken", () => {
  assert.equal(acceptFrom("https://fe.example/fdc/chat", null), null);
  assert.equal(acceptFrom("https://fe.example/fdc/chat", ""), null);
  assert.equal(acceptFrom(null, FE), null);
});

test("answerIdOf reads the m_ id an FE address names", () => {
  assert.equal(answerIdOf("https://fe.example/fdc/chat?m=m_7f3a2c"), "m_7f3a2c");
  assert.equal(answerIdOf("https://fe.example/fdc/debug/m_ab12"), "m_ab12");
  assert.equal(answerIdOf("https://fe.example/fdc/chat"), null);
});

test("the recent answers keep five, newest first, each address once", () => {
  let list = [];
  for (let i = 1; i <= 7; i++) list = pushRecentAnswer(list, { url: `u${i}` });
  assert.deepEqual(list.map((x) => x.url), ["u7", "u6", "u5", "u4", "u3"]);
  list = pushRecentAnswer(list, { url: "u4" });
  assert.deepEqual(list.map((x) => x.url), ["u4", "u7", "u6", "u5", "u3"]);
});

test("embed Escape: akg:close to the FE origin, only embedded, only Escape, only with nothing open", () => {
  const base = { embed: true, feUrl: FE, key: "Escape", popupOpen: false };
  assert.deepEqual(embedCloseMessage(base), { message: { type: "akg:close" }, targetOrigin: "https://fe.example" });
  assert.equal(embedCloseMessage({ ...base, embed: false }), null);
  assert.equal(embedCloseMessage({ ...base, key: "Enter" }), null);
  assert.equal(embedCloseMessage({ ...base, popupOpen: true }), null);
});

test("embed Escape: no FE address, no message — never a \"*\" target", () => {
  for (const feUrl of [null, "", "not a url", "javascript:alert(1)"])
    assert.equal(embedCloseMessage({ embed: true, feUrl, key: "Escape", popupOpen: false }), null, String(feUrl));
});
