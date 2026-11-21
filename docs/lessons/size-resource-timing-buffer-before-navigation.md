# Resource Timing을 쓰는 브라우저 테스트는 첫 탐색 전에 버퍼를 설정한다

## What happened

- 글꼴 로딩 검사는 Chromium의 Resource Timing 항목에서 요청과 크기를 읽었다. Vite 개발 서버의 모듈 요청이 기본 버퍼를 먼저 채워 글꼴 요청이 빠졌고, 시작 시 요청이 없다는 검사도 그대로 통과했다.

## Why

- 브라우저는 Resource Timing 버퍼가 차면 뒤에 끝난 요청을 항목에 넣지 않을 수 있다. 빈 결과는 요청이 없을 때와 수집이 끊겼을 때 모두 나올 수 있다.

## Do this instead

- 첫 탐색 전에 init script에서 해당 테스트의 요청량을 수용할 버퍼를 설정한다.
- 요청이 없어야 하는 단계에 이어 실제 요청이 생기는 단계도 검사한다. 가능하면 요청 이벤트나 CSS 등록 여부를 함께 확인해 측정기가 비어 있는 경우와 구별한다.

Learned in: wr-ht6k.pua
