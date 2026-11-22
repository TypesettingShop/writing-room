# writing-room 문서

writing-room은 브라우저에서 VS Code처럼 동작하는 웹 워크벤치다. 액티비티 바, 사이드바, 탭 에디터, 패널, 상태 표시줄, 메뉴 바, 커맨드 팔레트, 확장 시스템, 드래그 도킹을 TypeScript와 Vite로 직접 구현한다(프레임워크 없음). 워크벤치를 실행하려면 시작하기를 읽는다(coder 같은 포워딩 주소에서 실행하는 법 포함). 확장을 만들거나 지원 범위를 알고 싶으면 확장 API 색인의 호환 표를 읽는다. 조사 페이지는 코드 작성자와 리뷰어가 VS Code의 구현과 대조할 때 참고한다.

## 기준 VS Code 커밋

- 저장소: `https://github.com/microsoft/vscode`
- 커밋: `41004e061e582855eb1e99b6a6e5d52994f661be` (`main`, 2026-11-18, 패키지 버전 1.148.0)
- 모든 페이지의 VS Code 경로와 심볼은 이 커밋을 기준으로 확인했다. 다른 커밋에서 확인한 내용은 유효하지 않다. `main` 브랜치는 계속 갱신되므로 최신 `main`과 차이가 날 수 있다.
- 경로는 VS Code의 원본 경로(`src/vs/...`) 그대로 적는다. 줄 번호는 변경될 수 있으므로 표기하지 않는다. 핵심은 심볼 이름이다.
- VS Code는 참고용이다. 각 페이지는 개념을 설명하고 일부를 짧게 인용할 뿐 소스 전체를 재현하지 않는다.

## 페이지

| 페이지 | 다루는 것 |
| --- | --- |
| [getting-started.md](getting-started.md) | 설치, 조작, 파일, 설정, 확장 설치와 서명의 뜻, 포워딩 주소에서 실행하기, 테스트 실행 |
| [extension-api.md](extension-api.md) | v0.2.0 호환 표(네임스페이스별 지원 범위, 받기만 하는 API, 지원하지 않는 네임스페이스와 기여 지점, 인수한 확장), 매니페스트와 진입점, 영역 페이지 색인 |
| [maintainability.md](maintainability.md) | 레이어 규칙, 의존성 주입, 레지스트리와 기여, 에디터와 확장 시스템에 기능 추가하기, 저장, 테스트, 기술 부채, 브랜치와 PR 규칙 |
| [editor-services.md](editor-services.md) | 모델, 에디터 해석기, 파일 저장과 닫기, 테마 및 컨텍스트 키 이음매 |
| [markdown-editor.md](markdown-editor.md) | 마크다운 클래스 속성과 편집 뒤 정규화 규칙 |
| [architecture.md](architecture.md) | VS Code 경로와 이 저장소 경로의 대응표, VS Code와 달라진 점 목록 |
| [vscode-workbench-layout.md](vscode-workbench-layout.md) | 파트, 워크벤치 조립, 그리드·스플릿뷰·새시, 뷰 컨테이너 위치, 크기 제약 |
| [vscode-editor-groups.md](vscode-editor-groups.md) | 에디터 그룹과 탭, 에디터 입력과 페인, Monaco, 드래그 앤 드롭 |
| [vscode-menus-commands.md](vscode-menus-commands.md) | 커맨드, 메뉴, 컨텍스트 키, 메뉴 바, 키바인딩, 커맨드 팔레트 |
| [vscode-extensions.md](vscode-extensions.md) | 매니페스트와 기여 지점, 활성화, 웹 워커 확장 호스트, 양면 API, 브라우저에서의 설치 |
| [vscode-web-build.md](vscode-web-build.md) | 브라우저가 처음 로드하는 것, 서빙과 빌드, 내장 확장, Vite 빌드와의 관계 |
| [vscode-state-settings.md](vscode-state-settings.md) | 스토리지 서비스, 누가 무엇을 언제 저장하는가, 설정 |

## 확장 API 영역 페이지

