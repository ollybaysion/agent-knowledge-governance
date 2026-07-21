# 작업: agent-knowledge-governance(akg) Phase 2 — 소비 연결(A모드): akg CLI `sync` + 미러 + context.json 전환

## 진실원 문서 (먼저 정독)

- `~/repo/agent-knowledge-governance-design.md` (설계 v0.4.7) — 특히 **§4 D1**(분리 경계·context.json 4줄), **§5.6**(미러 번들 레이아웃), **§8.1**(akg CLI), **§8.2**(A모드), **§9.2**(로드맵·합격 기준), **§11 S11**(경로 검증·zip-slip)
- `~/repo/agent-knowledge-governance-json-spec.md` (v0.4.4) — **§5.1**(`rendered/<type>/index.json` 프로바이더 계약), **§5.6 미러 레이아웃**
- 레포 `~/repo/agent-knowledge-governance/`, 브랜치는 `main`에서 `feature/phase-2-cli-sync`를 새로 파서 작업. **git-guard가 main 직접 커밋을 거부하므로 반드시 feature 브랜치**. 커밋은 로컬로만, push·PR은 마지막에 사용자에게 확인받고.

## 범위 (반드시 지킬 것)

- **Phase 2 = 소비(sync)만.** `akg sync`로 서버의 `rendered/` 번들을 로컬 미러로 당기고, context.json 4줄로 claude-hooks의 keyword-docs 프로바이더가 그 미러를 읽게 만드는 것까지.
- **claude-hooks 레포는 한 줄도 수정 금지** (D1: A모드는 claude-hooks 무수정이 핵심). 작업 끝에 `git -C ~/repo/claude-hooks diff --stat`이 비어 있어야 함.
- **하지 말 것**: `akg propose`·`akg catalog-push` CLI 구현(Phase 3), B모드/hub-fetch(Phase 3), 서버 코드 수정(서버 `/api/bundle`은 Phase 1에서 이미 완성 — 절대 손대지 말 것).

## 배경 (현재 상태)

- Phase 1 서버 완성·머지됨(main `28bc888`). 서버에 **`GET /api/bundle?since=<rev>`** 존재 (`server/routes/misc.mjs`): `store/`의 `rendered/` 디렉토리를 `tar -czf - -C <storeDir> rendered`로 gzip tar 스트림 반환. `since`가 현재 HEAD와 같으면 **304**, `rendered/` 없으면 404. 응답 헤더 **`etag: <HEAD rev>`**. 권한 = **viewer**(토큰 필요).
- 서버 `rendered/` 구조: `rendered/db-schema/index.json`, `rendered/db-schema/docs/<id>.md`, `rendered/msg-format/{index.json,docs/*.md}`, `rendered/domain-skill/<name>/SKILL.md`. **index.json이 있는 타입은 db-schema·msg-format 둘뿐**(`server/render-store.mjs`의 `INDEXED_TYPES`). domain-skill은 index 없이 SKILL.md만.
- 리허설 서버가 이미 떠 있음: **포트 8791**, 데이터 dir `/tmp/claude-1000/-home-renoir-repo/5eafbe8b-0956-46f1-8ef4-eebcfccb29e8/scratchpad/akg-live-smoke`, approver 토큰 `0bcf20a2a309918c9a0874c1b26af4b759234f12a7d13c36`, 문서 여러 개 시드됨(testuser.fdc_sensor, testuser.fdc_equipment, cmd-start-lot). 실제 `/api/bundle` 응답으로 CLI를 검증할 수 있음. (서버가 내려가 있으면 `AKG_HOME=<위 dir> AKG_PORT=8791 AKG_HOST=127.0.0.1 node ~/repo/agent-knowledge-governance/server/main.mjs &`로 재기동.)

## 핵심 함정 (여기서 실수하기 쉬움 — 반드시 이렇게)

