---
name: fdc-virtual-sensor-formula
disable-model-invocation: true
description: >-
  fdc-virtual-sensor-formula
---

# fdc-virtual-sensor-formula

## 도메인 지식

### 가상 센서 수식

- 가상 센서(SNSR_KIND = VIRTUAL)의 값은 FDC_FORMULA 의 수식으로 계산된다. 설비가 올려 보내는 값이 아니다.
- 수식의 입력 센서는 FDC_FORMULA_INPUT 에 있다. ARG_ORDER 는 수식에 넣는 순서다 — 값의 크기나 중요도가 아니다.
- 입력 센서도 가상일 수 있다. 이 문서는 한 단계만 설명하고, 입력 센서의 출처는 그 센서로 다시 묻는다.
