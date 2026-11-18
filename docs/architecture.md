# 아키텍처 맵: VS Code와 writing-room의 대응

writing-room(v0.1.0)은 VS Code 워크벤치를 참고해 처음부터 직접 구현하는 웹 워크벤치다. 이 문서는 두 코드베이스 간 파일 단위 대응표이며, VS Code와 달라진 점을 기록하는 유일한 문서다. VS Code 측 근거는 [README.md](README.md)에 명시된 고정 커밋의 경로와 심볼을 기준으로 한다.

## 대응 규칙

- 경로: VS Code의 `src/vs/<path>`는 이 저장소의 `src/<path>`에 대응한다. 예를 들어 `src/vs/base/browser/ui/grid/grid.ts`는 `src/base/browser/ui/grid/grid.ts`에 해당한다.
- 이름: 클래스, 인터페이스, 레지스트리, id, 숫자는 VS Code를 따른다. 단, 파일이나 코드 블록을 그대로 복사하지 않는다.
- 계층 구조: `base`, `platform`, `editor`, `workbench` 순으로 구성되며 각 계층은 하위 계층만 임포트한다. `common` 디렉터리는 `browser` 디렉터리를 임포트하지 않는다. 확장 호스트 계층(`workbench/api/common`, `workbench/api/worker`)은 DOM에 접근하지 않는다.
- 범위: v0.1.0에서 구현하는 파트는 제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄 여섯 개다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 범위에서 제외한다.

## 개념별 대응표

각 행의 VS Code 경로는 고정 커밋에 실제로 존재하는 경로다. 오른쪽 경로는 v0.1.0에서 구현할 위치다. 자세한 설명은 마지막 열의 링크된 문서를 참조한다.

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

VS Code와 달라진 점은 영역별 하위 섹션에 한 줄 목록으로 기록한다. 작성 형식은 `- <무엇이 다른가> — <왜> (<이슈 id>)`를 따른다. 리뷰어는 이 목록을 바탕으로 재현 충실도를 검토한다. 아직 항목이 비어 있는 섹션은 차이가 없다는 뜻이 아니라, 아직 해당 기능이 구현되지 않았음을 의미한다.

### Base and grid

### Commands, menus and keys

### Layout and parts

### Editor groups, editor and docking

### Storage and settings

#### Storage

- `getNumber`는 `Number(value)`로 문자열을 숫자로 변환한다. VS Code는 `parseInt(value, 10)`을 쓴다 — `store`로 쓴 소수와 지수 표기 숫자를 같은 값으로 읽기 위해서다 (wr-cla6.68r). [VS Code의 `getNumber`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/storage/common/storage.ts#L115-L125)
- 유휴 저장은 마지막 유휴 저장 후 최소 60초 간격으로 실행되고, 문서가 숨겨지거나 `pagehide`가 발생하면 동기 저장한다. VS Code 웹은 5초 주기로 포커스가 있고 대기 중인 쓰기가 없을 때 유휴 저장한다 — 동기 백엔드가 페이지를 떠날 때 상태를 반영할 수 있어 주기 저장의 빈도를 낮췄다 (wr-cla6.68r). [VS Code 웹의 저장 주기와 조건](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/storage/browser/storageService.ts)
- `Memento`의 상태 객체는 인스턴스와 스코프별로 유지된다. VS Code는 같은 ID와 스코프의 객체를 정적 맵에서 공유한다 — 여기서는 상태 객체의 수명을 컴포넌트 인스턴스에 맞춘다. 같은 저장 키를 가진 여러 인스턴스가 각각 수정하면 마지막으로 저장한 값이 남는다 (wr-cla6.68r). [VS Code의 `Memento`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/common/memento.ts#L11-L60)

### Extensions

Decided in: wr-e8v6