1. **`rendered/` 접두어 벗기기**: bundle tar는 `rendered/db-schema/…` 형태로 담겨 있음. 하지만 §5.6 미러 레이아웃과 §4 D1 context.json 설정은 **`~/.claude/akg/db-schema/index.json`**(rendered 없음)을 가리킴. 따라서 sync는 tar를 풀 때 **`--strip-components=1`로 `rendered/` 한 겹을 벗겨** `~/.claude/akg/<type>/…`로 배치해야 함.
2. **index.json의 path는 상대**(`docs/<id>.md`). keyword-docs 프로바이더(`lib/doc-index.mjs`의 `docBaseFor`)는 인덱스 파일이 있는 폴더 기준으로 해석하되, **폴더명이 `.claude`면 부모를 base로** 씀. 미러가 `~/.claude/akg/db-schema/index.json`이면 그 폴더명은 `db-schema`(≠`.claude`)이므로 base = `~/.claude/akg/db-schema/` → `docs/<id>.md`가 정확히 풀림. 이 자기완결성이 깨지지 않게 index.json과 docs/를 **같은 타입 폴더 안에** 유지.
3. **원자 교체 + fail-open**: 임시 디렉토리에 완전히 풀고 검증까지 끝낸 뒤 rename으로 교체. **서버 정지·네트워크 실패·손상된 tar일 때 기존 미러를 절대 건드리지 말 것**(fail-open — 이게 합격 기준의 절반). rename 대상은 같은 파일시스템이어야 하니 임시 디렉토리는 `~/.claude/akg/` 옆(예: `~/.claude/akg.tmp-<rand>`)에 생성.
4. **304 처리**: 로컬 미러 `meta.json`의 `rev`를 `since=`로 보내고, 304면 아무것도 안 하고 `{changed:false}` 반환.
5. **zip-slip 방어(S11)**: tar 엔트리에 `../`가 있으면 거부. GNU tar `-C`로 대상을 가두되, 푼 뒤 결과가 예상 타입 폴더(`db-schema`/`msg-format`/`domain-skill`/`meta.json`류)만 있는지 검증. tar 바이너리 spawn을 쓸 것(D2의 git·tar 바이너리 의존 선례와 동일 — 무거운 tar 라이브러리 추가 금지).

## 산출물

1. **`src/mirror/sync.mjs`** — 순수 함수로 테스트 가능하게:
   - `export async function syncMirror({ serverUrl, token, mirrorDir, skills = false, fetchImpl = fetch })` → `{ changed: boolean, rev: string|null }`
   - 알고리즘: ① `mirrorDir/meta.json`에서 로컬 rev 읽기(없으면 null) ② `GET {serverUrl}/api/bundle?since=<rev>` (헤더 `authorization: Bearer <token>`) ③ 304 → `{changed:false, rev}` 반환 ④ 비-2xx → throw(호출자가 fail-open 처리) ⑤ 본문을 Buffer로 받고 `etag`를 newRev로 ⑥ `~/.claude/akg.tmp-<rand>`에 `tar -xzf - -C <tmp> --strip-components=1`로 풀기 ⑦ 구조 검증(알려진 타입 폴더만, `../` 없음) ⑧ `meta.json` 쓰기(`{serverUrl, rev:newRev, syncedAt:<ISO>}`) ⑨ 원자 교체(기존 미러 있으면 `<mirrorDir>.bak-<rand>`로 옮기고 tmp→mirrorDir rename, 성공 시 .bak 삭제, 실패 시 롤백) ⑩ `--skills` 아니면 `domain-skill/`은 제외(SKILL.md 설치는 옵트인).
   - **fail-open은 호출자(CLI) 몫**: syncMirror는 실패 시 throw하되 미러를 손상시키지 않는 것까지 책임. CLI가 catch해서 로그+exit.
2. **`bin/akg.mjs`** — shebang(`#!/usr/bin/env node`) 실행 파일. argv 파싱:
   - `akg sync [--skills] [--server <url>] [--mirror <dir>]`
   - 토큰 해석 우선순위: `AKG_TOKEN` env → `~/.claude/akg/token`(0600, 없으면 에러)
   - 서버 URL: `--server` → `AKG_SERVER` env → 미러 `meta.json`의 `serverUrl` → 에러
   - 미러 dir: `--mirror` → `AKG_MIRROR` env → 기본 `~/.claude/akg`
   - sync 실패 시 stderr에 사유 찍고 **exit 0(fail-open — 미러 온전하면 세션 진행 방해 금지)**, 단 인증 실패(401)나 설정 오류는 exit 1. 성공 시 `synced rev <r> (N docs)` 또는 `up to date` 로그.
   - `package.json`에 `"bin": { "akg": "bin/akg.mjs" }` 추가.
