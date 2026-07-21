import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installSkills,
  manifestPath,
} from "../../src/mirror/install-skills.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "akg-install-"));
  const sourceDir = join(dir, "mirror", "domain-skill");
  const skillsDir = join(dir, "skills");
  mkdirSync(sourceDir, { recursive: true });
  return { dir, sourceDir, skillsDir };
}

function seedSkill(sourceDir, name, body = "hello") {
  mkdirSync(join(sourceDir, name), { recursive: true });
  writeFileSync(
    join(sourceDir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n\n# ${name}\n`,
  );
}

function handWritten(skillsDir, name, text = "mine") {
  mkdirSync(join(skillsDir, name), { recursive: true });
  writeFileSync(join(skillsDir, name, "SKILL.md"), text);
}

test("first install lands SKILL.md where an agent will find it", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "fdc-explain-sensor");

  const r = installSkills({ sourceDir, skillsDir, rev: "abc123" });

  assert.deepEqual(r.installed, ["fdc-explain-sensor"]);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.skipped, []);
  const target = join(skillsDir, "fdc-explain-sensor", "SKILL.md");
  assert.ok(existsSync(target));
  assert.match(readFileSync(target, "utf8"), /name: fdc-explain-sensor/);

  const manifest = JSON.parse(readFileSync(manifestPath(skillsDir), "utf8"));
  assert.equal(manifest.skills["fdc-explain-sensor"].rev, "abc123");
});

test("re-install overwrites content without duplicating the claim", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "a-skill", "v1");
  installSkills({ sourceDir, skillsDir });

  seedSkill(sourceDir, "a-skill", "v2");
  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r.installed, ["a-skill"]);
  assert.match(
    readFileSync(join(skillsDir, "a-skill", "SKILL.md"), "utf8"),
    /description: v2/,
  );
  const manifest = JSON.parse(readFileSync(manifestPath(skillsDir), "utf8"));
  assert.deepEqual(Object.keys(manifest.skills), ["a-skill"]);
});

test("a file dropped from the skill does not survive in the installed copy", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "a-skill");
  writeFileSync(join(sourceDir, "a-skill", "reference.md"), "extra");
  installSkills({ sourceDir, skillsDir });
  assert.ok(existsSync(join(skillsDir, "a-skill", "reference.md")));

  rmSync(join(sourceDir, "a-skill", "reference.md"));
  installSkills({ sourceDir, skillsDir });

  assert.ok(!existsSync(join(skillsDir, "a-skill", "reference.md")));
});

test("re-running at the same rev reports no work, because none was done", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "a-skill");
  const first = installSkills({ sourceDir, skillsDir, rev: "r1" });
  assert.deepEqual(first.installed, ["a-skill"]);

  const second = installSkills({ sourceDir, skillsDir, rev: "r1" });

  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.unchanged, ["a-skill"]);
  assert.ok(existsSync(join(skillsDir, "a-skill", "SKILL.md")));
});

test("a hand-deleted skill comes back even at an unchanged rev", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "a-skill");
  installSkills({ sourceDir, skillsDir, rev: "r1" });
  rmSync(join(skillsDir, "a-skill"), { recursive: true });

  const r = installSkills({ sourceDir, skillsDir, rev: "r1" });

  assert.deepEqual(r.installed, ["a-skill"]);
  assert.ok(existsSync(join(skillsDir, "a-skill", "SKILL.md")));
});

test("a new rev reinstalls even when the name is unchanged", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "a-skill", "v1");
  installSkills({ sourceDir, skillsDir, rev: "r1" });

  seedSkill(sourceDir, "a-skill", "v2");
  const r = installSkills({ sourceDir, skillsDir, rev: "r2" });

  assert.deepEqual(r.installed, ["a-skill"]);
  assert.match(
    readFileSync(join(skillsDir, "a-skill", "SKILL.md"), "utf8"),
    /description: v2/,
  );
});