[extension-api.md](extension-api.md)가 색인이다. 영역마다 한 페이지가 지원 범위, 동작, VS Code와 달라진 점을 적는다.

| 페이지 | 다루는 것 |
| --- | --- |
| [extension-api-documents.md](extension-api-documents.md) | 문서와 에디터: 열기, 읽기, 편집, 이벤트, 탭 |
| [extension-api-language-contributions.md](extension-api-language-contributions.md) | `languages`, `grammars`, `snippets` 기여와 언어 모드 |
| [extension-api-language-features.md](extension-api-language-features.md) | 언어 기능 제공자, 워크스페이스 기호(Go to Symbol in Workspace), 받기만 하는 제공자 |
| [extension-api-diagnostics.md](extension-api-diagnostics.md) | 진단 컬렉션, Problems 뷰, 상태 표시줄 |
| [extension-api-file-system.md](extension-api-file-system.md) | `workspace.fs`, 파일 접근 범위, 감시, 확장이 제공하는 파일 시스템 |
| [files-and-explorer.md](files-and-explorer.md) | 브라우저 저장소의 워크스페이스, 파일 편집과 저장, Explorer |
| [extension-api-webview.md](extension-api-webview.md) | Webview, 오리진, 포워딩 주소에서 실행하기, 상태 복원 |
| [extension-api-custom-editors.md](extension-api-custom-editors.md) | Custom Editor와 Reopen With |
| [extension-api-configuration.md](extension-api-configuration.md) | `configuration`과 `configurationDefaults` 기여, `getConfiguration` |
| [extension-api-window-ui.md](extension-api-window-ui.md) | QuickPick, InputBox, OutputChannel, 메시지, 진행 표시 |
| [extension-api-theming-and-views.md](extension-api-theming-and-views.md) | 색 테마와 색, 상태 표시줄 색, 트리 뷰 |
| [extension-api-runtime.md](extension-api-runtime.md) | 상태, 환경, 활성화와 종료, 확장 호스트 로그, 지역화, Worker |
| [extension-installation.md](extension-installation.md) | VSIX와 Open VSX 설치, 무결성과 서명, 패키지 저장소 |

## 교훈

리뷰와 작업에서 얻은 규칙이다. 새 규칙을 만들기 전에 같은 교훈이 있는지 `moai wiki search`로 본다.

