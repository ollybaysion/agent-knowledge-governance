---
name: fdc-explain-sensor
argument-hint: "{snsr_id}"
anchor-table: FDC_SENSOR
disable-model-invocation: true
description: >-
  "S-0004 설명해줘" 같은 질문에 답한다 (snsr_id 필요).
---

# fdc-explain-sensor

입력 `{snsr_id}`를 받아 아래 **필요 데이터**를 **조달 수단**으로 채우고,
채운 값으로 **출력 형식**대로 자연어로 답한다.

## 질문

> S-0004 설명해줘

센서 S-0004가 무엇을 재는 센서이고(종류·단위) 어느 설비에 속해 있으며 지금 쓰이는 상태인지, 쓰이지 않는다면 소속 설비 자체가 미사용이라 그런 것인지, 그리고 그 설비에 최근 어떤 정비 이벤트가 있었는지.

## 입력 파라미터

- **snsr_id** (필수) — 설명할 센서를 특정하는 조회 키

## 의존성

- **agent-db-plugin** (run_query) — 센서·설비·이벤트 조회

실행 전 `list_connections`로 확인하고, 없으면 무엇이 없는지 밝히고 멈춘다.

## 필요 데이터

알아야 할 것 하나에 조달 수단이 붙는다. 여럿이면 **아무거나 하나**면 되고,
조달 수단이 없는 항목은 이 스킬로 알 수 없는 것이다.

- **sensor_type** — 센서가 재는 값의 종류 ← `sensor_row.SNSR_TYPE_CD`
- **sensor_unit** — 측정 단위 ← `sensor_row.UNIT_CD`
- **sensor_active** — 센서가 지금 쓰이는 상태인지 ← `sensor_row.USE_YN`
- **owner_equipment** — 센서가 속한 설비 ← `equipment_row.EQP_NAME`
- **equipment_active** — 소속 설비 자체가 미사용인지 (`sensor_active = N` 일 때) ← `equipment_row.USE_YN`
- **recent_events** — 소속 설비의 최근 정비 이벤트 ← `event_rows.EVT_LABEL`

## 조달 수단

순서는 의미가 없다 — 각 쿼리는 그것을 지목한 필요 데이터 중 조건이 성립한 것이
하나라도 있을 때 실행한다.

### `sensor_row` — `fdc_sensor`

```sql
SELECT snsr_id, eqp_id, snsr_type_cd, unit_cd, use_yn
  FROM fdc_sensor WHERE snsr_id = :id
```

- `:id` ← 인자 `snsr_id`

### `equipment_row` — `fdc_equipment`

```sql
SELECT eqp_id, eqp_name, model_cd, vendor, use_yn
  FROM fdc_equipment WHERE eqp_id = :eqp
```

- `:eqp` ← `sensor_row.EQP_ID`

### `event_rows` — `fdc_setup_event`

```sql
SELECT TO_CHAR(evt_time, 'YYYY-MM-DD') AS d, evt_type_cd, evt_label
  FROM fdc_setup_event WHERE eqp_id = :eqp
 ORDER BY evt_time DESC FETCH FIRST 3 ROWS ONLY
```

- `:eqp` ← `sensor_row.EQP_ID`

`EVT_TYPE_CD`의 코드→뜻 번역은 표준 db-schema 문서(keyword-docs 주입)를 따른다.

## 출력 형식

채운 값으로 위 **질문**에 답한다. 정해진 형식은 없다.
체계적·논리적으로, 없는 정보는 지어내지 않는다.

**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): 센서가 재는 값의 종류 · 측정 단위 · 센서가 지금 쓰이는 상태인지 · 센서가 속한 설비 · 소속 설비의 최근 정비 이벤트

**조건부 포함**: 소속 설비 자체가 미사용인지 (`sensor_active = N` 일 때)

채우지 못한 항목이 있으면 **무엇을 못 채웠는지 밝히고** 채운 것만으로 답한다 —
빈칸을 추측으로 메우지 않는다.

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