test("a hand-written skill of the same name is never overwritten or claimed", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  handWritten(skillsDir, "fdc-explain-sensor", "my own version");
  seedSkill(sourceDir, "fdc-explain-sensor");

  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r.installed, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].name, "fdc-explain-sensor");
  assert.equal(
    readFileSync(join(skillsDir, "fdc-explain-sensor", "SKILL.md"), "utf8"),
    "my own version",
  );
  const manifest = JSON.parse(readFileSync(manifestPath(skillsDir), "utf8"));
  assert.deepEqual(manifest.skills, {});
});

test("a skill dropped from the corpus is uninstalled — and nothing else is", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "goes-away");
  seedSkill(sourceDir, "stays");
  installSkills({ sourceDir, skillsDir });
  handWritten(skillsDir, "not-ours");

  rmSync(join(sourceDir, "goes-away"), { recursive: true });
  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r.removed, ["goes-away"]);
  assert.ok(!existsSync(join(skillsDir, "goes-away")));
  assert.ok(existsSync(join(skillsDir, "stays", "SKILL.md")));
  assert.ok(existsSync(join(skillsDir, "not-ours", "SKILL.md")));
});

test("an empty corpus with no manifest removes nothing", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  handWritten(skillsDir, "not-ours");

  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r, {
    installed: [],
    unchanged: [],
    removed: [],
    skipped: [],
  });
  assert.ok(existsSync(join(skillsDir, "not-ours", "SKILL.md")));
});

test("a missing domain-skill/ is not a corpus of zero — it removes nothing", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedSkill(sourceDir, "installed-earlier");
  installSkills({ sourceDir, skillsDir });

  // The mirror has no domain-skill/ at all (a sync without --skills).
  const r = installSkills({ sourceDir: join(dir, "nope"), skillsDir });

  // Documented behaviour: the caller (bin/akg.mjs) only calls this with
  // --skills, so an absent source means the corpus genuinely has no skills.
  assert.deepEqual(r.removed, ["installed-earlier"]);
});

test("skillsDir is created when absent", (t) => {
  const { dir, sourceDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillsDir = join(dir, "nested", "skills");
  seedSkill(sourceDir, "a-skill");

  installSkills({ sourceDir, skillsDir });

  assert.ok(existsSync(join(skillsDir, "a-skill", "SKILL.md")));
});

test("a name that could escape skillsDir is refused", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Names the agents' own frontmatter rule rejects. `.` and `..` cannot be
  // tested through this door — readdirSync never returns them — so the name
  // rule is the second line of defense behind sync's tar-entry check, not the
  // only one.
  for (const bad of ["Upper", "has_underscore", "-leading"]) {
    mkdirSync(join(sourceDir, bad), { recursive: true });
    writeFileSync(join(sourceDir, bad, "SKILL.md"), "x");
  }

  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r.installed, []);
  assert.equal(r.skipped.length, 3);
  assert.ok(r.skipped.every((s) => s.reason === "invalid skill name"));
});

test("a directory without SKILL.md is not a skill", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(sourceDir, "not-a-skill"), { recursive: true });
  writeFileSync(join(sourceDir, "not-a-skill", "README.md"), "x");

  const r = installSkills({ sourceDir, skillsDir });

  assert.deepEqual(r, {
    installed: [],
    unchanged: [],
    removed: [],
    skipped: [],
  });
  assert.ok(!existsSync(join(skillsDir, "not-a-skill")));
});

test("an unreadable manifest is treated as owning nothing, not as a crash", (t) => {
  const { dir, sourceDir, skillsDir } = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(manifestPath(skillsDir), "{ not json");
  handWritten(skillsDir, "pre-existing");
  seedSkill(sourceDir, "pre-existing");

  const r = installSkills({ sourceDir, skillsDir });

  // Ownership unknown => hands off. Better to under-install than to delete
  // something we cannot prove we put there.
  assert.deepEqual(r.installed, []);
  assert.equal(r.skipped.length, 1);
  assert.equal(
    readFileSync(join(skillsDir, "pre-existing", "SKILL.md"), "utf8"),
    "mine",
  );
});
