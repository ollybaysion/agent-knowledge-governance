# bench — 첫 접속 성능 측정

AKG 화면을 처음 열 때 걸리는 시간을 잰다. 도구는 둘이다.

- `bench/first-access.mjs`: headless Chrome 으로 화면 다섯 장면을 잰다.
- `bench/api.mjs`: Node 로 API 응답 시간과 바이트를 잰다.

두 도구는 Node 20 이상과 이 레포의 의존성만 쓴다. bash 와 `redis-cli` 는 필요 없다.
Windows · macOS · Linux 에서 같은 명령으로 돈다.

## 사내에서 재는 절차

준비: 이 레포를 받는다. 레포 폴더에서 `npm ci` 를 한 번 돌린다. PC 에 Chrome 이 있어야 한다.

1. Chrome 으로 FE 에 로그인한다.
2. 같은 Chrome 으로 사내 AKG 주소를 연다. 화면이 뜨는지 본다.
3. 개발자 도구를 연다(F12).
4. Application 탭 → Cookies → AKG 주소를 고른다.
5. `SESSION` 줄의 Value 를 복사한다.
6. 브라우저 측정을 돌린다.

   ```sh
   npm run bench:first-access -- --url http://<사내 AKG 주소> --cookie "SESSION=<복사한 값>" --label office
   ```

7. 느린 PC 흉내로 한 번 더 돌린다.

   ```sh
   npm run bench:first-access -- --url http://<사내 AKG 주소> --cookie "SESSION=<복사한 값>" --label office-slow --throttle slow
   ```

8. API 측정을 돌린다.

   ```sh
   npm run bench:api -- --url http://<사내 AKG 주소> --cookie "SESSION=<복사한 값>" --label office
   ```

9. `bench/out/` 의 결과 파일을 모은다.

결과 파일(`bench/out/`):

| 파일 | 내용 |
| --- | --- |
| `<label>.txt` | 콘솔 표 그대로. 장면 × 수치, 판마다 값과 중앙값 |
| `<label>.json` | 판마다 원값 전부. 장면마다 요청 목록(주소 · 상태 · 바이트)도 있다 |
| `<label>-<장면>.png` | 장면이 끝난 순간의 화면. 마지막 판의 것 |
| `<label>-api.txt` · `<label>-api.json` | API 측정 표와 원값 |

세션은 30 분 동안 쓰지 않으면 끝난다. `로그인 확인 실패: … 401` 이 나오면 1 단계부터 다시 한다.
Chrome 을 찾지 못하면 `--chrome "<chrome.exe 경로>"` 를 붙인다.

### 다른 옵션

`first-access.mjs`:

| 옵션 | 기본 | 뜻 |
| --- | --- | --- |
| `--runs N` | 3 | 판 수. 판마다 빈 프로필로 Chrome 을 새로 띄운다. 표에는 중앙값을 적는다 |
| `--throttle slow` | 없음 | CPU 4 배 느리게 · 왕복 150 ms · 다운 1.6 Mbps · 업 750 kbps |
| `--doc <type>/<id>` | 개요 표 첫 줄 | first-doc 장면에서 열 문서 |
| `--type <type>` | 개요 표 첫 줄의 타입 | docs-col2 장면의 타입 |
| `--chrome <경로>` | env `CHROME` → PATH 의 `google-chrome` · `chrome` · `chromium` → Windows 설치 폴더 → macOS 앱 | Chrome 실행 파일 |
| `--out <폴더>` | `bench/out` | 결과 폴더 |
| `--redis <url> --namespace <ns>` | `spring:session` | 쿠키 대신 Redis 에 세션을 직접 심는다. AKG 와 같은 Redis 에 닿는 PC 에서 쓴다. 끝나면 지운다 |
| `--port N` | 0 | Chrome 원격 디버깅 포트. 0 이면 Chrome 이 빈 포트를 고른다 |

`api.mjs`: `--token <에이전트 Bearer>` 를 쿠키 대신 쓸 수 있다. `--type` 은 본문 · 문서 GET 을 잴 타입이다(기본 `/api/docs` 첫 문서의 타입).
`--n` 은 N+1 길에서 차례로 GET 할 문서 수다(기본 300).

## 장면과 수치

