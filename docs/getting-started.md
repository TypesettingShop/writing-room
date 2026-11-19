# writing-room 시작하기

writing-room은 브라우저에서 실행하는 편집 워크벤치다. 텍스트를 Monaco에서 편집하고 탭과 뷰 컨테이너를 배치한 뒤, 새로고침해서 같은 작업을 이어갈 수 있다.

## 실행하기

Node.js와 npm을 설치한다. 지원하는 Node.js 버전 범위는 `^22.22.2 || ^24.15.0 || >=26.0.0`이다. 저장소 디렉터리에서 다음을 실행하고 Vite가 출력하는 주소를 Chromium 브라우저에서 연다.

```sh
npm ci
npm run dev
```

배포할 파일을 로컬에서 확인하려면 `npm run build`로 `dist/`를 새로 만들고 `npm run preview`로 연다. 개발 서버와 프리뷰의 주소가 다르면 브라우저는 각각의 오리진에 상태를 저장한다.

## 편집하고 배치하기

- 위쪽 메뉴 바의 **File → New Text File**로 Monaco 편집기를 연다. 에디터 툴바의 **Split Editor Right**는 같은 문서를 두 그룹에서 보여 준다. 한쪽에서 편집한 내용은 다른 쪽에도 반영된다.
- 탭을 같은 탭 줄에서 끌어 순서를 바꾸거나 다른 그룹의 중앙에 놓아 옮긴다. 본문의 가장자리에 놓으면 그룹을 그 방향으로 나눈다. 탭 줄의 빈 공간을 잡으면 그룹 전체가 이동한다.
- 왼쪽 액티비티 바에서 **Explorer**나 **Hello World**를 열면 사이드바에 해당 뷰가 표시된다. 아이콘을 아래 패널의 탭 줄로 끌거나 컨텍스트 메뉴의 **Move to Panel**을 선택하면 컨테이너의 뷰가 함께 이동한다. **View: Reset View Locations**는 컨테이너를 기본 위치로 돌린다. 새시를 끌어 사이드바와 패널 크기를 조절할 수 있다.
- 하단 상태 표시줄에 워크벤치와 확장의 상태 항목이 표시된다. **Hello World**의 **Greetings** 트리를 펼치고 뷰 툴바의 **Say Hello**를 실행하면 메시지와 상태 항목을 확인할 수 있다.

## 팔레트와 키

**F1**, **Ctrl+Shift+P**(macOS에서는 **Cmd+Shift+P**) 또는 **View → Command Palette**로 커맨드 팔레트를 연다. 커맨드 이름의 일부를 입력하고 **Enter**로 선택한다. 키가 연결된 커맨드는 메뉴와 팔레트에 키를 표시한다. **Ctrl+B**로 사이드바를, **Ctrl+J**로 패널을 표시하거나 숨긴다. macOS에서는 두 키의 **Ctrl** 대신 **Cmd**를 쓴다.

브라우저가 **Ctrl+N**, **Ctrl+W**, **Ctrl+T**와 macOS의 대응 키를 자체 창이나 탭에 사용할 수 있다. 워크벤치에서는 **File → New Text File**, 탭의 닫기 버튼, 팔레트의 **File: New Untitled Text File**과 **View: Close All Editors**를 사용할 수 있다.

## 사용자 설정 편집하기

**File → Preferences → Open User Settings (JSON)** 또는 팔레트의 **Preferences: Open User Settings (JSON)**으로 `settings.json`을 연다. 예를 들어 `{"editor.fontSize": 24}`를 쓰고 **Ctrl+S**(macOS에서는 **Cmd+S**)를 누르면 열린 편집기에 적용한다. Monaco에서 키를 자동 완성하고 값의 오류를 표시한다. 주석과 후행 쉼표를 쓸 수 있다. 지원하는 키와 기본값은 [아키텍처의 Settings 절](architecture.md#settings)에 있다.

## 확장 추가하기

- 내장 확장을 추가할 때는 매니페스트 `package.json`과 필요한 웹 진입 파일을 `extensions/` 아래의 한 폴더에 둔다. 개발 서버를 다시 시작하거나 프리뷰 빌드를 새로 만든다. `extensions/hello-world/`를 예제로 사용할 수 있다.
- URL에서 추가할 때는 팔레트에서 **Install Extension from Location...**을 실행한다. `package.json`을 제공하는 폴더 주소를 입력하고, 표시된 출판자·버전·오리진을 확인한 뒤 설치 항목을 선택한다. 원격 서버는 HTTPS와 CORS를 지원해야 하며 로컬 개발용 루프백 주소에는 HTTP를 쓸 수 있다. 제거는 팔레트의 **Uninstall Extension...**에서 해당 확장을 선택한다.
- 지원하는 매니페스트 항목, Worker에서 사용할 수 있는 API와 격리 경계는 [확장 API](extension-api.md)에 있다. 설치는 폴더 URL 방식이며 마켓플레이스와 VSIX 설치는 v0.1.0 범위 밖이다.

## 새로고침 뒤 이어서 작업하기

같은 브라우저 프로필에서 같은 사이트 주소를 열면 파트 크기·표시 여부, 뷰 컨테이너의 위치·선택, 에디터 그룹과 탭, 저장한 사용자 설정, 설치한 확장을 복원한다. 열린 설정 탭은 편집 중인 초안도 복원하며, 설정 적용은 저장할 때 일어난다. 제목 없는 문서의 텍스트는 최근 사용 순으로 합계 UTF-16 코드 유닛 1,000,000개까지 저장한다. 이 한도로 제외될 텍스트가 있으면 페이지를 떠날 때 브라우저가 확인을 요청한다. 복원한 에디터는 문서 맨 위에서 열린다.

v0.1.0은 탭 편집, 도킹, 설정 JSON, 웹 확장에 집중한다. 파일 시스템과 워크스페이스, 터미널, 디버그, 설정 UI, 테마 전환은 범위 밖이다.

## 검증하기

- `npm run typecheck`는 TypeScript를 확인하고, `npm test`는 Vitest 단위 테스트를 실행한다.
- 처음 브라우저 테스트를 실행하기 전에 `npx playwright install chromium`으로 Chromium을 설치한다. `npm run test:e2e -- --workers=2`는 개발 서버에서 브라우저 스위트를 실행한다. `E2E_TARGET=preview npm run test:e2e -- --workers=2`는 새 프로덕션 빌드를 만든 뒤 같은 스위트를 실행한다. 앱과 원격 확장 픽스처 서버는 Playwright가 각각 시작한다.
- `npm run test:e2e -- test/e2e/acceptance.spec.ts`는 도킹, 설정, 확장 설치 및 새로고침을 한 번에 확인하는 인수 시나리오만 실행한다. `moai wiki ls`로 위키 페이지와 링크를 확인할 수 있다.

Decided in: wr-cla6
