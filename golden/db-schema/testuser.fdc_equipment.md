# TESTUSER.FDC_EQUIPMENT

<!-- dbdoc:manual:purpose -->
추정) 설비 마스터 — 설비 상세·peers 조회의 루트 테이블. 챔버·센서·셋업이벤트가 EQP_ID로 1:N 종속 [근거: fixtures/fdc-app/src/schema-map.ts:7; fixtures/fdc-app/src/equipment-repo.ts:16-37]
<!-- dbdoc:end:purpose -->

<!-- dbdoc:auto:columns -->
| 컬럼 | 타입 | 널 | 기본값 | 설명 |
| --- | --- | --- | --- | --- |
| EQP_ID | VARCHAR2(20) | N | - | 설비 ID |
| EQP_NAME | VARCHAR2(100) | N | - | 추정) 설비명 — EquipmentDetail.name으로 노출, ContextRow.equipment와 매칭되는 키 [근거: fixtures/fdc-app/src/schema-map.ts:11; fixtures/fdc-app/src/contract.ts:15] |
| MODEL_CD | VARCHAR2(20) | Y | - | 추정) 설비 모델 코드 — peers(동종 설비) 매칭 키(같은 MODEL_CD = 동종), UI 미노출 [근거: fixtures/fdc-app/src/schema-map.ts:12; fixtures/fdc-app/src/equipment-repo.ts:58; fixtures/fdc-app/src/contract.ts:17] |
| VENDOR | VARCHAR2(50) | Y | - | 추정) 설비 상세 values[]로 노출되는 값 컬럼(순서 보존, 1번째) [근거: fixtures/fdc-app/src/schema-map.ts:50; fixtures/fdc-app/src/equipment-repo.ts:18-22] |
| INSTALL_DT | DATE | Y | - | 추정) 설비 상세 values[]로 노출되는 값 컬럼(2번째) — 컬럼명 관례상 설치일 [근거: fixtures/fdc-app/src/schema-map.ts:50] |
| USE_YN | CHAR(1) | N | 'Y' | 추정) values[]로 노출되는 값 컬럼(3번째) — 컬럼명 관례상 사용 여부 Y/N, 코드에 값 해석 없음 [근거: fixtures/fdc-app/src/schema-map.ts:50] |
<!-- dbdoc:end:columns -->

<!-- dbdoc:auto:keys -->
- PK: EQP_ID
- 인덱스: SYS_C008830(EQP_ID, UNIQUE)
<!-- dbdoc:end:keys -->

---

## 대표 쿼리

<!-- dbdoc:manual:queries -->
추정) 동종 설비(peers) 조회: SELECT p.EQP_ID FROM FDC_EQUIPMENT p JOIN FDC_EQUIPMENT me ON p.MODEL_CD = me.MODEL_CD WHERE me.EQP_ID = :id AND p.EQP_ID <> :id [근거: fixtures/fdc-app/src/equipment-repo.ts:55-64]
<!-- dbdoc:end:queries -->
