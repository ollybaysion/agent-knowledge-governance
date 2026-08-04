---
name: fdc-explain-sensor-origin
argument-hint: "{snsr_id}"
anchor-table: FDC_SENSOR
disable-model-invocation: true
description: >-
  "S-0004 값 어디서 오는 거야?", "S-0004 물리 센서야 가상 센서야?", "S-0004 값은 어떻게 만들어져?" 같은 질문에 답한다 (snsr_id 필요).
---

# fdc-explain-sensor-origin

입력 `{snsr_id}`를 받아 아래 **필요 데이터**를 **조달 수단**으로 채우고,
채운 값으로 **출력 형식**대로 자연어로 답한다.

## 질문

> S-0004 값 어디서 오는 거야?
>
> S-0004 물리 센서야 가상 센서야?
>
> S-0004 값은 어떻게 만들어져?

센서 S-0004의 값이 장비에서 직접 올라오는 것인지(물리) 다른 센서 값으로 계산되는 것인지(가상), 물리면 어느 메시지의 어느 VID로 들어오고, 가상이면 어떤 수식이 어떤 입력 센서를 쓰는지.

## 입력 파라미터

- **snsr_id** (필수) — 값의 출처를 물을 센서 (예: S-0004)

## 의존성

- **agent-db-plugin** (run_query) — 센서 기준 정보·메시지 매핑·수식 조회

실행 전 `list_connections`로 확인하고, 없으면 무엇이 없는지 밝히고 멈춘다.

## 필요 데이터

알아야 할 것 하나에 조달 수단이 붙는다. 여럿이면 **아무거나 하나**면 되고,
조달 수단이 없는 항목은 이 스킬로 알 수 없는 것이다.

- **sensor_kind** — 물리인지 가상인지 ← `sensor_row.SNSR_KIND`
- **message_vid** — 값이 실려 오는 메시지의 VID (`sensor_kind = PHYSICAL` 일 때) ← `message_row.VID`
- **message_name** — 그 메시지의 이름 (`sensor_kind = PHYSICAL` 일 때) ← `message_row.MSG_NAME`
- **formula_expr** — 값을 만드는 수식 (`sensor_kind = VIRTUAL` 일 때) ← `formula_row.EXPR`
- **formula_inputs** — 수식이 참조하는 입력 센서들 (`sensor_kind = VIRTUAL` 일 때) ← `formula_input_rows.SRC_SNSR_ID`

## 조달 수단

순서는 의미가 없다 — 각 쿼리는 그것을 지목한 필요 데이터 중 조건이 성립한 것이
하나라도 있을 때 실행한다.

### `sensor_row` — `fdc_sensor`

```sql
SELECT snsr_id, eqp_id, snsr_kind, snsr_type_cd, unit_cd
  FROM fdc_sensor WHERE snsr_id = :id
```

- `:id` ← 인자 `snsr_id`

### `message_row` — `fdc_message`

```sql
SELECT vid, msg_name FROM fdc_message WHERE snsr_id = :id
```

- `:id` ← 인자 `snsr_id`

### `formula_row` — `fdc_formula`

```sql
SELECT expr FROM fdc_formula WHERE snsr_id = :id
```

- `:id` ← 인자 `snsr_id`

### `formula_input_rows` — `fdc_formula_input`

```sql
SELECT src_snsr_id, arg_order
  FROM fdc_formula_input WHERE snsr_id = :id
 ORDER BY arg_order
```

- `:id` ← 인자 `snsr_id`

`ARG_ORDER`는 수식의 인자 순서다 — 값의 크기나 중요도가 아니다.

## 출력 형식

채운 값으로 위 **질문**에 답한다. 정해진 형식은 없다.
체계적·논리적으로, 없는 정보는 지어내지 않는다.

**반드시 포함** (질문이 특정 항목만 묻는 게 아니면): 물리인지 가상인지

**조건부 포함**: 값이 실려 오는 메시지의 VID (`sensor_kind = PHYSICAL` 일 때) · 그 메시지의 이름 (`sensor_kind = PHYSICAL` 일 때) · 값을 만드는 수식 (`sensor_kind = VIRTUAL` 일 때) · 수식이 참조하는 입력 센서들 (`sensor_kind = VIRTUAL` 일 때)

채우지 못한 항목이 있으면 **무엇을 못 채웠는지 밝히고** 채운 것만으로 답한다 —
빈칸을 추측으로 메우지 않는다.

**하지 말 것**

- 물리인데 VID가 안 잡히면 이름으로 추측한다 — 매핑이 없으면 없다고 답한다
- 수식의 의미를 해석한다 — 데이터에 있는 것은 식과 입력 센서까지다
- 입력 센서를 다시 파고들어 설명한다 — 이 스킬은 한 단계만 거슬러 올라간다

**예시** (모양만 참고, 값은 조회 결과로 바꾼다)

> **질문**: S-0004 값 어디서 오는 거야?
> **답**: S-0004는 물리 센서다. 설비가 올려 보내는 PROC_DATA 메시지의 VID 1204로 값이 들어온다.
> 수식 계산 없이 그 값이 그대로 저장된다.

> **질문**: S-0007 값 어디서 오는 거야?
> **답**: S-0007은 가상 센서다. 값은 수식 (S-0004 + S-0005) / 2 로 계산되고, 입력 센서는 S-0004·S-0005 둘이다.
> 두 입력 센서가 각각 어디서 오는지는 그 센서로 다시 물어야 한다.

## 규율

- 조회는 read-only MCP 경유만, 값은 항상 바인드 — SQL에 사용자 입력을
  식별자로 넣지 않는다.
- 코드표·관례로 해석한 부분과 센서값 그대로인 부분을 출력에서 구분한다 —
  모르는 값을 아는 척하지 않는다 (코드표는 표준 db-schema 문서에서 주입).
- 조회 중 새 의미(코드값·컬럼 뜻)를 알게 되면 문서를 직접 고치지 않고
  db-schema-apply 제안 JSON으로 넘긴다 (승격은 사람).
