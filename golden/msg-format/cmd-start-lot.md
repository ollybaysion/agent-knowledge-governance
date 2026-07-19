# CMD_START_LOT

Host → Equipment. 로트 시작을 지시한다 [근거: fdc-eqp/src/cmd/start-lot.ts:12]

| # | 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| 1 | LOT_ID | string(20) | ✓ | 추정) 로트 식별자 [근거: fdc-eqp/src/cmd/start-lot.ts:14] |
| 2 | RECIPE_ID | string(20) | ✓ | {{설명}} |

## 예시 페이로드

**정상**

```
{"LOT_ID":"L2401","RECIPE_ID":"R-100"}
```