장면 다섯을 한 프로필에서 차례로 잰다. ms 는 모두 페이지의 `performance.now()` 값이다.

| 장면 | 하는 일 |
| --- | --- |
| overview-cold | 빈 프로필로 `#/overview` 를 연다 |
| overview-settle | overview-cold 의 화면이 조용해질 때까지 기다린다. 그다음 타입 칩을 누른다 |
| overview-warm | 새로고침한다. 캐시가 찬 상태다 |
| first-doc | 개요 표 첫 줄을 눌러 문서 화면을 연다 |
| docs-col2 | `#/docs/<type>` 를 새로 연다 |

| 수치 | 뜻 |
| --- | --- |
| 첫 그림 ms | 내비게이션 시작부터 개요 표 줄(또는 2열 줄)이 처음 그려진 프레임까지 |
| 줄 찾음 ms | 그 줄이 DOM 에 처음 보인 프레임. 첫 그림은 그다음 프레임이다 |
| 조용해짐 ms | 첫 그림 뒤 긴 작업(50 ms 넘는 작업)이 1 초 동안 없을 때, 그 조용함이 시작된 시각. 10 초 안에 조용해지지 않으면 `-` |
| 긴 작업 수 · 합 · 가장 긴 | 내비게이션 시작부터 조용해짐까지 긴 작업의 수 · 길이 합 · 가장 긴 것. 이 동안 화면은 클릭에 답하지 않는다 |
| 클릭 반영 ms | 두 번째 타입 칩(전체 다음)을 누른 순간부터 그 결과가 화면에 나온 프레임까지(`requestAnimationFrame` 두 번째 콜백) |
| 클릭 처리 ms | 그중 칩의 클릭 처리기가 돈 시간 |
| 칩 뒤 줄 | 칩을 누른 뒤 개요 표의 줄 수 |
| 첫 문서 ms | 개요 표 줄을 누른 순간부터 문서 본문(`.doc-body` 의 첫 요소)이 그려진 프레임까지 |
| mermaid 틀 load ms · 첫 그림 ms | 문서에 mermaid 그림이 있을 때만. 클릭부터 mermaid iframe 의 `load` 까지, 첫 그림이 나올 때까지 |
| 2열 줄 | 문서 탭 2열의 줄 수 |
| DOM 노드 | 장면이 끝난 순간의 요소 수 |
| 요청 · 304 · 받은 바이트 | 그 장면 동안 브라우저가 보낸 요청, 그중 304 로 답한 것, 망으로 받은 바이트(압축된 크기) |
| /api/docs 응답 | 목록 요청마다 상태와 받은 바이트 |

## 로컬 비교: PR #107 전 · 후

이 도구로 PR #107 전과 후를 잰 값이다.

