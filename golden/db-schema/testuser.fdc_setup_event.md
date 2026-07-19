# TESTUSER.FDC_SETUP_EVENT

<!-- dbdoc:manual:purpose -->
추정) 셋업/설비 변경 이벤트 — compare의 post-setup 매칭 anchor. 설비별 EVT_TIME 역순으로 조회되어 SetupEvent[]로 노출 [근거: fixtures/fdc-app/src/schema-map.ts:32; fixtures/fdc-app/src/equipment-repo.ts:68-85]
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| EVT_ID | NUMBER | N | "TESTUSER"."ISEQ$$_74742".nextval | {{설명}} |
| EQP_ID | VARCHAR2(20) | N | - | 추정) 설비 FK — FDC_EQUIPMENT.EQP_ID와 조인(equipmentFkCol) [근거: fixtures/fdc-app/src/schema-map.ts:68; fixtures/fdc-app/src/equipment-repo.ts:73] |
| EVT_TIME | DATE | N | - | 추정) 이벤트 시각 — SetupEvent.time으로 노출(ISO, TO_CHAR 'YYYY-MM-DD"T"HH24:MI') [근거: fixtures/fdc-app/src/schema-map.ts:36; fixtures/fdc-app/src/equipment-repo.ts:70] |
| EVT_TYPE_CD | VARCHAR2(4) | Y | - | 추정) 이벤트 유형 코드 — 'S'=setup, 'I'=info_change, 'M'=maintenance, 그 외 값은 'other'로 매핑 [근거: fixtures/fdc-app/src/schema-map.ts:72-76; fixtures/fdc-app/src/equipment-repo.ts:79; fixtures/fdc-app/src/contract.ts:28] |
| EVT_LABEL | VARCHAR2(200) | Y | - | 추정) 이벤트 라벨 — SetupEvent.label로 노출, NULL이면 응답에서 생략 [근거: fixtures/fdc-app/src/schema-map.ts:38; fixtures/fdc-app/src/equipment-repo.ts:80-82] |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: EVT_ID
- 인덱스: SYS_C008841(EVT_ID, UNIQUE); FDC_SETUP_EVENT_EQP_TIME_IX(EQP_ID, EVT_TIME)
- 관계: EQP_ID → FDC_EQUIPMENT.EQP_ID
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
추정) 설비별 이벤트 역순 조회: SELECT TO_CHAR(EVT_TIME,'YYYY-MM-DD"T"HH24:MI'), EVT_TYPE_CD, EVT_LABEL FROM FDC_SETUP_EVENT WHERE EQP_ID = :id ORDER BY EVT_TIME DESC [근거: fixtures/fdc-app/src/equipment-repo.ts:69-75]
<!-- dbdoc:end:queries -->
