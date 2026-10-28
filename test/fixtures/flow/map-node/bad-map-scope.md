# 앞 노드가 내지 않은 설비 범위 이름

## 한 줄 설명

앞 노드가 내지 않은 설비 범위 이름 표본.

## 데이터

```mermaid
flowchart TD
  eqp-scope[[설비 범위]] --> param_list[파라미터 목록]
  param_list --> cross{{설비 2 로}}
  cross --> trend[트렌드]
  eqp-scope --> trend
```

### param_list — 파라미터 목록

```sql
select param_index, param_name from fdc_param where eqp_id = :eqp_id
```

### cross — 설비 2 로

```map
param_index = $eqp.index == 1 ? $eqp[0].go : param_index
go = true
```

### trend — 트렌드

```sql
select time, value from fdc_trend
where eqp_id = :eqp_id and param_index = :param_index
and time between :start_time and :end_time
```
