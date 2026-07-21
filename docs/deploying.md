# akg 서버 배포

로컬에서 `node server/main.mjs`로 띄우던 것을 실제 서버로 올릴 때의 절차와,
로컬에서는 드러나지 않는 제약들.

## 0. 이 서버가 전제하는 것

배포 방식을 정하기 전에 세 가지를 알고 있어야 합니다. 셋 다 설계상의 결정이고
(설계 문서 §D7, §11 S2·S9), 어기면 조용히 깨집니다.

**스토어 하나당 프로세스 하나.** 쓰기는 인프로세스 직렬 큐를 지나 git 커밋 한
번이 되고, 인증 실패 카운터도 프로세스 메모리에 있습니다. 같은 스토어에 두 번째
서버를 붙이면 커밋이 서로 끼어듭니다. 이제 락 파일(`<store>.lock`)이 이걸 막고
두 번째 프로세스는 기동을 거부하지만, **락은 한 호스트 안에서만 유효합니다** —
PID는 네임스페이스별이라 스토어 볼륨을 공유하는 두 컨테이너는 서로를 못 봅니다.
**수평 확장은 불가능합니다.** 부하가 문제가 되면 인스턴스를 늘리는 게 아니라
설계를 다시 봐야 합니다.

**`store/`는 서버만 씁니다.** 관리자가 수동으로 git을 건드리면 서버는 다음
기동에서 거부합니다(더티 트리 또는 `index.lock` 감지 → 기동 실패). 이건 안전장치이지
불편함이 아닙니다 — 백업 스크립트나 크론이 스토어에서 `git gc`를 돌리지 않도록
하세요.

**루프백 + 리버스 프록시.** `AKG_HOST` 기본값이 `127.0.0.1`이고, 그대로 두는 게
맞습니다. TLS·접근 제어·감사 로그는 앞단 프록시의 일입니다.

## 1. 요구사항

- Node.js ≥ 20 (`package.json` engines)
- `git` 바이너리 (스토어가 git 레포입니다)
- 전용 서비스 계정 하나. `AKG_HOME` 아래 전부와 `users.json`을 이 계정만
  읽을 수 있어야 합니다.

전역 git 설정(`~/.gitconfig`)은 필요 없습니다 — 서버가 스토어 레포에 커미터
identity를 직접 채웁니다.

## 2. 데이터 디렉터리와 첫 토큰

```sh
sudo -u akg mkdir -p /var/lib/akg
sudo -u akg chmod 700 /var/lib/akg
```

첫 approver 토큰은 서버가 아니라 **쉘에서** 발급합니다. 대시보드에 발급 버튼이
없는 건 의도적입니다 — 있다면 서버 프로세스가 자기 인증 저장소에 쓰기 권한을
갖게 되고, 권한 상승 버그 하나가 곧바로 approver 자가발급이 됩니다.

```sh
sudo -u akg AKG_USERS_PATH=/var/lib/akg/users.json \
  node /opt/akg/server/cli/akg-user.mjs add <이름> approver
```

출력된 토큰은 **다시 표시되지 않습니다**(해시만 저장). 90일 뒤 만료됩니다.

`users.json`은 git에 없는 **유일한 상태**이고 다른 사본이 없습니다. 권한은
0600이어야 하며, 아니면 서버가 기동을 거부합니다.

## 3. 서비스로 띄우기

```ini
# /etc/systemd/system/akg.service
[Unit]
Description=akg knowledge server
After=network.target

[Service]
User=akg
Group=akg
WorkingDirectory=/opt/akg
ExecStart=/usr/bin/node /opt/akg/server/main.mjs
Restart=on-failure
RestartSec=5

Environment=AKG_HOME=/var/lib/akg
Environment=AKG_HOST=127.0.0.1
Environment=AKG_PORT=8787
Environment=AKG_TRUST_PROXY=1

# store/와 users.json 외에는 쓸 일이 없습니다.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/akg

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure`와 락은 함께 동작합니다: 죽은 프로세스의 락은 stale로
판정되어 재기동이 자동으로 이어받습니다. 이전 프로세스가 아직 살아 있다면 새
프로세스는 기동을 거부하고 로그에 그 pid를 남깁니다.

