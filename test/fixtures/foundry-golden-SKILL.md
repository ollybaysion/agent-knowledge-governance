---
name: fdc-explain-sensor
argument-hint: "{snsr_id}"
anchor-table: FDC_SENSOR
disable-model-invocation: true
description: >-
  특정 센서의 정체·소속 설비·현재 상태를 묻는 상황에서 호출한다 (snsr_id 필요).
---

# fdc-explain-sensor

입력 `{snsr_id}`를 받아 아래 **조회 절차**를 순서대로 실행하고,
얻은 값을 **출력 형식**대로 자연어로 답한다.

센서 하나의 기준 정보를 조회해 설명한다 — 종류·단위, 소속 설비, 활성/비활성 상태, 최근 설비 이벤트 맥락. 센서가 비활성이면 소속 설비의 미사용 여부까지 짚어 원인 단서를 준다.

## 입력 파라미터

- **snsr_id** (필수) — 설명할 센서를 특정하는 조회 키

## 의존성

- **agent-db-plugin** (run_query) — 센서·설비·이벤트 조회

실행 전 `list_connections`로 확인하고, 없으면 무엇이 없는지 밝히고 멈춘다.

## 조회 절차

### 1단계 — 센서 기본 정보

```sql
SELECT snsr_id, eqp_id, snsr_type_cd, unit_cd, use_yn
  FROM fdc_sensor WHERE snsr_id = :id
```

- 만약 rows = 0 → 종료하고 "센서 {id}는 등록되어 있지 않다"로 답한다

### 2단계 — 소속 설비

1단계의 `EQP_ID`로:

```sql
SELECT eqp_id, eqp_name, model_cd, vendor, use_yn
  FROM fdc_equipment WHERE eqp_id = :eqp
```

### 3단계 — 설비 최근 이벤트 (정비 맥락)

```sql
SELECT TO_CHAR(evt_time, 'YYYY-MM-DD') AS d, evt_type_cd, evt_label
  FROM fdc_setup_event WHERE eqp_id = :eqp
 ORDER BY evt_time DESC FETCH FIRST 3 ROWS ONLY
```

`EVT_TYPE_CD`의 코드→뜻 번역은 표준 db-schema 문서(keyword-docs 주입)를 따른다.

## 출력 형식

조회한 데이터로 센서의 정체·소속 설비·현재 상태를 설명한다. 정해진 형식은 없다.
체계적·논리적으로, 없는 정보는 지어내지 않는다.

**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): 센서 정체·상태 · 소속 설비 · 최근 설비 이벤트

**하지 말 것**

- 비활성 '사유'를 추측한다 — 사유 컬럼은 데이터에 없다
- 마지막 측정값·정상 여부를 지어낸다 — 이 스킬 범위 밖이다
- 이벤트 코드 '기타'를 '정기 점검' 등으로 구체화한다 — 라벨 이상은 모른다

**예시** (모양만 참고, 값은 조회 결과로 바꾼다)

> **질문**: S-0004 설명해줘
> **답**: 센서 S-0004는 증착기 1호(CVD-01, AMAT CV-800)의 FLOW 센서(SCCM)로, 현재 비활성이다.
> 소속 설비 자체가 미사용 상태다. 최근 설비 이벤트: 2026-05-11 기타.
> ⚠ SNSR_TYPE_CD=FLOW, UNIT_CD=SCCM은 의미 미확인.

> **질문**: S-0004 어느 설비 거야?
> **답**: 센서 S-0004는 증착기 1호(CVD-01)에 속한다. 다만 이 설비는 현재 미사용 상태다.

## 규율

- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을
  식별자로 넣지 않는다.
- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다 —
  모르는 값을 아는 척하지 않는다 (코드표는 표준 db-schema 문서에서 주입).
- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고
  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람).
