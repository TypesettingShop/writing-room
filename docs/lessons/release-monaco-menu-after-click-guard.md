# Monaco 메뉴의 포인터 보호 구간 뒤에 마우스를 놓는다

## What happened

- 문서 API 브라우저 스펙은 우클릭으로 연 항목이 보이자 좌클릭했다. 클릭이 완료돼도 메뉴가 닫히지 않고 명령의 알림도 나타나지 않았다. 깨끗한 HEAD에서도 재현됐다.

## Why

- 설치된 Monaco 0.57의 menu.js는 메뉴를 렌더링한 뒤 오동작을 막기 위해 100ms를 기다려 mouseup 리스너를 등록한다. 실패 트레이스에서 항목 클릭은 우클릭 완료 약 80ms 뒤에 끝났다. Playwright의 visible, stable, enabled 검사는 DOM에 붙은 이 지연 리스너를 확인하지 않는다.

## Do this instead

- 포인터로 Monaco 메뉴 항목을 검증할 때 mouseup이 보호 구간 이후에 오도록 클릭에 지연을 준다. 항목이 사라지고 명령의 효과가 나타났는지를 함께 검증한다.

Learned in: wr-j641.3ty