락은 pid만 보지 않고 **부팅 ID와 프로세스 시작 시각**까지 기록·대조하므로,
전원 손실 후 남은 락이나 pid가 재사용된 경우도 stale로 정확히 판정됩니다. 다만
`/proc`을 못 읽는 환경에서는 pid 비교만 남으니, 원인이 분명하지 않은 기동 거부가
반복되면 메시지에 안내된 대로 락 파일을 직접 지우면 됩니다:

```sh
systemctl stop akg          # 정말 아무도 안 쓰는지 먼저 확인
rm /var/lib/akg/store.lock
```

기동 실패는 전부 종료코드 1 + 한 줄 메시지입니다(`journalctl -u akg`). 반쯤
동작하는 서버로 뜨는 경우는 없습니다.

## 4. 리버스 프록시

**`AKG_TRUST_PROXY`를 설정하지 않으면 인증 실패 레이트리밋이 오작동합니다.**
프록시 뒤에서는 모든 요청이 프록시 IP 하나로 보이므로, 리밋이 회사 전체를 한
클라이언트로 세고 **한 사람의 오타 20번이 전원을 5분간 차단**합니다.

- **`AKG_TRUST_PROXY=<홉 수>`** — 프록시 한 대 뒤라면 `1`. 거의 항상 이게
  정답입니다.
- `AKG_TRUST_PROXY=<ip|cidr>[,...]` — 프록시 주소를 명시. 홉 수를 세기 어려운
  구성(프록시가 여러 대, 경로에 따라 다름)에 쓰세요.
- 미설정(기본) — 헤더를 무시합니다. 프록시가 없을 때 올바른 값입니다.

**`AKG_TRUST_PROXY=true`는 쓰지 마세요.** 헤더 체인 전체를 믿는다는 뜻이고, 그
경우 `request.ip`는 체인의 **맨 왼쪽** 값이 됩니다. 그런데 위 nginx 설정의
`$proxy_add_x_forwarded_for`를 포함해 흔한 프록시 구성은 헤더를 **덮어쓰지 않고
덧붙입니다** — 즉 맨 왼쪽 값은 클라이언트가 보낸 그대로입니다. 결과:

- 매 요청마다 다른 값을 넣으면 레이트리밋을 **무제한 우회**하고,
- 남의 주소를 넣으면 그 사람을 **골라서 차단**시킬 수 있으며, 감사 로그에는
  피해자 IP의 실패로 남습니다.

루프백 바인딩은 이걸 막지 못합니다. 공격자도 다른 사람들과 똑같이 프록시를 통해
들어오고, 프록시는 클라이언트가 보낸 헤더를 지우지 않기 때문입니다.

프록시가 `X-Forwarded-For`를 `$remote_addr`로 **교체**하도록 설정했다면 홉 수 `1`은
여전히 맞고, `true`도 안전해집니다 — 하지만 굳이 그럴 이유가 없습니다.

