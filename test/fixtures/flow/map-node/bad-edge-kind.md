# 변환에서 입력으로

## 한 줄 설명

변환에서 입력으로 표본.

## 데이터

```mermaid
flowchart TD
  eqp-scope[[설비 범위]] --> m{{챔버 이름}}
  ch([챔버])
  m --> ch
```

### m — 챔버 이름

```map
ch = eqp_id
```
