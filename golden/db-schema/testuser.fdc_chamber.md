# TESTUSER.FDC_CHAMBER

<!-- dbdoc:manual:purpose -->
추정) 챔버 — 설비 1:N 종속. EQP_ID FK로 조인되어 EquipmentDetail.chambers[]로 노출, CHM_NO 순 정렬 [근거: fixtures/fdc-app/src/schema-map.ts:16; fixtures/fdc-app/src/equipment-repo.ts:39-52; fixtures/fdc-app/src/schema-map.ts:53-58]
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| CHM_ID | VARCHAR2(20) | N | - | 추정) 챔버 ID — chambers[].id로 노출 [근거: fixtures/fdc-app/src/schema-map.ts:19; fixtures/fdc-app/src/schema-map.ts:54] |
| EQP_ID | VARCHAR2(20) | N | - | 추정) 설비 FK — FDC_EQUIPMENT.EQP_ID와 조인(equipmentFkCol) [근거: fixtures/fdc-app/src/schema-map.ts:20; fixtures/fdc-app/src/equipment-repo.ts:43] |
| CHM_NO | NUMBER(3,0) | Y | - | 추정) 챔버 번호 — chambers[] 조회의 정렬 기준(orderByCol), values[]에도 노출 [근거: fixtures/fdc-app/src/schema-map.ts:56-57; fixtures/fdc-app/src/equipment-repo.ts:44] |
| STATUS_CD | VARCHAR2(10) | Y | - | 추정) 챔버 상태 코드 — values[]로 노출만, 값 의미 매핑은 코드에 없음 [근거: fixtures/fdc-app/src/schema-map.ts:56] |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: CHM_ID
- 인덱스: SYS_C008832(CHM_ID, UNIQUE)
- 관계: EQP_ID → FDC_EQUIPMENT.EQP_ID
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}
<!-- dbdoc:end:queries -->