익명 요청은 애초에 인증 시도가 아니므로 리밋을 아예 지나가지 않습니다. 누가
토큰을 몇 번 틀리든 열람 전용 대시보드는 계속 뜹니다.

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;

    # 요청 본문 상한은 서버가 512 KiB로 잡고 413에 이유를 담아 답합니다.
    # 프록시가 그보다 먼저 자르면 그 설명이 사라집니다.
    client_max_body_size 1m;

    # /api/bundle은 tar를 스트리밍합니다. 버퍼링을 끄지 않으면 코퍼스가
    # 커질수록 프록시가 전체를 메모리/디스크에 받아둔 뒤 넘기게 됩니다.
    proxy_buffering off;
    proxy_read_timeout 120s;
}
```

> 롤아웃 때 확인할 것: 실제 코퍼스 크기로 `akg sync`가 프록시를 통과하는지.
> 위 버퍼링/타임아웃 값은 현재 코퍼스(수 KB)로는 검증되지 않습니다 — 문제가
> 드러나는 건 문서가 수백 개로 늘어난 뒤입니다.

## 5. 익명 읽기를 켜 둘 것인가

기본값은 **켜짐**입니다. 토큰 없는 요청이 문서·인덱스·감사 로그·번들을 읽을 수
있고, 쓰기는 여전히 전부 401입니다. 대시보드가 로그인 화면 없이 바로 열리고
`akg sync`가 설정 없이 동작하는 게 이 덕분입니다.

로컬에서는 루프백 바인딩이 곧 접근 제어였습니다. **서버로 올라가면 그 방어선은
프록시로 옮겨갑니다.** 배포 전에 답해야 할 질문은 하나입니다:

> 이 프록시에 닿을 수 있는 사람 전부에게 도메인 지식(테이블 구조, 컬럼 의미)을
> 보여줘도 되는가?

- 프록시 앞에 SSO나 망 제한이 실제로 있다 → 기본값 유지
- 없다 → `AKG_ANON_READ=0`. 읽기에도 viewer 토큰이 필요해지고, 대시보드는
  로그인 화면부터 뜹니다

쓰기 쪽은 이 설정과 무관하게 항상 토큰이 필요합니다(S1).

## 6. 백업과 복원

두 가지를 따로 백업합니다.

**`store/`** — git 레포이므로 이력이 곧 감사 로그입니다. 서버를 멈춘 상태에서
디렉터리를 통째로 복사하거나, 원격을 붙여 push하세요. 서버가 도는 중에 스토어
안에서 git 명령을 돌리지 마세요(S9).

**`users.json`** — git에 없고 사본도 없습니다. 이걸 잃으면 **모든 토큰이
무효가 되고**, 쉘에서 첫 approver부터 다시 발급해야 합니다. 0600으로,
스토어와 같은 주기로 백업하세요.

복원:

```sh
sudo -u akg cp -a <backup>/store /var/lib/akg/store
sudo -u akg install -m 600 <backup>/users.json /var/lib/akg/users.json
```

`git clone`으로 복원해도 됩니다 — 서버가 기동 시 커미터 identity를 다시
채우므로 첫 쓰기가 실패하지 않습니다.

## 7. 운영

**토큰 발급·회수** (서버 재기동 불필요 — `users.json`을 매 요청 다시 읽습니다):

```sh
export AKG_USERS_PATH=/var/lib/akg/users.json
node server/cli/akg-user.mjs list
node server/cli/akg-user.mjs add <이름> <viewer|editor|approver|agent>
node server/cli/akg-user.mjs revoke <이름>
```

`users.json`을 읽을 수 없는 상태(예: 권한이 0644로 바뀜)에서는 이 CLI가
**중단합니다** — 그대로 진행하면 기존 사용자를 전부 덮어쓰기 때문입니다.
메시지가 복구 방법(`chmod 600`)을 알려줍니다.

**업그레이드**: 코드를 교체하고 `systemctl restart akg`. 스키마 마이그레이션은
없습니다(스토어는 JSON 파일 + git). 재기동 시 스토어가 더티하면 기동을
거부하므로, 실패하면 로그를 먼저 보세요.

**환경변수 전체**:

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `AKG_HOME` | `./.akg-data` | 데이터 루트 |
| `AKG_STORE_DIR` | `$AKG_HOME/store` | git 스토어 |
| `AKG_USERS_PATH` | `$AKG_HOME/users.json` | 인증 저장소 (0600) |
| `AKG_HOST` | `127.0.0.1` | 바인딩 주소 (S2) |
| `AKG_PORT` | `8787` | 바인딩 포트 |
| `AKG_TRUST_PROXY` | (미설정) | `X-Forwarded-For` 신뢰 범위 (§4) |
| `AKG_ANON_READ` | 켜짐 | `0`이면 읽기에도 토큰 필요 (§5) |

클라이언트(`bin/akg.mjs`) 쪽 변수는 `docs/consuming.md`를 보세요.

## 8. 배포 전 체크리스트

- [ ] `AKG_HOST`가 루프백이고, 앞단에 프록시가 있다
- [ ] `AKG_TRUST_PROXY`를 프록시 구성에 맞게 설정했다 (§4)
- [ ] 프록시가 인증·망 제한을 하거나, `AKG_ANON_READ=0`으로 정했다 (§5)
- [ ] `users.json`이 0600이고 백업 대상에 들어 있다
- [ ] `store/`가 백업 대상이고, 백업/크론이 그 안에서 git을 실행하지 않는다
- [ ] 서비스 계정이 `AKG_HOME` 밖에는 쓰기 권한이 없다
- [ ] 인스턴스는 하나다 (스토어 공유 다중화는 지원하지 않음, §0)
- [ ] 첫 approver 토큰을 쉘에서 발급했고 안전한 곳에 전달했다
- [ ] 실제 코퍼스 크기로 `akg sync`가 프록시를 통과하는 걸 확인했다 (§4)
