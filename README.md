# writing-room

브라우저에서 동작하는 텍스트 편집 워크벤치다(v0.2.0). Monaco 편집기, 탭과 뷰 도킹, 커맨드 팔레트, 사용자 설정, 브라우저 저장소의 워크스페이스와 Explorer, Worker에서 실행되는 웹 확장을 제공한다. VS Code와 같은 이름의 확장 API 부분집합을 제공하며, Open VSX의 웹 확장(`vscode.markdown`, `DavidAnson.vscode-markdownlint`, `vscode.markdown-language-features`)을 수정 없이 설치해 쓸 수 있다.

```sh
npm ci
npm run dev
```

- `npm run build`는 타입을 검사하고 `dist/`를 만든다. `npm run preview`는 만든 번들을 로컬에서 제공한다.
- `npm run typecheck`와 `npm test`는 타입과 단위 테스트를 확인한다.
- `npm run test:e2e -- --workers=2`는 개발 서버에서 Chromium 테스트를 실행한다. `E2E_TARGET=preview`를 앞에 붙이면 새 배포 빌드를 검사한다.

설치 요구 사항, 사용법, VS Code 조사 자료는 [문서 홈](docs/README.md)에 있다. 확장 API의 지원 범위는 [호환 표](docs/extension-api.md#호환-표)에, coder 같은 포워딩 주소에서 Webview까지 쓰는 법은 [시작하기](docs/getting-started.md#포워딩-주소에서-실행하기)에 있다. Monaco, Codicons, TextMate 문법 엔진(`vscode-textmate`, `vscode-oniguruma`)의 라이선스는 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)에 있으며 빌드에도 포함된다.

### 네이티브 도킹 테스트

Linux CI에서 Xvfb, xauth, Python 3, X11·XTest 공유 라이브러리(`libX11.so.6`, `libXtst.so.6`), Playwright의 headed Chromium 및 런타임 의존성을 준비한다. Chromium은 `npx playwright install chromium`으로 설치한다.

```sh
xvfb-run -a -s '-screen 0 1280x900x24' env E2E_NATIVE_DND=1 E2E_TARGET=preview \
  npm run test:e2e -- docking-native.spec.ts --workers=1
```

XTest는 디스플레이의 포인터를 직접 움직이므로 테스트 전용 디스플레이를 사용한다. `E2E_NATIVE_DND=1`을 지정하지 않은 일반 E2E 실행이나 X11·XTest 조건이 맞지 않는 환경에서는 이유와 함께 이 파일의 테스트를 건너뛴다. 개발 서버에서 실행하려면 `E2E_TARGET=preview`를 생략한다.

Wayland에서 확인하려면 Weston을 준비하고 Xvfb 안에 중첩 실행한다. XTest 입력은 Weston을 거쳐 Ozone Wayland로 실행한 Chrome에 도달한다.

```sh
xvfb-run -a -s '-screen 0 1280x900x24' env E2E_TARGET=preview \
  bash test/fixtures/with-weston.sh npm run test:e2e -- docking-native.spec.ts --workers=1
```

특정 Chrome 버전을 시험하려면 명령의 `env` 뒤에 `E2E_NATIVE_DND_CHROME=/path/to/chrome`을 추가한다.

브라우저가 도킹 드롭을 거절하는 상황을 재현하려면 `E2E_NATIVE_DND_REFUSE=1`을 추가한다. 이 설정에서는 앱의 드래그 MIME에 대해 `dropEffect`를 `none`으로 고정한다. 포인터 입력은 같은 XTest 경로를 따른다. HTML의 `drop` 이벤트에 의존하는 빌드에서는 표시가 나타난 뒤에도 배치가 바뀌지 않아 테스트가 실패한다.
