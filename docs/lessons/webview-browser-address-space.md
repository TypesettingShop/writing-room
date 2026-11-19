# 웹뷰 브라우저 검사에서 실제 앱 주소 응답을 사용한다

## What happened

- 요소 하니스가 Playwright route.fulfill로 루프백 앱의 HTML을 합성했다.
- Chromium은 앱 응답의 루프백 주소 공간을 확인할 수 없어 localhost 셸 탐색을 차단했다. 같은 기능은 실제 앱 주소에서 열면 동작했다.

## Do this instead

- 브라우저를 실제 개발·프리뷰 HTTP 응답으로 이동시켜 앱 오리진과 네트워크 주소 공간을 정한다.
- 그 페이지에서 테스트 전용 모듈을 실행해 요소를 만들고, iframe·서비스 워커는 제품 서버가 실제로 제공하는 파일로 검증한다.

Learned in: wr-cpnc.hs9