- 전: `dcb3e7e`(PR #107 머지 전). 후: `51695aa`(PR #107 머지).
- 데이터: store-big. 문서 9,730 개, 그중 보관 제외 9,610 개. db-schema 5,880 개.
- 서버와 headless Chrome 156 이 같은 PC 에 있다(loopback). 창 1440×900. 판 3 의 중앙값.
- 기본 열 둘은 throttle 없음. slow 열 둘은 `--throttle slow`(CPU 4 배 느리게 · 왕복 150 ms · 다운 1.6 Mbps · 업 750 kbps).
- first-doc 은 개요 표 첫 줄 `db-schema/perf_tbl_0001` 을 연다. docs-col2 는 `#/docs/db-schema` 다.

| 장면 | 수치 | 전 | 후 | 전 slow | 후 slow |
| --- | --- | ---: | ---: | ---: | ---: |
| overview-cold | 첫 그림 ms | 1,376 | 330 | 63,007 | 6,347 |
| overview-cold | 개요 줄 | 9,610 | 200 | 9,610 | 200 |
| overview-cold | DOM 노드 | 150,238 | 3,539 | 150,238 | 3,539 |
| overview-cold | 받은 바이트 | 11,358,575 | 894,455 | 11,358,576 | 894,456 |
| overview-settle | 조용해짐 ms | 1,376 | 330 | 63,007 | 6,347 |
| overview-settle | 긴 작업 수 | 2 | 0 | 4 | 4 |
| overview-settle | 긴 작업 합 ms | 1,102 | 0 | 4,982 | 391 |
| overview-settle | 가장 긴 작업 ms | 968 | 0 | 4,308 | 140 |
| overview-settle | 클릭 반영 ms | 708 | 23 | 2,159 | 86 |
| overview-settle | 칩 뒤 줄 | 5,880 | 200 | 5,880 | 200 |
| overview-warm | 첫 그림 ms | 1,252 | 167 | 62,882 | 2,602 |
| overview-warm | 304 | 0 | 39 | 0 | 39 |
| overview-warm | 받은 바이트 | 11,358,189 | 14,473 | 11,358,190 | 14,474 |
| first-doc | 첫 문서 ms | 537 | 534 | 4,019 | 3,124 |
| first-doc | DOM 노드 | 76,984 | 76,984 | 76,984 | 76,984 |
| docs-col2 | 첫 그림 ms | 760 | 650 | 60,675 | 5,086 |
| docs-col2 | 2열 줄 | 5,880 | 5,880 | 5,880 | 5,880 |
| docs-col2 | 받은 바이트 | 11,470,475 | 19,386 | 11,470,476 | 19,387 |

두 판 모두 조용해짐이 첫 그림과 같다. 긴 작업이 모두 첫 그림 앞에서 끝난다는 뜻이다.
전의 "그린 뒤 멈춤"은 클릭 반영 708 ms(slow 2,159 ms)로 나타난다. 칩 하나가 5,880 줄을 한 번에 다시 그린다.

API(`api.mjs`, `--token`, 같은 조건):

| 측정 | 전 | 후 |
| --- | --- | --- |
| `/api/docs` 평문 | 200 · 61 ms · 5,913,669 B | 200 · 68 ms · 5,913,669 B |
| `/api/docs` gzip | 200 · 57 ms · 5,913,669 B | 200 · 88 ms · 426,842 B |
| `/api/docs` if-none-match | etag 없음 | 304 · 0.6 ms · 0 B |
| `?type=db-schema&fields=body` ×3 | 200 · 35~41 ms · 4,661,119 B | 200 · 483~512 ms · 32,726,761 B |
| `?type=db-schema&fields=body` gzip | 200 · 37 ms · 4,661,119 B | 200 · 581 ms · 1,212,331 B |
| 문서 GET ×30 중앙값 · 최대 | 1.6 · 2.5 ms | 1.2 · 2.7 ms |
| N+1 300 건 차례로 총 · 건당 | 522 ms · 1.7 ms | 370 ms · 1.2 ms |
| `/js/main.mjs` if-none-match | etag 없음 | 304 · 0.3 ms |
| `mermaid.min.js` gzip | 200 · 14 ms · 3,572,661 B | 200 · 70 ms · 987,234 B |

전 서버는 `fields=body` 를 모른다. 그래서 전의 `fields=body` 줄은 본문 없는 목록 크기다.

## 사내 수치가 다른 이유

위 표는 서버와 브라우저가 한 PC 에 있는 loopback 수치다. 사내 수치는 아래 다섯 때문에 달라진다.

- 망 왕복: 사내에서는 요청마다 망을 한 번 오간다. 첫 화면은 요청 43 개를 보낸다. 왕복이 길면 그만큼 늦다.
  `--throttle slow` 의 왕복 150 ms 가 이 몫을 흉내 낸다.
- 망 대역폭: overview-cold 는 약 0.9 MB 를 받는다. 대역폭이 좁으면 받는 시간이 첫 그림을 정한다.
- PC 속도: 긴 작업 · 클릭 반영 · 2열 그림은 브라우저의 CPU 일이다. 느린 PC 에서는 이 수치가 커진다.
  `--throttle slow` 는 CPU 를 4 배 느리게 한다.
- 문서 수: 목록 응답 크기 · 2열 줄 수 · 문서 화면의 왼쪽 패널 줄 수가 문서 수에 비례한다.
  `api.mjs` 표 머리의 `문서 N` 으로 사내 문서 수를 본다.
- 캐시 상태: overview-cold 는 빈 프로필이다. 사람이 매일 쓰는 브라우저는 overview-warm 에 가깝다.
  서버 쪽 캐시는 서버를 띄운 뒤 첫 요청에서 찬다. 서버를 막 띄웠다면 한 번 돌리고 버린 뒤 다시 잰다.
