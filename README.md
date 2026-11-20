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
