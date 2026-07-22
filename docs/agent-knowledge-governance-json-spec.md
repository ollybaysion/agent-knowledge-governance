# agent-knowledge-governance — 문서 JSON 스펙 (v0.6.0)

> 허브 문서의 **JSON 포맷 정의서**. 모체 설계도
> [`agent-knowledge-governance-design.md`](agent-knowledge-governance-design.md) §5(데이터 모델)를 구현
> 가능한 수준으로 확장한 것으로, 새 레포의 `schemas/*.schema.json`은 이 문서를
> 기준으로 작성한다. 충돌 시 이 문서가 우선(설계도 §5는 요약으로 유지).
>
> 작성: 2026-07-17. 설계도 v0.3 시점 기준.
> v0.1.1 개정(2026-07-18): §1을 "계층 축 3개 구분 → 축별 내부 계층" 순서로
> 재구성(포맷 내용 무변경).
> v0.1.2 개정(같은 날): unclassified 예외 설명을 §1.4로 분리(포맷 내용 무변경).
> v0.2 개정(2026-07-18): ① 용어 개명 — 티어 셀 → **티어드 값(tiered-value)**,
> 스키마 파일 common/tiered-value.v1, 감지 원리($ref 단일 규칙) 명문화(§3).
> ② 인라인 티어 필드 폐지 — queries/rejects/invariants를 중첩 티어드 값으로
> 통일 + 행 수정 시 강등 규칙(§3.1). 구조 변경이라 마이너 상승.
> v0.2.1 개정(같은 날): 슬롯 정의(사람 지식의 자리, 설계 개념)와 슬롯 주소
> (FQN형 경로, 배열 인덱스 주소는 rev 한정 유효) 명문화(§3).
> v0.2.2 개정(같은 날): 지식의 두 반구 재정의(§1.2) — 팩트(기계 지식, 대조
> 검증) vs 슬롯(사람 지식, 검토 검증), 상위 단위 = 문서(SSoT 단위).
> v0.2.3 개정(같은 날): 시스템명 확정 반영 — agent-doc-hub →
> agent-knowledge-governance(akg), dochub CLI → akg. 파일명도 동일 개칭.
> v0.2.4 개정(같은 날): §7 예시에 행 속 중첩 대표 쿼리 1건 추가(슬롯 세 패턴
> 전부 시연) + 슬롯 5개 목록 명기.
> v0.3 개정(같은 날): msg-format v1 범위 축소 — `response`·`rejects` 제외
> (사용자 결정, 재도입 = 동일 버전 선택 필드 추가 규칙 §6). 행 규칙 나열 갱신.
> v0.4 개정(같은 날): 티어 4번째 상태 **deprecated** 추가(사용자 결정) — 신뢰
> 철회·폐기 대기. 고아 슬롯 = 원천 소멸 시 자동 deprecate로 형식화, 수동 폐기
> 액션 신설. 복원 = 편집·재채택(→ inferred), 제거 확정 = approver. 렌더·주입
> 제외(§5.2). 별도 필드 대신 tier enum 확장 — tier는 "얼마나 신뢰할 것인가"의
> 축이고 deprecated는 그 끝점(신뢰 철회); 별도 필드면 무의미 조합 금지 규칙이
> 추가로 필요해 기각. msg-format `errorCodes`도 추가 제외(v0.3 축소의 연장).
> v0.4.1 개정(2026-07-19): §4.4 예시 정정 — `notes`는 배열이 아니라 **단일
> raw md 문자열**(foundry validateSpec 실행 대조에서 탈락 발견; "무변형 수용"
> 계약상 akg 쪽이 foundry에 맞춘다). 스키마 사영 필수 세부(minItems·공백
> 거부·dependentRequired·name 패턴) 명기.
> v0.4.2 개정(같은 날, 사용자 결정): **spec.json 포맷 진실원의 akg 이관
> 확정**(§4.4) — 발효 시점: foundry 세션 검증 완료분의 akg 스키마 반영부터.
> 이후 foundry validateSpec·renderSkill은 akg 스키마의 추종자(방향 역전 —
> v0.4.1의 "akg가 foundry에 맞춘다"는 발효 전 규칙으로 남는다).
> v0.4.3 개정(같은 날): §4.4 예시에서 `h1Title` 제거 — foundry 이슈 #10 →
> PR #11(사용자 결정)로 spec에서 필드가 빠지고 H1은 `# {name}` 렌더.
> "무변형 수용" 계약 추종(발효 전 규칙 v0.4.1과 동일 방향).
> v0.4.4 개정(같은 날): §4.4 동기 2건 — foundry PR #11 확장분.
> ① `intro` 필수 → **선택**(실행 도입부는 renderSkill 고정 문장, intro는
> 도메인 주의사항만). ② `description` 첫 줄 = 마침표로 끝나는 완결
> 문장(validateSpec 기계 강제 — be 소비자 firstLine 계약). 스키마 사영
> 세부에 반영.
> **v0.5.0 개정(2026-07-21): §4.4 = foundry spec v2 반영 — 포맷 진실원 이관
> 발효.** v0.4.2가 건 조건("foundry 검증분의 akg 스키마 반영")이 충족돼 이제
> akg가 포맷 소유자다. 변경: `description`·`valueRules`·`h1Title` 제거(description
> 은 scope+focus+inputs 에서 렌더러가 합성), `scope`(닫힌 enum 3축)·`focus`·
> `anchorTable`·`inputs`·`dependencies`·`steps[].produces`·`steps[].branches` 신설,
> `output` = `avoid`(3+, 형태 계약)+`examples`(2+). §1.2의 티어 예외는 소멸.
> 마이너가 아니라 마이너-마이너로 올린 것은 body 형태가 비호환으로 바뀌었기
> 때문 — 봉투 타입 버전(`domain-skill/v1`)은 유지했다(저장된 문서가 예시뿐인
> 도입 직후라 병존 비용이 이득을 넘는다).
> **v0.6.0 개정(2026-07-22): §4.4 `steps[].binds` 신설(이슈 #32)** — 결정론
> 실행기(fdc-agent-be-spring)가 스킬마다 손으로 만들던 wiring.json 사이드카를
> spec으로 흡수(사용자 결정: wiring 소멸, spec 단일 진실원). 스텝 SQL의 각
> `:bind`가 어디서 오는지 선언 — `{from:"arg",arg}`(툴 인자) |
> `{from:"step",step,column}`(앞 스텝 결과 컬럼). **선택 필드 추가라 §6
> 규칙대로 `domain-skill/v1` 유지.** 정합은 시맨틱 체크가 본다(아래 §4.4).
> 렌더는 무변경 — binds는 실행기용이고 산문 소비자(CC)는 `lead`로 배선을
> 이미 받는다.

---

## 1. 계층 구조 — 세 개의 축

이 스펙에는 서로 다른 계층 축 **세 개**가 겹쳐 있다. 하나의 계층 구조가 아니라,
"어디에 사는가"(저장소) · "한 건 안이 어떻게 중첩되는가"(문서 내부) ·
"그 구조를 무엇이 정의하는가"(스키마)라는 서로 다른 질문에 각각 계층이 있다.
먼저 축을 구분하고, 각 축의 내부 계층을 §1.1~§1.3에서 설명한다. 세 축 어디에도
온전히 얹히지 않는 예외 타입 unclassified는 §1.4에서 따로 다룬다.

| 축 | 무엇의 계층인가 | 내부 계층 (상 → 하) |
| --- | --- | --- |
| ① 저장소 (§1.1) | 파일이 사는 위치 — 편집 대상과 계산 결과의 구분 | `store/`(진실원) → `rendered/`(파생물) |
| ② 문서 내부 (§1.2) | JSON 문서 한 건 안의 중첩 | 공통 봉투 → 타입별 body → 티어드 값 |
| ③ 스키마 (§1.3) | 구조 정의 파일들의 참조 관계 | 타입 스키마 → `$ref` → 공통 티어드 값 스키마 |

세 축은 독립이 아니라 직교한다: ①의 진실원 파일 하나가 ②의 중첩 구조를 가지며,
그 구조의 정의가 ③의 스키마 파일이다.

### 1.1 축 ① 저장소 — 진실원과 파생물

```text
[진실원 — 편집 대상은 이것뿐]
store/<type>/<id>.json               공통 봉투 + 타입별 body      (§2~§4)
store/unclassified/<id>.md           unclassified만 md가 진실원   (§4.5)
store/unclassified/<id>.meta.json    unclassified 사이드카 메타

[파생물 — 서버가 쓰기 커밋마다 자동 재생성, 손대지 않는다]
rendered/<type>/index.json        프로바이더 계약 인덱스        (§5.1)
rendered/<type>/docs/<id>.md      주입용 md                    (§5.2)
rendered/domain-skill/<name>/SKILL.md   설치형 스킬            (§4.4)
```

원칙: **진실원과 파생물은 항상 같은 git 커밋 안에서 갱신**된다(어긋난 상태가
존재할 수 없음). CI가 전 문서에 대해 `render(json) === rendered/` 바이트 동일을
검사한다.

### 1.2 축 ② 문서 내부 — 봉투 → body → 티어드 값

진실원 JSON 한 건의 안쪽은 3겹 중첩이다:

```text
공통 봉투 (5키 고정: schema · id · keywords · status · body)   ← 타입 무관 (§2)
  └─ body                                                     ← 타입별 (§4)
       └─ 티어드 값 { text, tier, evidence, by, at }             ← 지식의 최소 단위 (§3)
```

- **봉투**: 라우팅·주입 메타 전부(무슨 문서인가, 언제 주입되나, 살아있나).
  인덱스 컴파일과 키워드 충돌 검증은 body를 열지 않고 봉투만으로 동작한다.
- **body**: 타입별 알맹이. db-schema는 내부에 소유권 구분이 하나 더 있다 —
  `catalog`는 기계 소유(catalog-push API만 갱신), 나머지 슬롯은 사람 소유.
- **티어드 값**: 사람 지식이 담기는 최소 단위(purpose 하나, 컬럼 설명 하나가 각각
  독립된 티어드 값). 승격·강등·근거 강제가 전부 이 단위에 걸리므로, 슬롯 단위 승격과
  슬롯 단위 충돌 판정(설계도 §11 S6)이 성립하는 근거 계층이다.

**지식의 두 반구(용어 재정의, 2026-07-18 확정)**: body 안의 내용물은 원천과
검증 방법이 다른 두 종류로 나뉜다.

| 구분 | 담는 것 | 검증 방법 | 신뢰 관리 | 갱신 경로 |
| --- | --- | --- | --- | --- |
| **팩트(기계 지식)** | 원천과 대조 가능한 사실 — catalog, 행의 기계 필드(sql·code·seq·name·type) | 원천(DB·코드·실행)과 **대조** — 참/거짓이 결정됨 | 티어 없음. 신선도(fetchedAt)·출처만 | catalog-push(자동 수집) 또는 행 편집(사실 전사) |
| **슬롯(사람 지식)** | 사람의 해석 — 티어드 값 | 사람의 **검토** — 참/거짓이 아니라 신뢰 수준의 문제 | 티어(scaffold→inferred→confirmed, 신뢰 철회 = deprecated) | 편집·채택·승격·폐기 |

두 반구를 포괄하는 상위 단위는 **문서**다 — 문서 = 대상 하나(테이블·커맨드·
용어·절차)에 대한 팩트+해석의 SSoT 단위. 티어가 슬롯에만 있는 이유가 이
구분에서 나온다: 팩트는 틀리면 대조해서 고치면 끝이라 "얼마나 믿나"가 성립하지
않고, 해석만이 신뢰 등급을 가진다. 이 구분은 md 시절 dbdoc auto/manual 마커
분리의 승계·형식화다(설계도 §2.2).

(v0.5.0 이전 이 자리에 있던 예외 — domain-skill 의 `basis` 인라인 `추정)` —
는 spec v2 의 `valueRules` 제거와 함께 **사라졌다**. 값 의미의 티어드 값은
db-schema 타입이 온전히 소유한다, §4.4.) unclassified는 §1.4.

### 1.3 축 ③ 스키마 — 정의 파일의 참조 계층

```text
schemas/<type>/v1.schema.json                        타입별 정의 (§6)
  └─ $ref → schemas/common/tiered-value.v1.schema.json  공통 리프 — 한 파일에서만 정의
```

티어드 값 규칙은 common 한 파일에서만 정의되고 각 타입 스키마가 `$ref`로
참조한다. 문서 봉투의 `schema` 필드가 자기 타입 스키마 파일을 가리키는
포인터이며, 전 층위 `additionalProperties: false`라 어느 계층에서든 모르는
키는 거부된다.

### 1.4 예외 타입 unclassified — 세 축 어디에도 온전히 얹히지 않는다

unclassified(§4.5)는 "정형 타입 어디에도 분류되지 않는 md"라는 정체성 때문에
축마다 다르게 비켜난다. 축별로 보면:

- **축 ① 저장소**: 유일하게 **진실원이 JSON이 아니라 md**다
  (`store/unclassified/<id>.md`). JSON은 keywords·status만 담는 사이드카 메타
  (`<id>.meta.json`) — 봉투에서 body가 빠진 형태. 렌더도 없다 — md 원본이
  그대로 `rendered/unclassified/docs/`로 복사된다(진실원=파생물 내용 동일,
  같은 커밋 원칙만 공유).
- **축 ② 문서 내부**: body·티어드 값 층이 **없다**. 따라서 티어·승격·근거 강제·
  슬롯 단위 충돌 판정이 전부 비적용 — 편집은 textarea 통짜, 충돌은 파일 단위.
- **축 ③ 스키마**: `unclassified/v1.schema.json`은 **사이드카 메타만** 검증한다.
  본문 md는 스키마 검증 대상이 아니다(모르는 키 거부의 보호가 본문에는 없음).

도입 여부 자체가 열린 질문(설계도 §12-4, 초안은 미도입 — 스키마만 예약)인
이유가 이 표에서 드러난다: 허브의 보호 장치 대부분(티어·슬롯 승격·구조 검증)이
이 타입에는 작동하지 않는다.

---

## 2. 공통 봉투 (모든 타입)

파일 경로 = `store/<type>/<id>.json`. 최상위 키는 아래 5개가 전부이며,
그 외 키는 검증기가 거부한다.

```jsonc
{
  "schema": "db-schema/v1",
  "id": "fdc_sensor",
  "keywords": [
    { "kw": "fdc_sensor",          "inject": "full" },
    { "kw": "sensor",              "inject": "pointer" }
  ],
  "status": "active",
  "body": { }
}
```

| 필드 | 타입 | 규칙 |
| --- | --- | --- |
| `schema` | string | `<type>/v<N>`. `schemas/<type>/v<N>.schema.json`을 가리킴. 서버는 모르는 버전의 쓰기를 거부 |
| `id` | string | 타입 내 유일, 파일명과 일치. 소문자·숫자·`._-`만 |
| `keywords` | array | 주입 트리거. 아래 키워드 객체의 배열, 최소 1개 |
| `status` | enum | `active` \| `archived`. archived는 index.json에서 제외(주입 중단), 파일·이력은 보존 |
| `body` | object | 타입별 스키마(§4) |

### 2.1 키워드 객체

```jsonc
{ "kw": "fdc_sensor", "inject": "full" }
```

| 필드 | 규칙 |
| --- | --- |
| `kw` | ASCII 소문자·숫자·`_`·`.`·`-`·공백 (`^[a-z0-9_. -]+$`, 스키마 강제) — 순한글은 스키마가 거부. 매칭은 기본 `word` 모드: 단일 토큰은 단어경계(`\b…\b`) 매치이고 `.`·`-`은 리터럴로 이스케이프되므로 `testuser.fdc_sensor`·`fdc-explain-sensor`처럼 프롬프트에 그대로 나오면 매치된다. 공백 포함 kw는 phrase(부분 문자열) 매치. ⚠ `exact` 모드에선 토크나이저 `/[a-z0-9_]+/`가 `.`·`-`·공백을 경계로 분해해 그 통짜 토큰이 생기지 않으므로 이 문자가 든 kw는 매치 불가 — 식별자형 kw는 `word`(기본)를 쓸 것 |
| `inject` | `full`(문서 본문 주입) \| `pointer`(한 줄 포인터만). 기준: 식별자형=full, 일반어=pointer. 서버가 광범위 키워드에 full 지정 시 경고 |

키워드 충돌 검증(쓰기 시점): 같은 타입 안에서 `kw` 중복 등록 거부, 타 타입과
겹치면 섀도잉 경고. `precision` 필드는 **폐지됨** — 파생 index.json에서만
컴파일 결과로 나타난다(§5.1).

---

## 3. 티어드 값(tiered-value) — 슬롯에 오는 값의 공통 구조

`schemas/common/tiered-value.v1.schema.json`. 사람의 지식이 담기는 모든 슬롯
(purpose, 컬럼 설명 하나하나, 필드 desc 하나하나, …)의 값은 이 구조를 쓴다.

감지 원리: 어떤 value가 티어드 값인지는 문서를 보고 추측하지 않는다 — **타입
스키마에서 `$ref: common/tiered-value.v1`이 걸린 자리가 전부**다(§1.3). 그
자리는 객체 키(purpose), 맵 값(columnDescs.*), 배열 항목(invariants[]), 행 속
키(fields[].desc, queries[].note) 어디든 올 수 있다.

**슬롯의 정의(용어 확정)**: 슬롯 = **사람의 지식이 위치하는 자리**를 가리키는
설계 개념(JSON 표준 용어 아님 — md 시절 템플릿의 "채울 자리"에서 승계). 판별
기준은 위 감지 원리와 일치하도록 구성한다 — 티어드 값 `$ref`가 걸린 경로 목록이
곧 그 타입의 슬롯 전체다.

**슬롯 주소**: body 루트 기준 경로를 FQN처럼 표기한다 — `purpose`,
`columnDescs.USE_YN`, `queries[0].note`. promote의 `{slots: [...]}`, 충돌
판정(설계도 §11 S6)의 슬롯 교집합, 검토 대기열·고아 슬롯 보고가 전부 이 주소를
소비한다. 주의: 배열 인덱스 주소(`queries[0].note`)는 행 삽입·삭제로 시프트되므로
**특정 rev 안에서만 유효** — 이름 키 주소는 rev 무관 안정. promote가
`If-Match: rev` 필수(S4)인 것이 인덱스 주소의 안전 조건이기도 하다.

```jsonc
{
  "text": "센서 사용 여부('Y'=활성,'N'=비활성 — 조회 제외)",
  "tier": "inferred",
  "evidence": ["fdc-app/src/schema-map.ts:74"],
  "by": "adopt:renoir",
  "at": "2026-07-17T05:20:00Z"
}
```

| 필드 | 타입 | 규칙 |
| --- | --- | --- |
| `text` | string \| null | 내용. `tier: scaffold`면 null 강제 |
| `tier` | enum | `scaffold` \| `inferred` \| `confirmed` \| `deprecated`(신뢰 철회 — §3.1) |
| `evidence` | string[] | `파일:라인` 형식. **inferred 이상은 최소 1개 강제**(서버 400). scaffold는 빈 배열 또는 생략 |
| `by` | string | 마지막 변경 주체: `agent:<이름>` \| `edit:<user>` \| `adopt:<user>` \| `promote:<user>` \| `deprecate:<user>` \| `deprecate:catalog-push`(자동). scaffold는 생략 가능 |
| `at` | string | ISO 8601. 마지막 변경 시각. 전체 이력은 git이 진실원 — 이 두 필드는 조회 편의용 요약 |

### 3.1 상태 전이 (요약)

전이 규칙의 정본은 설계도 D4의 상태 다이어그램이다. 스키마 관점 요약:

- confirmed를 **생성**할 수 있는 쓰기 경로는 없다 — promote API만 `inferred →
  confirmed` 전이를 수행하며 `text`/`evidence`는 불변.
- 편집(`PUT`)·제안 채택은 결과 tier가 항상 `inferred`(confirmed 슬롯을 고치면
  자동 강등).
- agent 토큰은 티어드 값을 직접 쓸 수 없다(proposal 제출만).
- 행 안에 중첩된 티어드 값(fields[].desc, queries[].note)은
  **행 전체가 검토 단위** — 행의 기계 필드(sql, name 등)를 고쳐도 그 행의
  티어드 값은 inferred로 강등된다("수정된 confirmed 불가" 규칙의 행 버전).
- **deprecated(신뢰 철회, v0.4)**: 진입은 ① 원천 소멸 시 서버 자동 전이(내용
  있는 inferred/confirmed 슬롯 — 기존 "고아 슬롯"의 형식화, by =
  `deprecate:catalog-push`) ② editor의 deprecate 액션(원천이 있어도 낡은 지식
  표시). scaffold는 대상 아님 — 빈칸은 기존대로 보고 후 제거.
  text·evidence는 **보존**되고(보존이 목적), 렌더·주입에서 **제외**된다(§5.2).
  **복원 = 편집·재채택 → 항상 inferred**(재검토 강제, confirmed 직행 불가 —
  promote 규칙 유지). **제거 확정 = approver 전용**(D6 삭제 권한과 대칭).

---

## 4. 타입별 body 스키마

### 4.1 `db-schema/v1` — 테이블 문서

```jsonc
"body": {
  "owner": "TESTUSER",                      // 선택, 대문자 — 순수 속성. id·파일명에 관여하지 않는다
  "table": "FDC_SENSOR",                    // 필수, 대문자. id = lower(table)
  "catalog": {                              // 필수. [기계 소유] catalog-push API만 갱신
    "columns": [                            // describe_table 응답 사본 (agent-db-plugin 계약)
      { "name": "SNSR_ID", "type": "VARCHAR2(30)", "nullable": false,
        "default": null, "comment": "센서 ID" }
    ],
    "primaryKey": ["SNSR_ID"],
    "foreignKeys": [ { "column": "EQP_ID", "refTable": "FDC_EQUIPMENT",
                       "refColumn": "EQP_ID" } ],
    "indexes": [ { "name": "IX_SENSOR_EQP", "unique": false, "columns": ["EQP_ID"] } ],
    "numRows": 120,                         // 선택
    "lastAnalyzed": "2026-07-01",           // 선택
    "tableComment": null,                   // 선택 (list_tables에서 시드)
    "fetchedAt": "2026-07-17T05:10:00Z"     // 필수 — 카탈로그 신선도 표시
  },
  "purpose":     { /* 티어드 값 */ },          // 필수(scaffold 허용)
  "columnDescs": {                          // 필수. key = catalog.columns[].name
    "SNSR_ID": { /* 티어드 값 */ },
    "USE_YN":  { /* 티어드 값 */ }
  },
  "queries": [                              // 선택 — 행 속 티어드 값(§3.1 행 규칙)
    { "sql": "SELECT ...",
      "note": { "text": "활성 센서 조회", "tier": "inferred",
                "evidence": ["fdc-app/src/sensor-repo.ts:44"],
                "by": "adopt:renoir", "at": "..." } }
  ]
}
```

교차 검증(스키마 밖, 서버 코드): `columnDescs`의 키는 `catalog.columns`에
존재해야 한다. catalog 갱신으로 컬럼이 사라지면 — scaffold 슬롯은 보고 후 제거,
inferred/confirmed 슬롯은 서버가 **deprecated로 자동 전이**(= 고아 슬롯, §3.1)
— 검토 대기열에서 사람이 제거 확정(approver)하거나 복원(편집 → inferred)한다
(자동 삭제 금지). 새 컬럼은 scaffold 슬롯 자동 생성.

### 4.2 `msg-format/v1` — 설비 커맨드 메시지 문서

```jsonc
"body": {
  "command": "CMD_START_LOT",               // 필수, 대문자. id = kebab(command)
  "direction": "host->equipment",           // 필수: host->equipment | equipment->host
  "purpose": { /* 티어드 값 */ },              // 필수(scaffold 허용)
  "fields": [                               // 필수, 코드의 메시지 정의 순서
    { "seq": 1, "name": "LOT_ID", "type": "string", "required": true,
      "desc": { /* 티어드 값 */ } }
  ],
  "examples": [                             // 선택
    { "label": "정상", "payload": "{\"LOT_ID\":\"L2401\"}" }
  ]
}
```

**v1 범위 축소(사용자 결정 2026-07-18)**: 초안의 `response`(ack·timeoutMs)·
`rejects`(NAK/거부 조건)·`errorCodes`(에러 코드표)는 당장 불필요해 v1에서 제외.
재도입은 "선택 필드 추가 = 동일 버전 허용" 규칙(§6)으로 스키마 버전 상승 없이
가능하다. v1의 msg-format body = command·direction·purpose·fields·examples.

### 4.3 `domain-doc/v1` — 도메인 용어 문서

```jsonc
"body": {
  "term": "TSUM",                           // 필수. id = lower(term)
  "definition": { /* 티어드 값 */ },           // 필수(scaffold 허용) — 한 줄 정의
  "behavior":   { /* 티어드 값 */ },           // 선택 — 동작/계산식
  "codeRefs":   ["src/calc/tsum.ts:40"],    // 선택 — 관련 코드 위치
  "invariants": [                           // 선택 — 항목 자체가 티어드 값 배열
    { /* 티어드 값 */ }
  ],
  "edgeCases":  { /* 티어드 값 */ },           // 선택
  "background": { /* 티어드 값 */ }            // 선택
}
```

### 4.4 `domain-skill/v1` — 실행형 조회 절차 스킬

body = **agent-skill-foundry spec.json(v2) 무변형 수용**. 렌더 산출물은 md 문서가
아니라 `rendered/domain-skill/<name>/SKILL.md`이고, foundry `renderSkill()`과
**바이트 동일**이 계약이다(frontmatter `disable-model-invocation: true`).

**포맷 진실원 = akg (발효 2026-07-21)**. foundry spec v2 검증분이
`schemas/domain-skill/v1.schema.json`에 반영되면서 이관 조건(v0.4.2)이 충족됐다.
이제 foundry `validateSpec`·`renderSkill`이 akg 스키마를 **추종**하고, 다음 spec
개정도 akg가 발행한다(설계도 §5.3·§12-2). 골든 테스트는 양방향 어긋남 감지기로
유지 — akg 쪽은 `test/fixtures/foundry-golden-SKILL.md`(foundry 골든 산출물의
체크인 사본)로 그 계약을 고정한다.

**v2 의 뼈대**: `description`은 **필드가 아니다** — 렌더러가
`scope`+`focus`+`inputs`에서 합성한다(에이전트의 유일한 레버는 `focus`).
`valueRules`도 없다 — 값 의미(코드표)는 db-schema 문서 소관이다. 출력은 **형식을
강제하지 않고 내용에만 바닥**을 둔다: `steps[].produces`가 「반드시 포함」 줄을
만든다.

```jsonc
"body": {
  "name": "fdc-explain-sensor",             // 필수, kebab-case. 봉투 id와 일치, H1 = "# {name}"
  "argumentHint": "{snsr_id}",              // 필수 — 표시용 인자 힌트. inputs에서 합성:
                                            //   required는 {name}, 선택은 [name] (대시보드가 자동 유지)
  "scope": { "단위": "센서",                 // 필수 — 닫힌 enum 3축. description 골격·추적 방향을 고름
             "카디널리티": "단일",           //   단위 = 설비|챔버|센서, 카디널리티 = 단일,
             "의도": "상태" },               //   의도 = 상태|생성 이력 (비교·집계·이상 분석은 미도입)
  "focus": "정체·소속 설비·현재 상태",        // 필수 — description 빈칸을 채우는 도메인 구절(한 줄).
                                            //   라우팅용 요약이지 답의 목록이 아니다(그건 produces)
  "anchorTable": "FDC_SENSOR",              // 선택 — 있으면 테이블→스킬 결정적 라우팅
  "intro": "...",                           // 필수 — 도메인 주의사항(실행 도입부는 렌더러 고정)
  "inputs": [                               // 필수 — 인자 계약의 진실원(소비자 wiring 이 아니라 여기)
    { "name": "snsr_id", "required": true, "description": "조회 키" }
  ],
  "dependencies": [                         // 필수 — 필요한 MCP 만. fail-fast 문장은 렌더러 고정
    { "mcp": "agent-db-plugin", "tools": ["run_query"], "why": "센서·설비 조회" }
  ],
  "steps": [                                // 필수 — 순서 있는 조회 절차(흐름)
    { "title": "센서 조회",
      "produces": "센서 정체·상태",          // 선택 — 답에 기여하는 차원 한 마디.
                                            //   비면 조회만 하고 답엔 안 나옴(ID 해소 스텝 등)
      "lead": "...",                        // 선택
      "sql": "SELECT * FROM FDC_SENSOR WHERE SNSR_ID = :snsr_id",   // :bind 필수
      "binds": {                            // 선택 — 실행기 배선: 이 스텝 SQL 의 :bind 가 어디서 오는지
        "snsr_id": { "from": "arg", "arg": "snsr_id" }
      },                                    //   {from:"arg",arg} | {from:"step",step,column(앞 스텝 결과 컬럼)}
      "branches": [                         // 선택 — 흐름 제어. when 은 프로즈가 아니라 조건식
        { "when": "rows = 0", "then": "종료하고 '미등록 센서'로 답한다" }
      ],
      "notes": "..." }                      // 선택 — 분기가 아닌 자유 코멘트. 단일 raw md 문자열
  ],
  "output": {                               // 필수 — 형식은 자유, 내용에만 바닥
    "avoid": [                              // 필수, 3개 이상 —「끌리는 오추론」—「금하는 데이터 사실」
      "비활성 '사유'를 추측한다 — 사유 컬럼은 데이터에 없다"
    ],
    "examples": [                           // 필수, 2개 이상 — 넓은 질문 + 좁은 질문의 대비쌍
      { "ask": "S-0004 설명해줘", "answer": "..." },
      { "ask": "S-0004 어느 설비 거야?", "answer": "..." }
    ]
  },
  "discipline": "..."                       // 선택 — 생략 시 고정 규율 블록
}
```

**스키마 사영 시 필수 세부**(foundry 실행 대조로 확정): 배열은 **minItems**
(`steps`/`inputs`/`dependencies` 1, `avoid` 3, `examples` 2), 필수 문자열은
공백만으로 채울 수 없음(`\S` 패턴 — minLength로는 부족), `name`은
`^[a-z][a-z0-9-]*$`, `scope` 세 축은 **enum**, `inputs`에 필수 인자가 **최소
하나**(없으면 description 전제조건이 빈다). `binds` 값은 `from`으로 갈리는
두 닫힌 형태(if/then/else 사영, `step`은 integer) — 어느 쪽도 모르는 키를
받지 않는다.

**한 줄에 끼워 넣는 조각**(`focus`·`produces`·`examples[].ask`)은 개행과 선두
마크다운 블록 문자를 금지한다 — 줄 구조가 깨지고, description은 소비자
firstLine 계약까지 깨진다. `avoid` 항목은 형태 계약을 정규식으로 강제한다
(양쪽 6자 이상 + ` — ` 구분자): **개수만 세면** "부정확한 설명을 한다" 같은
규율의 재진술이 도메인 지식 행세로 통과했다.

**검증기가 표현 못 하는 것**: `steps[].produces`가 **최소 하나**는 있어야 한다는
규칙은 JSON Schema `contains`인데 `src/validate.mjs`가 구현하지 않아
`envelope.mjs`의 **시맨틱 체크**로 둔다(다른 타입의 sibling 비교와 같은 자리).
`steps[].binds`의 정합 3종도 같은 자리다 — ① `from:"arg"`의 arg가 `inputs`에
실재 ② `from:"step"`의 step이 **앞** 스텝 ③ SQL의 `:var` 집합과 binds 키
집합의 **정확 일치**(빠짐 = 실행 불가 스텝, 남음 = 근거 없는 주장. 따옴표
리터럴은 벗기고 스캔 — 날짜 마스크 속 `:`는 bind가 아니다). binds 없는 스텝은
검사하지 않는다 — 산문 소비자용 기존 spec은 그대로 유효하다.

**티어 예외 해소**: v1에서 이 타입만 갖고 있던 예외(`valueRules[].basis`의
`추정)` 인라인)는 **`valueRules` 제거와 함께 사라졌다** — 값 의미의 티어드 값
구조화는 db-schema 타입이 온전히 소유한다.

### 4.5 `unclassified/v1` — 타입 분류 밖의 md 문서

정형 타입 어디에도 **분류되지 않는** 문서를 담는 도피 타입. 이름이 그 의미를
그대로 말한다(초안의 `freeform`에서 개명 — "형식이 자유롭다"가 아니라 "분류
밖"이 요지, 사용자 피드백 2026-07-17). md가 진실원이고, JSON은 사이드카 메타만:

```jsonc
// store/unclassified/deploy-guide.meta.json
{
  "schema": "unclassified/v1",
  "id": "deploy-guide",                     // 본문 = store/unclassified/deploy-guide.md
  "keywords": [ { "kw": "deploy", "inject": "pointer" } ],
  "status": "active"
}
```

티어·승격·폼 편집 없음(편집은 textarea). 렌더 없음 — md 원본이 그대로
`rendered/unclassified/docs/`로 복사된다. 도입 여부 자체가 열린 질문(설계도
§12-4, 초안은 미도입 — 스키마만 예약). 계층 축 관점의 정리는 §1.4.

---

## 5. 파생물 스펙

### 5.1 `rendered/<type>/index.json` — 프로바이더 계약

**현행 keyword-docs 엔진 포맷 그대로**(`{keywords, path, precision}` 배열).
주입기 수정 0이 목표이므로 이 포맷은 허브가 바꿀 수 없는 외부 계약이다.

컴파일 규칙 — 문서마다 키워드를 `inject`별로 묶어 **최대 2엔트리로 분리 방출**:

```jsonc
[
  // ① full 묶음 — 앞순서, precision 생략(=1, 본문 주입)
  { "keywords": ["fdc_sensor"],
    "path": "docs/fdc_sensor.md" },
  // ② pointer 묶음 — 뒷순서, precision 0.5(포인터 주입)
  { "keywords": ["sensor"],
    "path": "docs/fdc_sensor.md", "precision": 0.5 }
]
```

기존 엔진의 스캔 순서 + seenPath dedup과 맞물려 "정확 키워드에 걸리면 본문,
광범위 키워드에만 걸리면 포인터"가 저절로 성립한다. `status: archived` 문서는
방출 제외. `path`는 인덱스 파일 기준 상대 경로(`docs/<id>.md`) — 미러 디렉토리가
자기완결이 되는 조건.

### 5.2 md 렌더에서의 티어 표기

티어드 값 → md 변환 규칙(현행 주입 규약과 동일 — CC 소비 측 무변경):

| tier | 렌더 결과 |
| --- | --- |
| scaffold | `{{설명}}` |
| inferred | `추정) <text> [근거: <evidence 나열>]` |
| confirmed | `<text> [근거: <evidence 나열>]` |
| deprecated | **렌더 제외** — 주입되지 않음(낡은 지식의 주입 방지). 대시보드·API 전용 |

`by`/`at`은 md로 렌더하지 않는다(대시보드·API 전용).

---

## 6. 스키마 파일의 관리

정본 = 레포의 JSON Schema(draft 2020-12) 파일. 상세 규칙은 설계도 §5.0.

```text
schemas/
  common/tiered-value.v1.schema.json     # §3 — 각 타입이 $ref로 참조
  db-schema/v1.schema.json            # §4.1
  msg-format/v1.schema.json           # §4.2
  domain-doc/v1.schema.json           # §4.3
  domain-skill/v1.schema.json         # §4.4 (foundry validateSpec의 사영)
  unclassified/v1.schema.json         # §4.5 (사이드카 메타)
```

- 전 층위 `additionalProperties: false` — 모르는 키는 검증 실패(오타로 필드가
  조용히 증발하는 것 방지).
- 소비자 3: 서버 쓰기 검증(ajv) / 대시보드 폼 생성 / `GET /api/schemas/:type`.
- 버전 규칙: 파괴적 변경(필드 제거·의미 변경·필수화) = 새 `v<N+1>.schema.json`
  및 마이그레이터 동반 강제(CI 골든 테스트가 게이트). 선택 필드 추가만 동일 버전
  허용. 문서는 `akg migrate`로 일괄 승격.
- 이 문서(§2~§5)와 스키마 파일이 어긋나면 **스키마 파일이 정본**이고 이 문서를
  고친다(레포 생성 후에는 이 문서가 `docs/json-spec.md`로 이관되어 스키마와 같은
  PR에서 함께 갱신).

---

## 7. 전체 예시 — 완전한 문서 한 건

```jsonc
// store/db-schema/fdc_sensor.json
{
  "schema": "db-schema/v1",
  "id": "fdc_sensor",
  "keywords": [
    { "kw": "fdc_sensor",          "inject": "full" },
    { "kw": "sensor",              "inject": "pointer" }
  ],
  "status": "active",
  "body": {
    "owner": "TESTUSER",
    "table": "FDC_SENSOR",
    "catalog": {
      "columns": [
        { "name": "SNSR_ID", "type": "VARCHAR2(30)", "nullable": false,
          "default": null, "comment": "센서 ID" },
        { "name": "EQP_ID",  "type": "VARCHAR2(30)", "nullable": false,
          "default": null, "comment": null },
        { "name": "USE_YN",  "type": "CHAR(1)",      "nullable": false,
          "default": "'Y'", "comment": null }
      ],
      "primaryKey": ["SNSR_ID"],
      "foreignKeys": [
        { "column": "EQP_ID", "refTable": "FDC_EQUIPMENT", "refColumn": "EQP_ID" }
      ],
      "indexes": [
        { "name": "IX_SENSOR_EQP", "unique": false, "columns": ["EQP_ID"] }
      ],
      "tableComment": null,
      "fetchedAt": "2026-07-17T05:10:00Z"
    },
    "purpose": {
      "text": "설비 센서 마스터. FDC 수집기가 쓰고 분석 배치가 읽는다",
      "tier": "inferred",
      "evidence": ["fdc-app/src/collector.ts:31"],
      "by": "adopt:renoir",
      "at": "2026-07-17T05:20:00Z"
    },
    "columnDescs": {
      "SNSR_ID": { "text": null, "tier": "scaffold" },
      "EQP_ID":  { "text": "소속 설비", "tier": "inferred",
                   "evidence": ["fdc-app/src/schema-map.ts:70"],
                   "by": "adopt:renoir", "at": "2026-07-17T05:20:00Z" },
      "USE_YN":  { "text": "센서 사용 여부('Y'=활성)", "tier": "confirmed",
                   "evidence": ["fdc-app/src/schema-map.ts:74"],
                   "by": "promote:renoir", "at": "2026-07-17T05:30:00Z" }
    },
    "queries": [
      { "sql": "SELECT * FROM FDC_SENSOR WHERE USE_YN = 'Y'",
        "note": { "text": "활성 센서 전수 조회", "tier": "inferred",
                  "evidence": ["fdc-app/src/sensor-repo.ts:44"],
                  "by": "adopt:renoir", "at": "2026-07-17T05:20:00Z" } }
    ]
  }
}
```

이 문서의 슬롯은 5개다: `purpose`, `columnDescs.SNSR_ID`(scaffold),
`columnDescs.EQP_ID`(inferred), `columnDescs.USE_YN`(confirmed),
`queries[0].note`(inferred, 행 속 중첩). 그 외 전부(봉투, catalog,
`queries[0].sql`)는 팩트·메타 — 평범한 key:value(§1.2 두 반구).

이 문서에서 파생되는 것: §5.1의 index.json 2엔트리와
`rendered/db-schema/docs/fdc_sensor.md`(SNSR_ID는 `{{설명}}`, EQP_ID는
`추정)` 표기, USE_YN은 평문+근거, 대표 쿼리 note는 `추정)` 표기) — 모두 같은 커밋.
