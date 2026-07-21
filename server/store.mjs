// git store (design §D2, §11 S9-S12): store/<type>/<id>.json is the only
// thing writers ever change directly. Every mutation is one commit; the
// commit's --author is the acting user/agent, so `git log` is the audit
// trail verbatim (no separate audit DB).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git, isCleanRepo } from "./git.mjs";

const ID_RE = /^[a-z0-9._-]+$/;
const ACTOR_RE = /^[a-zA-Z0-9:_-]+$/;

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Non-throwing form — route entry points use this to answer 400 themselves
 * (the app has no StoreError handler, so a throw would surface as a 500).
 */
export function isValidId(id) {
  return typeof id === "string" && ID_RE.test(id) && !id.includes("..");
}

export function validateId(id) {
  if (!isValidId(id)) {
    throw new StoreError(`유효하지 않은 id: ${JSON.stringify(id)}`, 400);
  }
  return id;
}

// S11 + CS7: id·경로 파라미터는 그대로 파일 경로가 된다. 가드는 두 겹이고 둘 다 필요하다.
//
// ① 상위 참조(`..`) 금지 — store 루트 검사만으로는 store *내부*의 하위트리 간
//    이동을 못 막는다. `proposals/pending/<pid>`의 pid에 `../../db-schema/x`가
//    들어오면 루트 안에 머무르므로 통과해 버렸다(editor가 approver 전용
//    DELETE를 우회하던 경로). 정당한 relpath는 전부 리터럴 접두사 + id 형태라
//    `..`를 쓸 일이 없으므로, 세그먼트 단위로 전면 거부한다. 그러면 relpath는
//    자기 리터럴 접두사가 정한 하위트리를 벗어날 수 없다.
// ② store 루트 밖 금지 — 절대경로 part나 심링크된 루트에 대한 최종 백스톱.
function safeJoin(dir, ...parts) {
  for (const part of parts) {
    if (String(part).split(/[/\\]/).includes("..")) {
      throw new StoreError(
        `경로에 상위 참조가 있습니다: ${parts.join("/")}`,
        400,
      );
    }
  }
  const p = resolve(dir, ...parts);
  const base = resolve(dir);
  if (p !== base && !p.startsWith(base + "/")) {
    throw new StoreError(
      `경로가 store 밖을 가리킵니다: ${parts.join("/")}`,
      400,
    );
  }
  return p;
}

/** Idempotent: creates+inits an empty store, or verifies an existing one is a clean git repo. */
export function initStore(dir) {
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.name", "akg-server"]);
    git(dir, ["config", "user.email", "akg-server@akg.local"]);
    writeFileSync(join(dir, ".gitkeep"), "");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init store"]);
    return;
  }
  assertClean(dir);
}

// S9: index.lock이나 더티 트리가 있으면 기동 자체를 거부한다 — 관리자 수동 git
// 개입이나 크래시한 프로세스의 흔적을 서버가 조용히 덮어쓰지 않게.
export function assertClean(dir) {
  if (!existsSync(join(dir, ".git"))) {
    throw new StoreError(`${dir}는 git 레포가 아닙니다`, 500);
  }
  if (existsSync(join(dir, ".git", "index.lock"))) {
    throw new StoreError(
      `${dir}/.git/index.lock 존재 — 이전 git 프로세스가 비정상 종료된 흔적일 수 있습니다. 확인 후 수동 제거하세요.`,
      500,
    );
  }
  if (!isCleanRepo(dir)) {
    throw new StoreError(
      `${dir}에 커밋되지 않은 변경이 있습니다 — store/는 서버만 씁니다(S9). 수동 git 개입을 확인하세요.`,
      500,
    );
  }
}

// S10: rev(=해당 경로 최종 커밋 해시)는 매 요청마다 `git log -1`을 부르면 이력
// 성장과 함께 느려진다. 쓰기 직후엔 커밋 해시를 이미 알고 있으니 캐시에 채워
// 넣고, 콜드 리드(서버 기동 직후 아직 캐시에 없는 경로)만 한 번 계산해 캐시한다.
const revCaches = new Map(); // dir -> Map<relpath, rev>

function cacheFor(dir) {
  let c = revCaches.get(dir);
  if (!c) revCaches.set(dir, (c = new Map()));
  return c;
}

export function revOfPath(dir, relpath) {
  const cache = cacheFor(dir);
  if (cache.has(relpath)) return cache.get(relpath);
  const out = git(dir, ["log", "-1", "--format=%H", "--", relpath]).trim();
  const rev = out || null;
  cache.set(relpath, rev);
  return rev;
}

function invalidateCache(dir) {
  revCaches.delete(dir);
}

export function readJson(dir, relpath) {
  const p = safeJoin(dir, relpath);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function readText(dir, relpath) {
  const p = safeJoin(dir, relpath);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

export function readJsonAtRev(dir, relpath, rev) {
  let out;
  try {
    out = git(dir, ["show", `${rev}:${relpath}`]);
  } catch {
    return null;
  }
  return JSON.parse(out);
}

export function listIds(dir, type) {
  const typeDir = safeJoin(dir, type);
  if (!existsSync(typeDir)) return [];
  return readdirSync(typeDir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    .map((f) => f.slice(0, -".json".length));
}

function authorString(actor) {
  if (!ACTOR_RE.test(actor)) {
    throw new StoreError(`유효하지 않은 actor: ${JSON.stringify(actor)}`, 400);
  }
  return `${actor} <${actor}@akg.local>`;
}

/**
 * One commit: write/remove a set of files, then `git commit --author`.
 * @param {string} dir store root
 * @param {{author: string, message: string, writes?: {relpath:string, content:string}[], removes?: string[]}} change
 * @returns {string} new HEAD rev
 */
export function commitFiles(
  dir,
  { author, message, writes = [], removes = [] },
) {
  const touched = [];
  for (const { relpath, content } of writes) {
    const p = safeJoin(dir, relpath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    touched.push(relpath);
  }
  for (const relpath of removes) {
    const p = safeJoin(dir, relpath);
    if (existsSync(p)) rmSync(p);
    touched.push(relpath);
  }
  if (touched.length === 0) throw new StoreError("커밋할 변경이 없습니다", 400);

  git(dir, ["add", "-A", "--", ...touched]);
  // S12: 커밋 메시지·author는 항상 spawn argv의 개별 원소로 전달 — shell 경유 금지.
  git(dir, ["commit", "-q", "--author", authorString(author), "-m", message]);
  const rev = git(dir, ["rev-parse", "HEAD"]).trim();

  const cache = cacheFor(dir);
  for (const relpath of touched) cache.set(relpath, rev);
  return rev;
}

export function relPathOf(dir, absPath) {
  return relative(dir, absPath);
}

export { invalidateCache };
