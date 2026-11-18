# 아키텍처 맵: VS Code와 writing-room의 대응

writing-room(v0.1.0)은 VS Code 워크벤치를 참고해 처음부터 직접 작성하는 웹 워크벤치다. 이 페이지는 두 코드베이스의 파일 단위 대응표이고, 코드 멤버가 VS Code와 달라진 곳을 적는 단 한 곳이다. VS Code 쪽 근거는 [README.md](README.md)에 적힌 고정 커밋의 경로와 심볼이다.

## 대응 규칙

- 경로: VS Code의 `src/vs/<path>`는 이 저장소의 `src/<path>`에 대응한다. 예를 들어 `src/vs/base/browser/ui/grid/grid.ts`는 `src/base/browser/ui/grid/grid.ts`다.
- 이름: 클래스, 인터페이스, 레지스트리, id, 숫자는 VS Code를 따른다. 파일이나 블록을 그대로 복사하지 않는다.
- 레이어링: `base`, `platform`, `editor`, `workbench` 순이며 각 층은 자기보다 아래만 임포트한다. `common` 폴더는 `browser` 폴더를 임포트하지 않는다. 확장 호스트 쪽(`workbench/api/common`, `workbench/api/worker`)은 DOM에 접근하지 않는다.
- 범위: v0.1.0이 따르는 파트는 제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄 여섯 개다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 범위 밖이다.

## 개념별 대응표

각 행의 VS Code 경로는 고정 커밋에 존재한다. 오른쪽 경로는 v0.1.0에서 코드 멤버가 만들 위치다. 상세 설명은 마지막 열의 페이지를 본다.

| 개념 | VS Code 경로 | 이 저장소 경로 | 설명 |
| --- | --- | --- | --- |
| 파트 id와 레이아웃 서비스 | `src/vs/workbench/services/layout/browser/layoutService.ts` | `src/workbench/services/layout/browser/layoutService.ts` | [레이아웃](vscode-workbench-layout.md) |
| 워크벤치 조립 | `src/vs/workbench/browser/workbench.ts` | `src/workbench/browser/workbench.ts` | [레이아웃](vscode-workbench-layout.md) |
| 레이아웃 계산과 파트 표시 | `src/vs/workbench/browser/layout.ts` | `src/workbench/browser/layout.ts` | [레이아웃](vscode-workbench-layout.md) |
| 파트 기반 클래스 | `src/vs/workbench/browser/part.ts` | `src/workbench/browser/part.ts` | [레이아웃](vscode-workbench-layout.md) |
| 그리드 | `src/vs/base/browser/ui/grid/grid.ts`, `gridview.ts` | `src/base/browser/ui/grid/grid.ts`, `gridview.ts` | [레이아웃](vscode-workbench-layout.md) |
| 스플릿뷰와 새시 | `src/vs/base/browser/ui/splitview/splitview.ts`, `src/vs/base/browser/ui/sash/sash.ts` | `src/base/browser/ui/splitview/splitview.ts`, `src/base/browser/ui/sash/sash.ts` | [레이아웃](vscode-workbench-layout.md) |
| 뷰 컨테이너 위치 | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` | `src/workbench/services/views/browser/viewDescriptorService.ts` | [레이아웃](vscode-workbench-layout.md) |
| 에디터 파트 | `src/vs/workbench/browser/parts/editor/editorPart.ts` | `src/workbench/browser/parts/editor/editorPart.ts` | [에디터 그룹](vscode-editor-groups.md) |
| 에디터 그룹과 모델 | `src/vs/workbench/browser/parts/editor/editorGroupView.ts`, `src/vs/workbench/common/editor/editorGroupModel.ts` | `src/workbench/browser/parts/editor/editorGroupView.ts`, `src/workbench/common/editor/editorGroupModel.ts` | [에디터 그룹](vscode-editor-groups.md) |
| 탭 | `src/vs/workbench/browser/parts/editor/multiEditorTabsControl.ts` | `src/workbench/browser/parts/editor/multiEditorTabsControl.ts` | [에디터 그룹](vscode-editor-groups.md) |
| 에디터 드롭 대상 | `src/vs/workbench/browser/parts/editor/editorDropTarget.ts` | `src/workbench/browser/parts/editor/editorDropTarget.ts` | [에디터 그룹](vscode-editor-groups.md) |
| 커맨드 레지스트리 | `src/vs/platform/commands/common/commands.ts` | `src/platform/commands/common/commands.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 메뉴 레지스트리 | `src/vs/platform/actions/common/actions.ts` | `src/platform/actions/common/actions.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 컨텍스트 키 | `src/vs/platform/contextkey/common/contextkey.ts` | `src/platform/contextkey/common/contextkey.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 키바인딩 | `src/vs/platform/keybinding/common/keybindingsRegistry.ts` | `src/platform/keybinding/common/keybindingsRegistry.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 메뉴 바 | `src/vs/workbench/browser/parts/titlebar/menubarControl.ts` | `src/workbench/browser/parts/titlebar/menubarControl.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 퀵 입력(커맨드 팔레트) | `src/vs/platform/quickinput/common/quickInput.ts` | `src/platform/quickinput/common/quickInput.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| 확장 매니페스트 | `src/vs/platform/extensions/common/extensions.ts` | `src/platform/extensions/common/extensions.ts` | [확장](vscode-extensions.md) |
| 기여 지점 레지스트리 | `src/vs/workbench/services/extensions/common/extensionsRegistry.ts` | `src/workbench/services/extensions/common/extensionsRegistry.ts` | [확장](vscode-extensions.md) |
| 확장 호스트(Worker) | `src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts` | `src/workbench/services/extensions/browser/webWorkerExtensionHost.ts` | [확장](vscode-extensions.md) |
| RPC 프로토콜 | `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | `src/workbench/services/extensions/common/rpcProtocol.ts` | [확장](vscode-extensions.md) |
| 웹 확장 설치 | `src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts` | `src/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts` | [확장](vscode-extensions.md) |
| 웹 진입점 | `src/vs/code/browser/workbench/workbench.ts`, `src/vs/workbench/browser/web.main.ts` | `src/code/browser/workbench/workbench.ts`, `src/workbench/browser/web.main.ts` | [웹 빌드](vscode-web-build.md) |
| 스토리지 서비스 | `src/vs/platform/storage/common/storage.ts` | `src/platform/storage/common/storage.ts` | [상태와 설정](vscode-state-settings.md) |
| 브라우저 스토리지 백엔드 | `src/vs/workbench/services/storage/browser/storageService.ts` | `src/workbench/services/storage/browser/storageService.ts` | [상태와 설정](vscode-state-settings.md) |
| 설정 서비스 | `src/vs/platform/configuration/common/configuration.ts` | `src/platform/configuration/common/configuration.ts` | [상태와 설정](vscode-state-settings.md) |

## Deviations from VS Code

코드 멤버는 VS Code와 달라진 점을 영역별 제목 아래에 한 줄 목록으로 추가한다. 형식은 `- <무엇이 다른가> — <왜> (<이슈 id>)`로 한다. 리뷰어는 이 목록을 기준으로 충실도를 본다. 아직 항목이 없는 제목은 차이가 없다는 뜻이 아니라 아직 구현되지 않았다는 뜻이다.

### Base and grid

### Commands, menus and keys

### Layout and parts

### Editor groups, editor and docking

### Storage and settings

### Extensions

Decided in: wr-e8v6
