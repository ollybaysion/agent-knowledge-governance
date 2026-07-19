# TESTUSER.FDC_SENSOR

<!-- dbdoc:manual:purpose -->
추정) 센서 — 설비 1:N 종속. EQP_ID FK로 조인되어 EquipmentDetail.sensors[]로 노출, SNSR_ID 순 정렬 [근거: fixtures/fdc-app/src/schema-map.ts:24; fixtures/fdc-app/src/equipment-repo.ts:39-52; fixtures/fdc-app/src/schema-map.ts:60-64]
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| SNSR_ID | VARCHAR2(20) | N | - | 추정) 센서 ID — sensors[].id로 노출, 조회 정렬 기준 [근거: fixtures/fdc-app/src/schema-map.ts:27; fixtures/fdc-app/src/schema-map.ts:61-64] |
| EQP_ID | VARCHAR2(20) | N | - | 추정) 설비 FK — FDC_EQUIPMENT.EQP_ID와 조인(equipmentFkCol) [근거: fixtures/fdc-app/src/schema-map.ts:28; fixtures/fdc-app/src/equipment-repo.ts:43] |
| SNSR_TYPE_CD | VARCHAR2(10) | Y | - | 추정) 센서 유형 코드 — values[]로 노출만, 값 의미 매핑은 코드에 없음 [근거: fixtures/fdc-app/src/schema-map.ts:63] |
| UNIT_CD | VARCHAR2(10) | Y | - | 추정) 측정 단위 코드 — values[]로 노출(2번째), 컬럼명 관례상 단위 [근거: fixtures/fdc-app/src/schema-map.ts:63] |
| USE_YN | CHAR(1) | N | 'Y' | 추정) values[]로 노출되는 값 컬럼(3번째) — 컬럼명 관례상 사용 여부 Y/N, 코드에 값 해석 없음 [근거: fixtures/fdc-app/src/schema-map.ts:63] |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: SNSR_ID
- 인덱스: SYS_C008836(SNSR_ID, UNIQUE)
- 관계: EQP_ID → FDC_EQUIPMENT.EQP_ID
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}
<!-- dbdoc:end:queries -->