3. **`docs/consuming.md`** (또는 README 섹션) — context.json 4줄 전환 가이드. §4 D1의 정확한 형태:

   ```jsonc
   // ~/.claude/context.json
   {
     "providers": {
       "db-schema": { "params": { "index": "~/.claude/akg/db-schema/index.json" } },
       "msg-format": { "params": { "index": "~/.claude/akg/msg-format/index.json" } }
     }
   }
   ```

   - sync 트리거 예시(수동/cron/SessionStart 훅 fire-and-forget, 5초 타임아웃).
4. **테스트 `test/mirror/sync.test.mjs`** (node:test, 의존성 0):
   - 서버는 Phase 1 `buildApp()`을 임시 store로 띄우고, 문서 몇 개 POST → `app.inject({method:'GET', url:'/api/bundle'})`로 실제 tar.gz Buffer를 얻어 `fetchImpl`을 그 응답으로 모킹(또는 실제 tar.gz를 만들어 주입).
   - **시나리오**:
     1. 첫 sync(로컬 rev 없음) → 미러에 `db-schema/index.json`·`db-schema/docs/<id>.md` 생성, index.json이 §5.1 계약(`[{keywords,path}]`, path=`docs/<id>.md`) 형식
     2. 동일 rev로 재sync → 304 → `changed:false`, 미러 파일 mtime 불변
     3. **서버 정지 모사**(fetchImpl이 throw) → syncMirror가 throw하지만 **기존 미러 파일 그대로**(fail-open 핵심 — 이 테스트가 §9.2 합격의 절반)
     4. 서버에 새 문서 추가 후 sync → 미러 index.json에 새 문서 반영
     5. zip-slip 방어(`../` 엔트리 든 악성 tar → 거부, 미러 밖 파일 안 생김)
     6. index+docs 자기완결성: index.json 위치 기준 `docs/<id>.md`가 실제로 존재

## 합격 기준 (§9.2 "소비 연결 A모드" 행 그대로)

- **서버 정지 상태에서 주입 정상(미러)**: sync 실패해도 기존 미러 온전 → keyword-docs가 계속 읽음 (테스트 3).
- **sync 후 새 문서가 다음 턴 주입**: sync가 미러 index.json을 갱신 → 다음 매칭에 포함 (테스트 4).
- 미러 index.json이 **프로바이더 계약(§5.1) 그대로** — claude-hooks를 import하지 않고(D1) 포맷·경로 해석을 자체 검증. **실제 CC 세션 주입은 자동 테스트 불가 → context.json 설정 후 수동 리허설로 확인**(리허설 서버 8791 활용, `docs/consuming.md`에 절차 명시).

## 규율

- **의존성 최소**: 새 npm 패키지 추가 금지(tar·git은 바이너리 spawn). node 내장(`node:child_process`, `node:fs`, 내장 `fetch`)만.
- 작업 후 `git -C ~/repo/claude-hooks diff --stat` 비어 있는지, `git -C ~/repo/agent-knowledge-governance status`에 범위 밖 변경 없는지 확인.
- prettier `--check .` 클린, `node --test` 전부 통과(기존 88 + 신규).
- **All-tools 서브에이전트를 쓴다면 실행 후 `git diff --stat`으로 무단 파일변경 확인**(과거 무단수정 실사례 있음).
- 리허설 서버(8791)는 이미 떠 있으니(내려가 있으면 위 배경의 명령으로 재기동) CLI를 그 서버에 실제로 물려 `bin/akg.mjs sync --server http://127.0.0.1:8791`가 실제 미러를 만드는지 한 번 돌려 확인.

## 참고 — Phase 0/1에서 이어지는 규율

- 렌더러/스키마/검증기는 Phase 0 산출물(`src/`) 재사용. sync는 그것들과 무관(순수 파일 전송·배치)하지만, 미러에 담기는 md는 서버가 이미 `render(json)`으로 찍어 커밋한 것이라 CLI가 다시 렌더할 필요 없음.
- git-guard/bash-guard/lint 훅 3종을 우회하지 말고 준수: `cd X && cmd` 대신 `git -C DIR`·서브셸, prettier 이슈는 Edit 또는 `npx prettier --write`로, master/main 직접 커밋 금지(feature 브랜치).
- 최초 main 부트스트랩은 이미 끝났으므로(리모트 존재), 이번엔 `feature/phase-2-cli-sync` push 후 일반적으로 `gh pr create --base main`.
