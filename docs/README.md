# writing-room 문서

writing-room은 브라우저에서 VS Code처럼 동작하는 웹 워크벤치다. 액티비티 바, 사이드바, 탭 에디터, 패널, 상태 표시줄, 메뉴 바, 커맨드 팔레트, 확장 시스템, 드래그 도킹을 TypeScript와 Vite로 직접 만든다(프레임워크 없음). 이 문서는 VS Code가 그것을 어떻게 구현하는지 조사한 결과이며, 코드 작성자와 리뷰어가 이 워크벤치를 VS Code와 대조하는 용도다.

## 기준 VS Code 커밋

- 저장소: `https://github.com/microsoft/vscode`
- 커밋: `41004e061e582855eb1e99b6a6e5d52994f661be` (`main`, 2026-11-18, 패키지 버전 1.148.0)
- 모든 페이지의 VS Code 경로와 심볼은 이 커밋에서 확인했다. 다른 커밋에서 확인한 주장은 확인한 것이 아니다. `main`은 매일 움직이므로 최신 `main`과 다를 수 있다.
- 경로는 VS Code가 가진 그대로(`src/vs/...`) 적는다. 줄 번호는 어긋나므로 쓰지 않는다. 찾아야 할 것은 심볼 이름이다.
- VS Code는 참고용이다. 페이지는 설명하고 짧게 인용하지만 소스를 재현하지 않는다.

## 페이지

| 페이지 | 다루는 것 |
| --- | --- |
| [architecture.md](architecture.md) | VS Code 경로와 이 저장소 경로의 대응표, VS Code와 달라진 점 목록 |
| [vscode-workbench-layout.md](vscode-workbench-layout.md) | 파트, 워크벤치 조립, 그리드·스플릿뷰·새시, 뷰 컨테이너 위치, 크기 제약 |
| [vscode-editor-groups.md](vscode-editor-groups.md) | 에디터 그룹과 탭, 에디터 입력과 페인, Monaco, 드래그 앤 드롭 |
| [vscode-menus-commands.md](vscode-menus-commands.md) | 커맨드, 메뉴, 컨텍스트 키, 메뉴 바, 키바인딩, 커맨드 팔레트 |
| [vscode-extensions.md](vscode-extensions.md) | 매니페스트와 기여 지점, 활성화, 웹 워커 확장 호스트, 양면 API, 브라우저에서의 설치 |
| [vscode-web-build.md](vscode-web-build.md) | 브라우저가 처음 로드하는 것, 서빙과 빌드, 내장 확장, Vite 빌드와의 관계 |
| [vscode-state-settings.md](vscode-state-settings.md) | 스토리지 서비스, 누가 무엇을 언제 저장하는가, 설정 |

## 이 문서에 없는 것

- 이 워크벤치의 실행 방법 가이드와 확장 작성 가이드는 다른 멤버가 쓴다(확장 API는 `extension-api.md`).
- VS Code의 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 v0.1.0이 따르지 않으므로 다루지 않는다.

Decided in: wr-e8v6
