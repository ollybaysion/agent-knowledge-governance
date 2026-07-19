---
name: fdc-explain-sensor
argument-hint: "{snsr_id}"
disable-model-invocation: true
description: >-
  센서 하나를 자연어로 설명한다.
  FDC_SENSOR에서 시작해 정의된 순서·분기대로 소속 설비(FDC_EQUIPMENT)·최근 이벤트(FDC_SETUP_EVENT)를 조회하고, 값 코드를 해석해 명시된 출력 형식으로 요약한다.
  agent-db-plugin MCP(run_query) 필요. /fdc-explain-sensor 로만 호출된다 (모델 자동 발동 없음).
---

# fdc-explain-sensor

주어진 인자를 받아, 아래 **조회 절차를 순서대로** 실행하고 얻은 값들을
**출력 형식**대로 자연어로 바꿔 답한다. 모든 조회는 지정된 read-only MCP로
하고, 값은 항상 바인드로 넘긴다.

인자 `{snsr_id}`는 센서 ID 하나다(예: `S-0001`).

## 조회 절차

### 1단계 — 센서 기본 정보

```sql
SELECT snsr_id, eqp_id, snsr_type_cd, unit_cd, use_yn
  FROM fdc_sensor WHERE snsr_id = :id
```

- **0행이면 종료**: "센서 {id}는 등록되어 있지 않다"고 답하고 끝.
- `USE_YN = 'N'`이면 → 출력에 **비활성** 명시 (3단계도 계속 진행 — 왜
  비활성인지 이벤트에서 단서가 나올 수 있음).

### 2단계 — 소속 설비

1단계의 `EQP_ID`로:

```sql
SELECT eqp_id, eqp_name, model_cd, vendor, use_yn
  FROM fdc_equipment WHERE eqp_id = :eqp
```

- **분기**: 설비도 `USE_YN = 'N'`이면 → "설비 자체가 미사용"을 출력에 우선
  명시(센서 비활성의 상위 원인일 수 있음).

### 3단계 — 설비 최근 이벤트 (정비 맥락)

```sql
SELECT TO_CHAR(evt_time, 'YYYY-MM-DD') AS d, evt_type_cd, evt_label
  FROM fdc_setup_event WHERE eqp_id = :eqp
 ORDER BY evt_time DESC FETCH FIRST 3 ROWS ONLY
```

- `EVT_TYPE_CD`는 아래 코드표로 해석. 코드표에 없는 값은 "기타(센서값)"로
  표기 — 지어내지 않는다.

## 값 해석 규칙

| 대상 | 규칙 | 근거 |
| --- | --- | --- |
| EVT_TYPE_CD | `S`=셋업, `I`=정보 변경, `M`=정비, 그 외=기타 | 추정) fixtures/fdc-app/src/schema-map.ts:72-76, equipment-repo.ts:79 |
| USE_YN | `Y`=사용, `N`=미사용 | 추정)(약함 — 컬럼명 관례, 코드에 해석 없음) |
| SNSR_TYPE_CD / UNIT_CD | 센서값 그대로 표기 (의미 매핑 미확인) | scaffold |
| CHM_ID 포맷 | `<EQP_ID>-<식별자>` 복합 키로 추정 — 파싱해 설비 유추 가능 | 추정)(약함 — 시드 데이터 관찰) |

## 출력 형식

한 문단, 다음 순서로 (없는 정보는 문장째 생략):

> 센서 **{SNSR_ID}**는 {EQP_NAME}({EQP_ID}, {VENDOR} {MODEL_CD})의
> **{SNSR_TYPE_CD}** 센서(단위 {UNIT_CD})로, 현재 {사용 중|**비활성**}이다.
> {설비가 미사용이면: 소속 설비 자체가 미사용 상태다.}
> 최근 설비 이벤트: {날짜} {해석된 유형}({라벨}), … .
> {코드표 밖 값·미확인 의미가 있으면: ⚠ {센서값}은 의미 미확인.}

예시 (시드 데이터 기준):

> 센서 **S-0004**는 증착기 1호(CVD-01, AMAT CV-800)의 **FLOW** 센서(단위
> SCCM)로, 현재 **비활성**이다. 소속 설비 자체가 미사용 상태다. 최근 설비
> 이벤트: 2026-05-11 기타(센서값 O). ⚠ SNSR_TYPE_CD=FLOW, UNIT_CD=SCCM은
> 의미 미확인(센서값 표기).

## 규율

- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을
  식별자로 넣지 않는다.
- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다
  (위 ⚠ 규칙) — 모르는 값을 아는 척하지 않는다.
- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고
  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람).
