# fdc-explain-sensor-origin

## 한 줄 설명

센서 값이 어디서 오는지 — 설비에서 직접 올라오는 물리 센서인지, 다른 센서 값으로 계산되는 가상 센서인지 — 설명한다.

## 언제 호출되는가?

"S-0004 값 어디서 오는 거야?", "S-0004 물리 센서야 가상 센서야?", "S-0004 값은 어떻게 만들어져?" 처럼
센서 하나의 값의 출처를 물을 때. 물리면 어느 메시지의 어느 VID 로 들어오는지, 가상이면 어떤 수식이
어떤 입력 센서를 쓰는지까지 답한다.

## 도메인 지식

### FDC_SENSOR

- SNSR_KIND: PHYSICAL / VIRTUAL. 물리 센서는 설비가 올려 보내는 메시지의 VID 로 값이 들어오고,
  가상 센서는 수식으로 계산된다.
- 가상 센서의 입력 센서는 FDC_FORMULA_INPUT 에 있다. ARG_ORDER 는 수식의 인자 순서다 — 값의
  크기나 중요도가 아니다.

### 답하지 않는 것

- 물리인데 VID 가 안 잡히면 이름으로 추측하지 않는다 — 매핑이 없으면 없다고 답한다.
- 수식의 의미를 해석하지 않는다 — 데이터에 있는 것은 식과 입력 센서까지다.
- 입력 센서를 다시 파고들어 설명하지 않는다 — 이 스킬은 한 단계만 거슬러 올라간다.

### 답의 예

- "S-0004 값 어디서 오는 거야?" → S-0004는 물리 센서다. 설비가 올려 보내는 PROC_DATA 메시지의
  VID 1204로 값이 들어온다. 수식 계산 없이 그 값이 그대로 저장된다.
- "S-0007 값 어디서 오는 거야?" → S-0007은 가상 센서다. 값은 수식 (S-0004 + S-0005) / 2 로
  계산되고, 입력 센서는 S-0004·S-0005 둘이다. 두 입력 센서가 각각 어디서 오는지는 그 센서로 다시
  물어야 한다.

## 데이터

### snsr_id — 센서 ID

값의 출처를 물을 센서 (예: S-0004) — 사람이 준다.

```ask
어느 센서인가요? 센서 id(snsr_id)를 알려 주세요.
```

### sensor_row — 센서 행

물리인지 가상인지(SNSR_KIND) 와 기준 정보.

```sql
SELECT snsr_id, eqp_id, snsr_kind, snsr_type_cd, unit_cd
  FROM fdc_sensor WHERE snsr_id = :snsr_id
```

### message_row — 메시지 매핑

물리 센서일 때 — 값이 실려 오는 메시지의 VID 와 이름.

```sql
SELECT vid, msg_name FROM fdc_message WHERE snsr_id = :snsr_id
```

### formula_row — 수식

가상 센서일 때 — 값을 만드는 수식.

```sql
SELECT expr FROM fdc_formula WHERE snsr_id = :snsr_id
```

### formula_input_rows — 수식 입력 센서

가상 센서일 때 — 수식이 참조하는 입력 센서들, 인자 순서대로.

```sql
SELECT src_snsr_id, arg_order
  FROM fdc_formula_input WHERE snsr_id = :snsr_id
 ORDER BY arg_order
```
