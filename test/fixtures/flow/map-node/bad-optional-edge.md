# 변환에 선택 간선

## 한 줄 설명

변환에 선택 간선 표본.

## 데이터

```mermaid
flowchart TD
  eqp-scope[[설비 범위]]
  snsr_id([센서]) -.-> to_trend{{이름 맞추기}}
  to_trend --> trend[트렌드]
  eqp-scope --> trend
```

### to_trend — 이름 맞추기

```map
param_id = snsr_id
```

### trend — 트렌드

```sql
select time, value from fdc_sensor_trend
where eqp_id = :eqp_id and param_id = :param_id
and time between :start_time and :end_time
```