- [lessons/assert-effects-before-follow-up.md](lessons/assert-effects-before-follow-up.md) — 검사 대상 동작 직후의 상태와 이벤트를 확인한다
- [lessons/batch-all-node-events.md](lessons/batch-all-node-events.md) — 트리를 떼었다 붙이는 동안에는 모든 노드 이벤트를 막고 끝에서 한 번 맞춘다
- [lessons/bound-remote-resource-streams.md](lessons/bound-remote-resource-streams.md) — 원격 리소스는 읽는 도중에 바이트 한도를 적용한다
- [lessons/branch-on-memory-mode-by-what-the-task-touches.md](lessons/branch-on-memory-mode-by-what-the-task-touches.md) — 메모리 모드로 길을 가를 때는 작업이 실제로 닿는 저장소를 보고, 모드는 결정마다 다시 읽지 않는다
- [lessons/check-tree-overlap-after-normalizing.md](lessons/check-tree-overlap-after-normalizing.md) — 덮어쓰기 전에 정규화한 원본과 대상 트리의 겹침을 검사한다
- [lessons/delete-only-what-records-disown.md](lessons/delete-only-what-records-disown.md) — 지우는 코드는 읽지 못한 기록을 "없음"으로 보지 않는다
- [lessons/extension-contributions-default-before-localization.md](lessons/extension-contributions-default-before-localization.md) — 확장 기본 기여는 지역화 읽기 전에 등록한다
- [lessons/first-text-model-waits-for-monaco.md](lessons/first-text-model-waits-for-monaco.md) — 처음 여는 텍스트 모델을 기다리는 e2e는 Monaco 로드를 셈에 넣는다
- [lessons/freeze-clock-before-testing-timeouts.md](lessons/freeze-clock-before-testing-timeouts.md) — 시간 의존 브라우저 테스트는 동작을 시작하기 전에 시계를 멈춘다
- [lessons/invalidate-caches-of-serialized-fields.md](lessons/invalidate-caches-of-serialized-fields.md) — 직렬화 값에 필드를 더하면 그 값을 담아 두는 캐시의 무효화 조건도 함께 고친다
- [lessons/keep-file-watch-provider-order.md](lessons/keep-file-watch-provider-order.md) — 이름 바꾸기 감시는 제공자의 변경 순서로 시험한다
- [lessons/keep-network-opt-out-on-config-fallback.md](lessons/keep-network-opt-out-on-config-fallback.md) — 설정의 기본값으로 돌아갈 때도 명시적인 네트워크 비활성화를 보존한다
- [lessons/match-keybinding-keys-by-code.md](lessons/match-keybinding-keys-by-code.md) — 워크벤치 키바인딩과 겨루는 키 판정은 물리 키(code)도 본다
- [lessons/preserve-existing-command-callers.md](lessons/preserve-existing-command-callers.md) — 같은 이름으로 명령을 등록할 때는 기존 호출 경로를 함께 지킨다
- [lessons/release-monaco-menu-after-click-guard.md](lessons/release-monaco-menu-after-click-guard.md) — Monaco 메뉴의 포인터 보호 구간 뒤에 마우스를 놓는다
- [lessons/reuse-open-input-that-owns-its-model.md](lessons/reuse-open-input-that-owns-its-model.md) — 모델을 가진 입력은 리소스마다 하나만 만든다
- [lessons/round-trip-extension-api-values.md](lessons/round-trip-extension-api-values.md) — 확장 API 값의 RPC 왕복을 검증한다
- [lessons/round-trip-through-reuse-and-rewrite.md](lessons/round-trip-through-reuse-and-rewrite.md) — 저장 왕복 테스트에서 원문 재사용과 다시 쓰기를 각각 실행한다
- [lessons/separate-saved-preference-from-availability.md](lessons/separate-saved-preference-from-availability.md) — 사용자 선택과 현재 가용성을 별도 상태로 유지한다
- [lessons/share-validation-between-live-and-restored-values.md](lessons/share-validation-between-live-and-restored-values.md) — API 입력과 저장된 값을 같은 검증기로 되살린다
- [lessons/test-both-sides-of-extension-release.md](lessons/test-both-sides-of-extension-release.md) — 확장 정리는 메인의 remove와 호스트의 release를 따로 테스트한다
- [lessons/test-file-provider-before-activation.md](lessons/test-file-provider-before-activation.md) — 파일 제공자를 처음 여는 호출로 활성화를 시험한다
- [lessons/test-never-called-through-the-calling-path.md](lessons/test-never-called-through-the-calling-path.md) — "부르지 않는다"는 그것을 부를 길을 지나게 해서 시험한다
- [lessons/test-persisted-reads-with-stale-cache.md](lessons/test-persisted-reads-with-stale-cache.md) — 영속 스냅숏을 읽는 테스트는 탭 캐시와 영속 값을 다르게 둔다
- [lessons/test-platform-keybindings.md](lessons/test-platform-keybindings.md) — 단축키의 플랫폼별 해석을 테스트한다
- [lessons/test-stale-successful-validation.md](lessons/test-stale-successful-validation.md) — 오래된 비동기 응답의 수락 테스트에는 성공 응답을 사용한다
- [lessons/webview-browser-address-space.md](lessons/webview-browser-address-space.md) — 웹뷰 브라우저 검사에서 실제 앱 주소 응답을 사용한다
- [lessons/webview-parent-origin-authority.md](lessons/webview-parent-origin-authority.md) — iframe의 오리진과 부모 권한은 제어하는 쪽에서 확인한다

## 이 문서에 없는 것

- VS Code의 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 v0.2.0에서도 다루지 않는다.

Decided in: wr-e8v6, wr-ggyb, wr-cla6, wr-510x, wr-jbmd
