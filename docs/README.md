# writing-room 문서

writing-room은 브라우저에서 VS Code처럼 동작하는 웹 워크벤치다. 액티비티 바, 사이드바, 탭 에디터, 패널, 상태 표시줄, 메뉴 바, 커맨드 팔레트, 확장 시스템, 드래그 도킹을 TypeScript와 Vite로 직접 구현한다(프레임워크 없음). 워크벤치를 실행하려면 시작하기를 읽는다. 조사 페이지는 코드 작성자와 리뷰어가 VS Code의 구현과 대조할 때 참고한다.

## 기준 VS Code 커밋

- 저장소: `https://github.com/microsoft/vscode`
- 커밋: `41004e061e582855eb1e99b6a6e5d52994f661be` (`main`, 2026-11-18, 패키지 버전 1.148.0)
- 모든 페이지의 VS Code 경로와 심볼은 이 커밋을 기준으로 확인했다. 다른 커밋에서 확인한 내용은 유효하지 않다. `main` 브랜치는 계속 갱신되므로 최신 `main`과 차이가 날 수 있다.
- 경로는 VS Code의 원본 경로(`src/vs/...`) 그대로 적는다. 줄 번호는 변경될 수 있으므로 표기하지 않는다. 핵심은 심볼 이름이다.
- VS Code는 참고용이다. 각 페이지는 개념을 설명하고 일부를 짧게 인용할 뿐 소스 전체를 재현하지 않는다.

## 페이지

| 페이지 | 다루는 것 |
| --- | --- |
| [getting-started.md](getting-started.md) | 설치, 조작, 설정, 확장 설치와 테스트 실행 |
| [extension-api.md](extension-api.md) | Writing Room 확장 작성과 실행, 지원되는 매니페스트와 API |
| [maintainability.md](maintainability.md) | 유지보수와 확장 가이드: 레이어 규칙, DI, 레지스트리와 기여, 에디터·확장 확장법, 저장, 테스트, 기술 부채 |
| [editor-services.md](editor-services.md) | 모델, 에디터 해석기, 파일 저장과 닫기, 테마 및 컨텍스트 키 이음매 |
| [architecture.md](architecture.md) | VS Code 경로와 이 저장소 경로의 대응표, VS Code와 달라진 점 목록 |
| [vscode-workbench-layout.md](vscode-workbench-layout.md) | 파트, 워크벤치 조립, 그리드·스플릿뷰·새시, 뷰 컨테이너 위치, 크기 제약 |
| [vscode-editor-groups.md](vscode-editor-groups.md) | 에디터 그룹과 탭, 에디터 입력과 페인, Monaco, 드래그 앤 드롭 |
| [vscode-menus-commands.md](vscode-menus-commands.md) | 커맨드, 메뉴, 컨텍스트 키, 메뉴 바, 키바인딩, 커맨드 팔레트 |
| [vscode-extensions.md](vscode-extensions.md) | 매니페스트와 기여 지점, 활성화, 웹 워커 확장 호스트, 양면 API, 브라우저에서의 설치 |
| [vscode-web-build.md](vscode-web-build.md) | 브라우저가 처음 로드하는 것, 서빙과 빌드, 내장 확장, Vite 빌드와의 관계 |
| [vscode-state-settings.md](vscode-state-settings.md) | 스토리지 서비스, 누가 무엇을 언제 저장하는가, 설정 |

## 이 문서에 없는 것

- VS Code의 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 v0.1.0에서 다루지 않는다.

Decided in: wr-e8v6, wr-ggyb, wr-cla6, wr-510x
