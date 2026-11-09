// At boot the server writes rendered/types.json again when the type list it
// makes differs from the file: a release that adds a code type (starter) would
// otherwise ship that type's folder in the bundle while the file still lacks
// it, and a mirror CLI older than the release refuses the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApp } from "../../server/app.mjs";
import { commitFiles } from "../../server/store.mjs";
import { typeEntries } from "../../server/types.mjs";
import { listedTypeIds, syncMirror } from "../../src/mirror/sync.mjs";
import { signIn, as } from "../sign-in.mjs";

const EXAMPLES = new URL("../../examples/", import.meta.url);

// The mirror type folders an akg CLI before starter knew by itself (f9f846b src/mirror/sync.mjs ALLOWED_TYPE_DIRS).
const OLD_CLI_TYPE_DIRS = ["db-schema", "msg-format", "domain", "domain-skill", "manual", "voc", "unclassified"];

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "akg-types-startup-"));
  const auth = await signIn(home, [
    { id: "ed", group: "admin", token: "edtok" },
    { id: "bot", group: "agent", token: "vtok" },
  ]);
  const storeDir = join(home, "store");
  let app = await buildApp({ storeDir, auth });
  const git = (...args) => execFileSync("git", ["-C", storeDir, ...args], { encoding: "utf8" }).trim();
  return {
    storeDir,
    get app() {
      return app;
    },
    async reboot() {
      await app.close();
      app = await buildApp({ storeDir, auth });
    },
    commits: () => Number(git("rev-list", "--count", "HEAD")),
    lastMessage: () => git("log", "-1", "--format=%s"),
    lastAuthor: () => git("log", "-1", "--format=%an"),
    rendered: () => JSON.parse(readFileSync(join(storeDir, "rendered", "types.json"), "utf8")),
    cleanup: async () => {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function fetchImplFromApp(app) {
  return async (url) => {
    const u = new URL(url);
    const res = await app.inject({ method: "GET", url: u.pathname + u.search, headers: as("vtok") });
    return {
      status: res.statusCode,
      headers: { get: (name) => res.headers[name.toLowerCase()] },
      arrayBuffer: async () => {
        const buf = res.rawPayload;
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  };
}

const defaults = () => typeEntries({ order: [], registered: [{ id: "voc", label: "VOC", color: "#4e9a5a", status: "active" }] });

test("boot: a store without store/types.json gets rendered/types.json from the default list, in one commit; store/types.json stays absent", async () => {
  const t = await setup();
  try {
    assert.deepEqual(t.rendered(), { types: defaults() });
    assert.ok(t.rendered().types.some((x) => x.id === "starter"));
    assert.equal(existsSync(join(t.storeDir, "types.json")), false);
    assert.match(t.lastMessage(), /^타입 목록 파일 맞춤/);
    assert.equal(t.lastAuthor(), "akg-server");
    assert.equal(t.commits(), 2, "init store, then the type list file");
    const types = await t.app.inject({ method: "GET", url: "/api/types", headers: as("reader") });
    assert.equal(types.json().rev, null, "the stored list is still the defaults");
  } finally {
    await t.cleanup();
  }
});

test("boot: a file that already says the list is left alone — no commit", async () => {
  const t = await setup();
  try {
    const before = t.commits();
    await t.reboot();
    await t.reboot();
    assert.equal(t.commits(), before);
  } finally {
    await t.cleanup();
  }
});

test("boot: a list saved by an older release (no starter) is written again; store/types.json keeps its order and registered types", async () => {
  const t = await setup();
  try {
    const old = {
      order: ["voc", "db-schema", "msg-format", "domain-skill", "domain", "screen-map", "manual", "fab-line", "meeting-notes"],
      registered: [
        { id: "voc", label: "VOC", color: "#4e9a5a", status: "active" },
        { id: "meeting-notes", label: "회의록", color: "#7a4bd7", status: "active" },
      ],
    };
    const stale = { types: typeEntries(old).filter((x) => x.id !== "starter") };
    await commitFiles(t.storeDir, {
      author: "renoir",
      message: "an older release's type list",
      writes: [
        { relpath: "types.json", content: JSON.stringify(old, null, 2) + "\n" },
        { relpath: "rendered/types.json", content: JSON.stringify(stale, null, 2) + "\n" },
      ],
    });
    const storedBefore = readFileSync(join(t.storeDir, "types.json"), "utf8");
    const before = t.commits();
    await t.reboot();
    assert.equal(t.commits(), before + 1);
    assert.deepEqual(t.rendered(), { types: typeEntries(old) });
    assert.deepEqual(
      t.rendered().types.map((x) => x.id),
      ["voc", "db-schema", "msg-format", "domain-skill", "domain", "screen-map", "manual", "fab-line", "meeting-notes", "starter", "unclassified"],
    );
    assert.equal(readFileSync(join(t.storeDir, "types.json"), "utf8"), storedBefore);
  } finally {
    await t.cleanup();
  }
});

// The scene behind the change: an active starter document and a type list
// file without starter. A CLI before starter takes a type folder only when its
// own list or the bundle's types.json names it.
test("reproduction: after boot the bundle's types.json names starter, the folder an older CLI does not know", async () => {
  const t = await setup();
  try {
    await commitFiles(t.storeDir, {
      author: "renoir",
      message: "stale list",
      writes: [{ relpath: "rendered/types.json", content: JSON.stringify({ types: defaults().filter((x) => x.id !== "starter") }) + "\n" }],
    });
    await t.reboot();
    const doc = JSON.parse(readFileSync(new URL("starter/eqp-basics.json", EXAMPLES), "utf8"));
    assert.equal((await t.app.inject({ method: "POST", url: "/api/docs/starter", headers: as("edtok"), payload: doc })).statusCode, 201);

    const mirrorDir = join(mkdtempSync(join(tmpdir(), "akg-types-startup-mirror-")), "akg");
    await syncMirror({ serverUrl: "http://x", token: "vtok", mirrorDir, fetchImpl: fetchImplFromApp(t.app) });
    assert.ok(existsSync(join(mirrorDir, "starter", "eqp-basics", "STARTER.md")));
    assert.equal(OLD_CLI_TYPE_DIRS.includes("starter"), false);
    const oldAllowed = new Set([...OLD_CLI_TYPE_DIRS, ...(listedTypeIds(mirrorDir) ?? [])]);
    assert.ok(oldAllowed.has("starter"), "the older CLI's rule takes the starter folder");
  } finally {
    await t.cleanup();
  }
});
