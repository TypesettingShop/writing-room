# 아키텍처 맵: VS Code와 writing-room의 대응

writing-room(v0.2.0)은 VS Code 워크벤치를 참고해 처음부터 직접 구현하는 웹 워크벤치다. 이 문서는 두 코드베이스 간 파일 단위 대응표이며, VS Code와 달라진 점을 기록하는 유일한 문서다. VS Code 측 참조 근거는 [README.md](README.md)에 명시된 고정 커밋의 경로와 심볼을 기준으로 삼는다.

## 대응 규칙

- 경로: VS Code의 `src/vs/<path>`는 이 저장소의 `src/<path>`에 대응한다. 예를 들어 `src/vs/base/browser/ui/grid/grid.ts`는 `src/base/browser/ui/grid/grid.ts`에 해당한다.
- 이름: 클래스, 인터페이스, 레지스트리, id, 숫자는 VS Code를 따른다. 단, 파일이나 코드 블록을 그대로 복사하지 않는다. 승인된 예외는 적합성 검사의 참조 픽스처 `test/fixtures/vscode-api/vscode.d.ts` 하나다([maintainability.md](maintainability.md#9-vs-code와의-차이를-기록하는-규칙)).
- 계층 구조: `base`, `platform`, `editor`, `workbench` 순으로 구성되며 각 계층은 하위 계층만 임포트한다. `common` 디렉터리는 `browser` 디렉터리를 임포트하지 않는다. 확장 호스트 계층(`workbench/api/common`, `workbench/api/worker`)은 DOM에 접근하지 않는다.
- 범위: v0.2.0에서 구현하는 파트는 제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄 여섯 개다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 범위에서 제외한다.

## 개념별 대응표

각 행의 VS Code 경로는 고정 커밋에 실제로 존재하는 경로다. 오른쪽 경로는 이 저장소에서 구현한 위치다. 자세한 설명은 마지막 열의 링크된 문서를 참조한다.

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
| Markdown 에디터 | `extensions/markdown-language-features/package.json`의 `vscode.markdown.editor` | `src/workbench/contrib/markdownEditor/browser/markdownEditorPane.ts` | [기본 에디터와 미리보기](#markdown-editor) |
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
| 웹 진입점 | `src/vs/code/browser/workbench/workbench.ts`, `src/vs/workbench/browser/web.main.ts` | `src/code/browser/workbench/workbench.ts`, `src/workbench/browser/web.factory.ts`, `src/workbench/workbench.web.main.ts` | [웹 빌드](vscode-web-build.md) |
| 스토리지 서비스 | `src/vs/platform/storage/common/storage.ts` | `src/platform/storage/common/storage.ts` | [상태와 설정](vscode-state-settings.md) |
| 브라우저 스토리지 백엔드 | `src/vs/workbench/services/storage/browser/storageService.ts` | `src/workbench/services/storage/browser/storageService.ts` | [상태와 설정](vscode-state-settings.md) |
| 설정 서비스 | `src/vs/platform/configuration/common/configuration.ts` | `src/platform/configuration/common/configuration.ts`, `src/workbench/services/configuration/browser/configurationService.ts` | [상태와 설정](vscode-state-settings.md) |

## Deviations from VS Code

VS Code와 달라진 점은 영역별 하위 섹션에 한 줄 목록으로 기록한다. 작성 형식은 `- <무엇이 다른가> — <왜> (<이슈 id>)`를 따른다. 리뷰어는 이 목록을 바탕으로 재현 충실도를 검토한다. 아직 항목이 비어 있는 섹션은 차이가 없다는 뜻이 아니라, 아직 해당 기능이 구현되지 않았음을 의미한다.

### Base and grid

- `SplitView.removeView`는 제거된 뷰의 공간을 바로 앞 뷰(첫 뷰였다면 뒤 뷰)에 먼저 준다. VS Code는 `relayout()`으로 뒤쪽 뷰부터 채운다 — 닫힌 뷰 옆의 뷰가 넓어지는 편이 예측하기 쉽다 (wr-cla6.aym)
- `SplitView`에 첫 `layout` 전에 추가한 뷰는 요청한 크기를 비율로 지키고, `distributeViewSizes`는 배치된 뒤에는 컨테이너에서 고정 뷰를 뺀 공간을 나눈다. VS Code는 첫 `layout` 전에도 `relayout()`으로 크기를 맞춘다 — 분할 뷰 하나에 미리 쌓은 크기를 잃지 않게 한다. `Grid` 수준에서는 이 보장이 없다: 첫 `layout` 전에는 모든 노드의 크기가 0이라 `addView`의 `Split`이나 숫자 크기가 0을 기준으로 계산된다. 그래서 `Grid`에는 먼저 `layout`을 부른 뒤 뷰를 더하고, 저장된 크기로 시작할 때는 `SerializableGrid.deserialize`를 쓴다 (wr-cla6.aym)
- 숨겨진 뷰 바로 앞의 sash는 비활성화한다. 같은 경계에 sash 두 개가 겹치지 않게 한다. 스냅, alt 드래그, 더블 클릭 초기화, 모서리 sash는 v0.1.0 범위 밖이라 없다 (wr-cla6.aym)
- `GridBranchNode`도 `cachedVisibleSize`를 가지며, 뷰가 전부 숨겨진 브랜치는 그 크기로 직렬화된다. VS Code는 리프에만 둔다 — 숨긴 파트 묶음이 새로고침 뒤에도 크기를 되찾는다 (wr-cla6.aym)
- `GridView.deserialize`는 아무것도 만들기 전에 노드 타입, 유한한 0 이상 크기, 비어 있지 않은 브랜치, 루트 아래 브랜치의 자식 둘 이상, 리프 하나 이상, `fromJSON` 결과, 같은 뷰의 중복을 검사하고 `Invalid serialized grid: <경로> …` 오류 하나를 던진다. 실패하면 이미 만든 뷰를 dispose한다 — 저장된 데이터는 입력이므로 호출자가 기본 레이아웃으로 돌아갈 수 있어야 한다 (wr-cla6.aym)
- `Grid.moveView`와 `moveViewTo`는 이동 전에 뷰 안에 있던 포커스를 이동 뒤에 되돌린다. VS Code의 `Grid.moveView`는 포커스를 따로 다루지 않는다 — 이동한 에디터가 입력을 계속 받아야 한다 (wr-cla6.aym)
- `GridView`는 노드를 떼었다 붙이는 변경(분할, 축소, 방향 전환)을 batch로 묶어 그동안 한계와 가시성 변경 이벤트를 막고, 끝에서 브랜치 가시성을 맞춘 뒤 한 번 다시 배치한다. VS Code의 `LayoutController`와 목적은 같고 형태가 다르다 — 잠깐 비거나 전부 숨겨진 브랜치가 부모에서 숨었다 나타나며 형제 크기를 바꾸지 않게 한다 (wr-cla6.aym)
- `Grid.moveViewTo`의 위치는 같은 부모 안에서도 뷰가 빠진 뒤의 인덱스로 읽는다. VS Code는 같은 부모면 `moveView`의 "이 자식 앞" 인덱스로 읽는다 — 다른 부모로 옮길 때와 같은 뜻을 갖게 한다. 대상 위치는 뷰가 빠진 뒤의 모양에 대어 먼저 검사해, 잘못되면 아무것도 옮기기 전에 오류를 던진다 (wr-cla6.aym)
- `Grid.getNeighborViews`는 DOM이 아니라 그리드 노드의 box로 이웃을 찾고 숨겨진 뷰를 뺀다 — 레이아웃이 명시적이라 box가 곧 화면 위치다 (wr-cla6.aym)
- `GridView.layout`은 음수나 `NaN` 크기를 0으로 받는다 (wr-cla6.aym)

### Commands, menus and keys

- `MenuRegistry`는 VS Code와 같이 같은 마이크로태스크에 들어온 변경을 메뉴 id 집합으로 묶는다. VS Code의 `MenuImpl` 기본 지연은 50ms이며 여기서는 관련 레지스트리 알림을 받거나 참조한 컨텍스트 키가 바뀌면 바로 알린다 — 한 번의 등록 묶음을 합치면서 이미 열린 메뉴에는 컨텍스트 변경을 즉시 반영한다 (wr-cla6.jvs). [VS Code의 `MenuRegistry`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/common/actions.ts#L525-L529), [VS Code의 `MenuService.createMenu`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/common/menuService.ts#L35-L37)
- 최상위 메뉴 후보는 코어가 등록하는 File, Edit, View, Help 네 가지이며 표시할 항목이 있는 메뉴만 나타난다. VS Code는 Selection, Go, Terminal 등도 등록한다 — 여기서는 v0.1.0의 셸과 커맨드 범위에 맞춰 메뉴 후보를 줄였다 (wr-cla6.jvs). [VS Code의 메뉴 바 기여](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts)
- 키바인딩은 US 배열 기준 `KeyboardEvent.code`의 물리 위치를 해석하고 OS에 맞는 수정자 레이블을 표기한다. 다른 배열에서는 키가 입력하는 문자와 메뉴·팔레트 레이블이 다를 수 있다. VS Code는 배열을 감지하는 키보드 매퍼와 사용자 `keybindings.json`을 적용한다 — v0.1.0에서는 기본 및 기여 단축키에 공통 물리 키 규칙을 사용한다 (wr-cla6.em5). [VS Code의 `WorkbenchKeybindingService`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/keybinding/browser/keybindingService.ts)
- F1 또는 **View → Command Palette...**로 팔레트를 연다. Firefox를 제외하면 Ctrl+Shift+P(macOS에서는 Cmd+Shift+P)도 쓸 수 있다. VS Code는 `>`를 넣어 커맨드 제공자를 선택한다 — 팔레트는 여전히 `>` 없이 커맨드 모드만 있는 화면으로 따로 열려 빈 입력으로 시작한다. 다만 퀵 액세스에 `#` 접두어의 워크스페이스 기호 검색(Go to Symbol in Workspace, 커맨드 `workbench.action.showAllSymbols`, Ctrl+T 또는 macOS Cmd+T)이 생겼다. 그 화면은 `#`가 든 채 열리며 커맨드 팔레트에 `#`를 입력해서는 열리지 않는다 (wr-cla6.nzs, wr-c9d8.qq0). [VS Code의 `ShowAllCommandsAction`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts#L273-L294)
- 팔레트를 열기 직전 포커스의 스코프에서 `MenuId.CommandPalette` 항목의 `when`과 활성 조건을 평가한다. 다시 열 때는 열려 있던 퀵 인풋의 복귀 포커스 스코프를 쓴다. 이름은 `Category: Title`로 표시하고, 일치한 글자와 단축키를 보여 준다. 검색은 대소문자를 구분하지 않는 연속 부분 문자열로 모든 입력 단어를 검사하며 일반 행은 이름순으로 정렬한다. VS Code의 제공자는 별도로 에디터 액션을 합치고 관련도 기반의 추가 검색을 지원한다 — v0.1.0은 등록된 메뉴 항목과 입력한 단어의 일치만으로 검색 결과를 예측할 수 있게 했다 (wr-cla6.nzs). [VS Code의 메뉴 항목 수집](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts), [VS Code의 검색 제공자](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/quickinput/browser/commandsQuickAccess.ts)
- 위·아래 화살표로 결과를 순환하고 Enter나 클릭으로 선택한다. Esc, 위젯 바깥 클릭, 외부 요소로의 포커스 이동으로 취소할 수 있다. 포커스를 받을 수 있는 바깥 요소를 선택하면 그 요소에 포커스가 남고, Tab은 위젯 안에 포커스를 둔다. 선택하면 팔레트가 닫히고 기존 포커스가 복원된 뒤 커맨드를 실행한다. 실행 오류는 로그에 남긴다. VS Code는 실행 오류를 대화 상자로 표시한다 — 여기서는 실행에 실패해도 사용자가 입력을 계속할 수 있게 알림을 로그로 남긴다 (wr-cla6.nzs). [VS Code의 `CommandsHistory`와 실행 처리](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/quickinput/browser/commandsQuickAccess.ts)
- 최근에 선택한 최대 50개는 새로고침 뒤 **Recently Used**에서 최신순으로 표시된다. `commandPalette.mru.cache`에는 프로필 스토리지의 단일 id 배열을 쓰며, 미등록 커맨드는 표시 단계에서 걸러 낸다. id는 한도에서 밀려나기 전까지 저장되어 확장이 뒤늦게 등록하면 다시 나타난다. VS Code는 설정 가능한 LRU와 별도 순번을 저장한다 — 고정 한도와 최신순 배열이면 순번 키 없이 기록을 복원할 수 있다 (wr-cla6.nzs). [VS Code의 `CommandsHistory`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/quickinput/browser/commandsQuickAccess.ts)

### Layout and parts

- VS Code는 기본 패널을 숨긴다. 여기서는 하단 패널을 첫 실행부터 표시하고 타이틀 바와 에디터의 가시성을 고정한다 — 첫 화면에서 여섯 파트의 배치와 Output·Problems 전환을 바로 확인할 수 있게 했다 (wr-cla6.tlp)
- `LayoutStateModel`은 사이드바 너비, 패널 높이, 가시성과 활성 컨테이너를 메모리에 둔다. `startup`에서 초기 크기를 창과 파트의 한계에 맞추고, 레이아웃 이후 컨테이너 크기가 0이 되면 기존 크기를 유지한다. 창이 파트 최소 크기의 합보다 작을 때는 그리드의 끝을 자른다 — 셸에서 초기 상태 입력과 크기 제약을 검증하고, 이후 저장 기능이 이 상태를 이어받도록 했다 (wr-cla6.tlp)
- 기여는 첫 레이아웃 뒤 시작하며 이후 등록도 반영한다. 레지스트리 변경에 맞춰 보이는 뷰가 있는 컨테이너를 표시하고, 기억한 컨테이너가 다시 제공되면 복원한다. 각 뷰의 헤더를 항상 표시하고 활성 컨테이너의 본문에 남는 높이를 균등하게 나눈다 — 늦게 로드되는 기여의 선택을 보존하고 보이는 본문만 생성하면서 뷰 제목 메뉴를 항상 열 수 있게 했다 (wr-cla6.tlp)
- 타이틀 바는 앱 이름과 커스텀 메뉴 바를 호스팅하고, 한 가지 어두운 팔레트를 `--vscode-*` CSS 변수로 노출한다. 상태 표시줄의 양쪽 그룹에서 높은 우선순위부터 왼쪽에 배치한다 — 한 팔레트로 파트 색상을 제어하고 같은 우선순위 규칙으로 양쪽 항목 순서를 예측할 수 있게 했다 (wr-cla6.tlp)

#### 워크벤치 레이아웃 조작

- **View → Appearance**에서 **Activity Bar**, **Primary Side Bar**, **Panel**, **Status Bar**를 표시하거나 숨긴다. Windows와 Linux에서는 Ctrl+B와 Ctrl+J, macOS에서는 Cmd+B와 Cmd+J로 사이드바와 패널을 전환한다. 키보드 포커스가 숨기는 파트 안에 있으면 에디터 영역으로 옮긴다.
- 사이드바 오른쪽과 패널 위쪽의 경계를 드래그해 크기를 조절한다. 같은 창에서 파트를 다시 표시하면 사용 가능한 공간 안에서 이전 크기로 돌아온다.
- 액티비티 바의 **Explorer**를 눌러 사이드바를 열거나 닫고, 패널의 **Output**과 **Problems** 탭으로 표시할 뷰를 바꾼다.

#### View containers

이 절은 wr-51z5에서 정했다.

- 하단 패널에서도 사이드바와 같이 컨테이너의 뷰를 세로로 쌓는다. VS Code는 하단 패널에서 뷰를 가로로 나란히 배치한다 — 컨테이너를 이동할 때 두 파트에서 같은 뷰 배치와 스크롤 동작을 유지한다 (wr-cla6.3d4)
- `workbench.activity.pinnedViewlets2`와 `workbench.panel.pinnedPanels`에 컨테이너 ID 문자열 배열을 저장한다. VS Code는 항목별 객체 배열을 저장한다 — 이 릴리스는 바 순서만 저장하며, 현재 등록되지 않은 ID도 확장이 돌아올 때 자리를 복원할 수 있도록 배열에 남긴다 (wr-cla6.3d4)

액티비티 바 아이콘, 사이드바 제목, 패널 탭을 끌어 컨테이너 전체를 이동한다. 바에서는 삽입 표시가 앞뒤 순서를 가리키고 다른 파트의 본문에 놓으면 맨 끝에 추가된다. 항목에서 우클릭하거나 Shift+F10을 눌러 **Move to Panel** 또는 **Move to Side Bar**를 선택할 수 있다. 목적지가 숨겨져 있을 때도 이 메뉴로 열 수 있다. 기본 위치와 순서로 돌아가려면 F1을 눌러 **Reset View Locations**를 실행한다.

### Editor groups, editor and docking

#### Markdown editor

- `.md`와 `.markdown`의 기본 에디터는 ProseMirror 기반 코어 페인(WYSIWYG)이며, 화면 이름은 **Manuscript Editor**(원고 편집기)다. VS Code의 기본 Markdown 편집기는 텍스트 에디터이며, 기준 커밋의 내장 확장은 **Markdown Editor**(`vscode.markdown.editor`)와 **Markdown Preview**(`vscode.markdown.preview.editor`)를 텍스트 에디터 자리의 선택형(`option`) 커스텀 에디터로 등록한다 — 원문 모드는 같은 `TextFileEditorModel`을 Monaco로 보여 주므로 두 모드가 저장·dirty·초안을 공유하고, 확장이 제공하는 **Markdown Preview**도 **Reopen Editor With...** 목록에서 고를 수 있다 (wr-ndsy, wr-h2sa, wr-cbej). [마크다운 편집 모드와 저장 형식](markdown-editor.md#편집-모드와-실행-취소)

#### Monaco editor

- 에디터는 VS Code처럼 `src/vs/editor`를 내장하지 않고 같은 코드를 독립 실행형으로 묶은 `monaco-editor` 패키지를 쓴다. 패키지를 임포트하는 파일은 `src/editor/browser/monaco.ts` 하나이며 `loadMonaco()`가 처음 열리는 텍스트 에디터에서 지연 로드한다 — 워크벤치의 첫 페인트가 수 MB의 패키지와 워커를 기다리지 않게 한다 (wr-cla6.36n)
- `IModelService.createModel`은 비동기다. VS Code는 동기다 — 패키지를 처음 쓸 때 로드하므로 모델을 만들기 전에 기다려야 한다 (wr-cla6.36n)
- 에디터 페인 레지스트리는 입력의 `typeId`로 페인을 찾는다(`registerEditorPane(descriptor, editorTypeIds)`). VS Code는 입력 생성자의 `SyncDescriptor`로 찾는다 — 입력 타입 id가 이미 계약이라 `instanceof`가 필요 없다 (wr-cla6.36n)
- 제목 없는 에디터의 이름은 언제나 `Untitled-N`이다. VS Code는 텍스트의 첫 줄에서 이름을 만든다 (wr-cla6.36n)
- `URI`는 퍼센트 인코딩 없이 구성 요소를 그대로 이어 쓴다 — 에디터 리소스는 워크벤치가 만드는 `untitled:Untitled-N`, `vscode-userdata:/User/settings.json`, 워크스페이스 파일 `vscode-vfs://writing-room/workspace/…`과 확장이 등록한 스킴의 파일이다. 그렇게 이어 쓰면 다른 URI로 읽히는 구성 요소(경로의 `?`·`#`, authority가 있을 때 `/`로 시작하지 않는 경로 등)는 거부한다 (wr-cla6.36n)
- `TextEditorPane`은 입력별 뷰 상태를 페인 안의 메모리 맵에 두고 입력이 dispose되면 지운다. VS Code의 `AbstractEditorWithViewState`는 그룹과 리소스 키로 memento에 저장한다 — 새로고침 뒤 복원은 레이아웃과 에디터 저장 멤버의 몫이다. 다른 페인으로 옮길 때는 `getViewState()`와 `setInput`의 `viewState` 옵션으로 넘긴다 (wr-cla6.36n)
- 페인은 새 입력을 로드하는 동안 이전 모델을 떼어(`setModel(null)`) 둔다. VS Code는 새 모델로 바로 바꾼다 — 패키지나 모델 로드가 늦을 때 이전 탭의 텍스트가 새 탭 아래 보이지 않게 한다. 떼기 전에 에디터에 포커스가 있었으면 새 모델이 붙을 때 되돌린다 (wr-cla6.36n)
- Monaco 자체의 F1 바인딩(`editor.action.quickCommand`)을 지운다 — F1은 워크벤치의 커맨드 팔레트로 간다. Monaco의 컨텍스트 메뉴, 찾기 위젯, 다른 키바인딩은 그대로 둔다 (wr-cla6.36n)
- `editorTextFocus`, `editorFocus`, `textInputFocus`는 페인 요소에 만든 범위 컨텍스트 키 서비스에서 Monaco의 포커스 이벤트를 따른다. VS Code는 `CodeEditorWidget`이 자기 범위 서비스에서 설정한다 (wr-cla6.36n)
- Monaco의 CSS도 `@vscode/codicons`와 같은 `codicon` 글꼴 패밀리를 선언하므로, Monaco가 로드된 뒤에는 나중에 온 Monaco의 글꼴이 워크벤치 아이콘에도 쓰인다. monaco-editor 0.57.0의 글꼴은 `@vscode/codicons` 0.0.46-24의 아이콘 746개를 모두 같은 코드 포인트로 담고 있어 지금은 보이는 차이가 없다. 두 패키지 중 하나를 올리면 다시 확인한다 (wr-cla6.36n)
- 메인 창은 워크벤치 수명 동안 `unhandledrejection`에서 실제 취소 오류의 기본 보고만 동기로 막고, 일반 거부는 브라우저에 남긴다. VS Code는 모든 거부를 로그 경로로 돌린다 (wr-mb1v)
- 워크벤치·확장의 키바인딩 규칙이 우선한다. 등록 편집기에서 해당 규칙이 둘째 키를 처리하지 않는 이어 키(chord)이면 `monaco.ts`가 독립 실행형 Monaco에 첫 키를 재생하고, 같은 호출에서 실제 둘째 키까지 판정한다. 워크벤치의 캡처 리스너가 이벤트 전파를 멈추므로 편집기 위젯은 이 키를 따로 처리하지 않고, Monaco가 받은 경우 기본 동작의 취소 여부는 Monaco의 응답을 따른다. 워크벤치는 `KeyboardEvent.code`의 US 물리 키를 쓰고 Monaco는 원래 둘째 키의 `keyCode`를 쓰므로 US 이외 배열에서 결과가 다를 수 있다 — 의도된 한계다 (wr-mb1v.g91)

#### Editor groups and tabs

- `EditorPart`가 `IEditorGroupsService`를 직접 구현한다. VS Code는 메인과 보조 창의 파트를 묶는 `EditorParts`가 서비스다 — v0.1.0에는 보조 창이 없다 (wr-cla6.vge)
- `EditorGroupModel`에는 미리보기, 고정(pinned), 스티키, 잠금, 다중 선택, 일시(transient) 에디터가 없다. 모든 에디터는 일반 탭이고 `serialize()`는 `id`, `editors`, `mru`만 쓴다. 활성 에디터는 `mru`의 첫 항목이다 — 릴리스 범위 밖이다 (wr-cla6.vge)
- 파트 옵션(`openPositioning`, `focusRecentEditorAfterClose`, `closeEmptyGroups`, `splitSizing`)은 `parts/editor/editor.ts`의 `getEditorPartOptions()`로 읽고, 설정 멤버는 `setEditorPartOptionsProvider`로 값을 공급한다. 모델은 이 함수를 생성자 인자로 받는다. VS Code는 모델과 파트가 `IConfigurationService`를 직접 읽는다 — 설정 서비스가 아직 없고, `common`의 모델은 `browser`의 함수를 임포트할 수 없다 (wr-cla6.vge)
- `IEditorFactoryRegistry.registerEditorSerializer(typeId, ctor)`의 직렬 변환기 생성자는 서비스를 받지 않는다. 인스턴스는 처음 찾을 때 만들고, 서비스는 `deserialize(instantiationService, …)`로 받는다. VS Code는 `start(accessor)`에서 서비스와 함께 만든다 — 레지스트리가 워크벤치 시작 시점에 묶이지 않게 한다. 이 멤버는 레지스트리만 만들고 직렬 변환기는 등록하지 않는다 (wr-cla6.vge)
- 그룹이 페인을 직접 보여 준다(타입별 페인 하나, 숨긴 컨테이너 전환). VS Code는 그 일을 `EditorPanes`(`editorPanes.ts`)에 둔다 — 페인 종류가 둘뿐이다 (wr-cla6.vge)
- 다른 그룹으로 옮기거나 복사·분할하는 에디터의 뷰 상태는 원본 그룹의 페인에서 `EditorPane.getViewState(input)`으로 읽어 대상의 `setInput` 옵션 `viewState`로 넘긴다. 배경 탭의 상태도 읽을 수 있게 `getViewState`에 선택적 `input` 인자를 더했다. VS Code는 그룹 간 이동 때 `EditorMemento`와 `viewState` 옵션을 쓴다 (wr-cla6.vge)
- 그룹 최소 크기는 페인과 무관하게 `DEFAULT_EDITOR_MIN_DIMENSIONS`(220 x 70)이다. VS Code는 활성 페인의 최소 크기를 쓴다 — 두 페인 모두 기본값을 쓴다 (wr-cla6.vge)
- 탭의 `role="tab"`은 탭 안의 레이블에 있고, 닫기 버튼(`Close <이름>`)은 그 옆 형제다. VS Code는 닫기 액션을 탭 요소 안에 둔다 — `tab`의 자식은 표현용(presentational)이라 탭 안의 버튼은 버튼으로 노출되지 않는다. dirty 탭은 `aria-description="Modified"`와 닫기 아이콘 자리의 점으로 표시한다. 탭 스트립은 브라우저 기본 가로 스크롤을 쓰고 VS Code의 커스텀 스크롤바는 없다 (wr-cla6.vge)
- 그룹 타이틀 툴바(`MenuId.EditorTitle`)의 액션은 인자 없이 실행되어 활성 그룹에 작용한다. 그룹은 `mousedown`(캡처)과 `focusin`에서 활성 그룹이 되므로 툴바 버튼을 누르면 그 그룹이 먼저 활성화된다. VS Code는 툴바의 액션 러너가 그룹 컨텍스트를 넘긴다. 탭 컨텍스트 메뉴(`MenuId.EditorTitleContext`)는 VS Code처럼 `{ groupId, editorIndex }`를 넘긴다 (wr-cla6.vge)
- 고친 파일과 텍스트가 있는 제목 없는 에디터는 닫기 전에 Save / Don't Save / Cancel을 퀵 픽으로 묻는다. VS Code는 모달 대화상자로 묻고, 여러 에디터를 한 번에 묻는다 — [files-and-explorer.md](files-and-explorer.md#닫기-전-확인) (wr-jrhv.r4v)
- Close Editor는 VS Code처럼 Ctrl+W(Windows는 Ctrl+F4와 Ctrl+W, macOS는 Cmd+W)로 선언하지만 일반 브라우저 탭에서 Ctrl+W는 브라우저가 가져가 페이지에 닿지 않는다 (wr-cla6.vge)
- `workbench.action.files.newUntitledFile`은 `parts/editor/editorActions.ts`에 둔다. VS Code는 `contrib/files/browser/fileActions.contribution.ts`에 둔다 — 이 커맨드는 에디터 쪽에 남아 있다. 저장과 새 파일 같은 나머지 파일 커맨드는 `contrib/files`에 있다([파일 커맨드와 키](files-and-explorer.md#파일-커맨드와-키)). 키는 VS Code 웹의 것(Ctrl+Alt+N, Windows는 Ctrl+K N)이다. Ctrl+N은 브라우저가 가져간다 (wr-cla6.vge)
- Welcome 페이지는 `parts/editor/welcomeEditor.ts`의 작은 페인과 입력(`workbench.editors.gettingStartedInput`)이며, 저장한 에디터 상태가 없을 때 워크벤치가 시작하면서 포커스를 옮기지 않고 연다. VS Code의 Getting Started는 `contrib/welcomeGettingStarted`에 있고 설정과 복원 상태에 따라 연다 (wr-cla6.vge, wr-cla6.kn7)
- **View → Editor Layout**에 Split Up/Down/Left/Right와 **Join All Editor Groups**를 둔다. VS Code의 Editor Layout 메뉴에는 레이아웃 프리셋도 있다 — 프리셋은 범위 밖이다 (wr-cla6.vge)

#### 에디터 그룹 조작

- **File → New Text File**(Ctrl+Alt+N, Windows는 Ctrl+K N, macOS는 Cmd+Option+N)이 활성 그룹에 `Untitled-N` 텍스트 에디터를 연다. 처음 열 때 Monaco를 받아 온다. 타이핑하면 탭에 점이 붙는다. 첫 화면의 그룹에는 Welcome 페이지가 열린다.
- 탭을 누르면 그 에디터로 바꾸고, 탭의 닫기 버튼이나 가운데 버튼으로 닫는다. 배경 탭을 닫아도 활성 탭은 그대로다. 탭에 포커스가 있으면 좌우 화살표, Home, End로 탭 사이를 옮긴다. 탭을 오른쪽 클릭하면 Close, Close Others, Close All과 네 방향 분할이 나온다.
- 각 그룹 타이틀의 **Split Editor Right** 버튼(Ctrl+\\, macOS는 Cmd+\\)이나 **View → Editor Layout**의 Split Up/Down/Left/Right가 같은 에디터를 옆 그룹에 연다. 두 그룹은 같은 텍스트를 편집한다. **Join All Editor Groups**는 모든 그룹을 활성 그룹으로 합친다. 마지막 탭을 닫은 그룹은 다른 그룹이 있으면 사라진다.
- 그룹 사이 경계를 끌어 크기를 바꾼다. 그룹은 220 x 70 px보다 작아지지 않는다. 팔레트(F1)의 `View:` 커맨드로 다음 그룹 포커스, 다음 그룹으로 에디터 이동, 모든 에디터 닫기도 할 수 있다.
- 탭을 끌어 같은 그룹 안에서 순서를 바꾸거나 다른 그룹의 탭 줄로 옮긴다. 그룹 본문의 가운데에 놓으면 그 그룹으로 옮기고, 가장자리에 놓으면 그쪽으로 그룹을 나눈다. 끄는 동안 반투명 영역이 놓일 자리를, 탭 줄의 세로선이 들어갈 자리를 보여 준다. 탭 줄의 빈 곳을 끌면 그룹 전체를 다른 그룹 옆으로 옮기거나 다른 그룹에 합친다. Esc를 누르면 아무것도 바뀌지 않는다.

#### Editor docking

- 드래그 페이로드와 세션은 `browser/dnd.ts`의 `EditorDragAndDropObserver`가 맡는다. 시작할 때 `LocalSelectionTransfer`에 `DraggedEditorIdentifier`나 `DraggedEditorGroupIdentifier`를 넣고, 드롭·소스의 `dragend`·Escape·`pagehide` 중 먼저 오는 것에서 페이로드와 오버레이, 삽입 표시를 함께 지운다. 플랫폼과 관계없이 창 `blur`를 받아도 세션을 유지한다. Wayland에서는 드래그 중에도 창 포커스가 바뀔 수 있기 때문이다. 마우스 이동으로도 세션을 끝내지 않는다. Firefox에서는 네이티브 `dragstart` 직후에도 페이지에 `mousemove`가 올 수 있기 때문이다 (wr-0itb). VS Code는 탭 컨트롤이 `LocalSelectionTransfer`를 직접 쓰고 `dragend`에서 지운다 — 옮겨진 탭은 드롭 중에 문서에서 빠져 자기 `dragend`를 받지 못하므로, 뷰 컨테이너 드래그(wr-cla6.3d4)와 같은 규율로 어떤 출구에서도 낡은 페이로드가 남지 않게 한다 (wr-cla6.bxt)
- 드래그 도중 소스 DOM이 사라지면 드롭 처리기가 페이로드를 읽은 뒤 세션을 정리한다. 브라우저가 드롭이나 소스의 종료를 전달하지 않으면, 주 포인터 버튼이 해제된 신뢰 입력이 창에 돌아오거나 다음 네이티브 드래그가 시작될 때 정리한다 (wr-1pn9.2su).
- 드래그에는 텍스트 값(에디터 이름)과 전용 MIME 표시(`application/x-writing-room-editor`)만 싣고, 대상은 이 표시와 진행 중인 세션이 둘 다 있을 때만 페이로드를 읽는다. VS Code는 리소스 전송 데이터와 드래그 이미지도 싣고 표시 형식 없이 전송 싱글턴의 프로토타입만 본다 — 에디터 영역은 파일 드래그를 받지 않고(파일은 Explorer가 받는다), 표시가 있어야 뷰 컨테이너 드래그와 에디터 드래그가 서로의 대상에서 착각되지 않는다 (wr-cla6.bxt)
- 에디터와 그룹 드래그는 이동이며 `effectAllowed`는 `move`다. VS Code는 `copyMove`이고 Ctrl(macOS는 Alt)로 복사한다. 다중 선택 탭 드래그, 탭 위에 1500 ms 머물면 열기, 드래그 중 탭 줄 자동 스크롤, Alt/Shift로 분할·병합 뒤집기, 새 창으로 끌어내기도 없다 — 릴리스 범위 밖이다 (wr-cla6.bxt)
- 에디터 영역은 에디터, 그룹, 현재 작품의 코어 Navigator 드래그를 받는다. 원고와 인물 Navigator는 각자의 드롭 제공자를 등록한다. 열 문서나 카드가 있는 항목을 그룹 본문 가운데에 놓아 열거나 가장자리에 놓아 분할해서 연다. 확장 TreeView 드래그는 거절한다 (wr-1pn9.qae). 파일, 텍스트, 뷰 컨테이너 드래그는 파트 어디서나 `dropEffect = 'none'`으로 거절해 브라우저가 파일로 이동하지도 않는다. VS Code는 외부 파일을 `ResourcesDropHandler`로 열고 Monaco가 텍스트 드롭을 받는다 — 에디터 영역에 놓은 파일은 열지 않는다(올리기는 Explorer의 몫이다). 페이지 밖에서 온 것을 놓아도 아무 일도 일어나지 않아야 한다 (wr-cla6.bxt)
- `EditorDropTarget`은 파트 콘텐츠의 캡처 단계에서 그룹 본문으로 가는 드래그 이벤트를 모두 멈춰(`stopPropagation`) Monaco가 어떤 드래그도 보지 못하게 하고, 드롭을 내줄 때는 첫 `dragenter`에서 바로 오버레이를 만든다. VS Code는 버블 단계의 `onDragEnter`에서 만들고 `isContentDropTargetEvent`로 에디터에 양보할 위치를 가린다 — 드롭을 내주지 않는 경우(그룹의 유일한 탭, 자기 자신 위의 그룹)에도 Monaco가 드롭 커서를 그리거나 숨은 입력 요소가 텍스트를 받지 않게 한다 (wr-cla6.bxt)
- `getSplitDirection`은 모듈의 순수 함수로 export하고 `preferSplitVertically`는 언제나 `true`다. VS Code에서는 `DropOverlay`의 메서드이며 `workbench.editor.openSideBySideDirection`에서 읽고 `splitsOnly` 인자도 받는다 — 설정이 없고, 표를 jsdom에서 경계값으로 검증한다 (wr-cla6.bxt)
- 오버레이는 비어 있는 그룹에서도 탭 줄 아래 본문만 덮는다. VS Code는 빈 그룹이나 탭을 숨긴 그룹에서 그룹 전체를 덮는다 — 여기서는 탭 줄이 늘 보이고 빈 그룹의 탭 줄도 드롭 대상(끝에 삽입)이다 (wr-cla6.bxt)
- 오버레이 표시 영역에는 위치 전환 애니메이션이 없다. VS Code는 `transition`으로 움직인다 — 드롭될 자리를 그 순간 그대로 보여 주고, 브라우저 테스트가 중간 위치를 재지 않게 한다. VS Code의 300 ms `cleanupOverlayScheduler`도 없다. 오버레이는 이벤트를 직접 받으므로 떠날 때와 세션이 끝날 때 지운다 (wr-cla6.bxt)
- 삽입 표시와 오버레이는 클래스 대신 속성으로 나타낸다: 탭(또는 빈 곳 위라면 탭 줄)의 `data-tab-drop-position`(`before`, `after`, `end`)과 오버레이 표시 영역의 `data-editor-drop-position`(`left`, `right`, `up`, `down`, `center`). VS Code는 `drop-target-left`/`drop-target-right` 같은 클래스를 쓴다 — 클래스 이름은 DOM 계약이 아니다 (wr-cla6.bxt)
- 탭 줄은 `DragAndDropObserver` 하나로 줄 전체를 보고 이벤트 대상에서 가리킨 탭을 찾는다. 관찰자는 줄에 들어올 때만 `dragenter`를 넘기므로, 탭마다의 `dragenter`는 줄의 리스너 하나가 `dragover`처럼 받아 드롭을 허락한다(브라우저는 다음 `dragover`까지 `dragenter`의 답을 드롭 연산으로 쓴다). VS Code는 탭마다 관찰자를 하나씩 두고 줄에 또 하나를 둔다 — 탭은 모델 이벤트로 다시 그려지므로 탭별 등록과 해제가 필요 없다 (wr-cla6.bxt)
- `IEditorGroupsView`에 `getGroup`, `addGroup`, `moveGroup`, `mergeGroup`을, `IEditorGroupView`에 `titleContainer`와 `titleHeight`(숫자)를 더했다. VS Code의 `IEditorGroupsView`에는 이미 있고 `titleHeight`는 `{ total, offset }`이다 — 탭 줄의 높이가 하나뿐이다 (wr-cla6.bxt)

### Storage and settings

#### Layout and editor persistence

- 페이지를 시작할 때 사이드바와 패널 크기, 파트 표시 여부, 마지막으로 선택한 뷰 컨테이너를 읽는다. 크기는 픽셀 단위로 프로필에 저장하고 현재 창과 파트의 한계에 맞춘다. 사용자가 정한 표시 여부와 활성 컨테이너는 워크스페이스에 저장한다. 빈 사이드바와 패널의 자동 숨김은 시작할 때 컨테이너 위치에서 다시 계산한다. 페이지가 숨겨지거나 보이는 페이지에 유휴 저장 알림이 오면 현재 값으로 갱신한다 (wr-cla6.kn7).
- 워크스페이스의 `memento/workbench.parts.editor` 안에 `editorpart.state`를 저장한다. 그리드 비율, 그룹 ID, 탭 순서, 활성 그룹과 탭을 첫 레이아웃에서 복원한다. 저장한 에디터 상태가 없을 때만 Welcome을 연다. 탭을 모두 닫은 뒤 저장한 상태나 읽지 못한 상태에서는 빈 그룹 하나로 시작한다 (wr-cla6.kn7).
- 제목 없는 텍스트에는 문서 전체를 기준으로 UTF-16 코드 유닛 1,000,000개의 합계 한도를 적용한다. 최근 사용한 문서부터 넣고, 여러 그룹에 나타나는 문서는 한 번만 계산한다. 첫 탭의 직렬화 문자열에는 Base64로 인코딩한 텍스트를, 나머지 탭에는 같은 입력의 이름을 넣는다. 한도를 넘어서 복원하지 못할 텍스트가 있을 때 브라우저의 페이지 나가기 확인을 건다 (wr-cla6.kn7).
- 복원된 에디터는 문서의 맨 위에서 열린다. VS Code는 `EditorMemento`로 커서와 스크롤 위치를 복원한다 (wr-cla6.kn7). [VS Code의 에디터 뷰 상태](vscode-state-settings.md#22-저장-항목-목록)

#### Storage

- `getNumber`는 `Number(value)`로 문자열을 숫자로 변환한다. VS Code는 `parseInt(value, 10)`을 쓴다 — `store`로 쓴 소수와 지수 표기 숫자를 같은 값으로 읽기 위해서다 (wr-cla6.68r). [VS Code의 `getNumber`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/storage/common/storage.ts#L115-L125)
- 유휴 저장은 마지막 유휴 저장 후 최소 60초 간격으로 실행되고, 문서가 숨겨지거나 `pagehide`가 발생하면 동기 저장한다. VS Code 웹은 5초 주기로 포커스가 있고 대기 중인 쓰기가 없을 때 유휴 저장한다 — 동기 백엔드가 페이지를 떠날 때 상태를 반영할 수 있어 주기 저장의 빈도를 낮췄다 (wr-cla6.68r). [VS Code 웹의 저장 주기와 조건](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/storage/browser/storageService.ts)
- `Memento`의 상태 객체는 인스턴스와 스코프별로 유지된다. VS Code는 같은 ID와 스코프의 객체를 정적 맵에서 공유한다 — 여기서는 상태 객체의 수명을 컴포넌트 인스턴스에 맞춘다. 같은 저장 키를 가진 여러 인스턴스가 각각 수정하면 마지막으로 저장한 값이 남는다 (wr-cla6.68r). [VS Code의 `Memento`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/common/memento.ts#L11-L60)
- `IStorageService`는 메모리 모드 여부(`usesMemory`: 백엔드를 열지 못했거나, 쓰기가 실패했거나, 다른 탭의 스키마 변경을 본 뒤에 참이 되고, 한 번 참이면 이 탭의 저장소가 닫힐 때까지 참으로 남는다)와 키 하나의 영속 값 읽기(`getPersisted`: 이미 열린 백엔드에서 스키마 표식과 그 키만 읽고 아무것도 쓰지 않으며, 메모리 모드에서는 이 탭의 값을 답한다)를 드러낸다. `storeImmediately`는 그대로 메모리 모드에서도 백엔드를 다시 열어 쓴다 (wr-uz4j)
- `keys(scope)`는 범위 접두 없는 이 탭 캐시 키의 사본을 돌려준다. 탭 사이에서 일치해야 하는 판단에는 이 사본이 아니라 `storeImmediately`가 변환 함수에 주는 영속 스냅숏을 쓴다 (wr-s9ew.wx6)

#### 원고 저장소

- `ManuscriptStore`는 작품, 원고 트리, 문서 내용을 다룬다. Node API는 인증된 사용자 범위에서 작품을 조회하고 Postgres에 영속한다. 작품별 revision으로 트리 변경을 비교하고, 문서별 etag로 본문 쓰기를 비교한다. 노드의 메타데이터 JSON은 64 KiB까지 허용하며, 한 작품의 비어 있지 않은 메타데이터 합계는 UTF-8 기준 16 MiB까지 허용한다. 로컬 서버와 DB 실행법은 [API 서버 실행](getting-started.md#api-서버-실행)에 있다.
- 브라우저는 같은 오리진의 `/api`로 요청한다. 서버 오류는 작품과 편집기 저장 경로에 전달한다. `?store=memory` 또는 `VITE_WRITING_ROOM_STORE=memory`로 명시적으로 선택하면 창 안에 임시로 저장하고 상태 표시줄에 새로고침 시 사라진다는 경고를 표시한다.
- 원고 편집기는 `manuscript://<workId>/<nodeId>.md`를 텍스트 파일로 연다. 파일 제공자는 탭을 복원하기 전에 등록되고 창이 연 작품의 URI만 받는다. 작업 영역 ID는 작품별 탭과 초안 복원 범위를 정한다. 편집기 저장과 dirty 상태는 기존 텍스트 파일 경로를 사용한다. 다른 창의 저장은 다음 쓰기에서 etag 충돌로 확인한다. 작품 구조 변경은 작품 트리 API가 담당한다.

#### 등장인물 저장소

- `CharactersStore`는 작품별 폴더와 등장인물 트리를 다룬다. 모든 트리 쓰기는 등장인물 리비전을 비교하며, 리비전이 바뀌면 작품의 수정 시각에도 반영한다. 인물별 필드값은 64 KiB, 작품의 비어 있지 않은 필드값 합계는 UTF-8 기준 16 MiB까지 허용한다.
- 같은 오리진의 `/api/works/:workId/characters` 아래에서 `GET /tree`, `POST /nodes`, `POST /nodes/move`, `PATCH /nodes/:nodeId`, `DELETE /nodes/:nodeId`를 사용한다. 인증과 작품 소유권을 확인하며, 원고 요청과 창의 세션 상태를 공유한다.
- `?store=memory` 또는 `VITE_WRITING_ROOM_STORE=memory`로 열면 현재 창에 작품과 등장인물을 임시로 저장한다. API 서버를 메모리 모드로 실행하면 서버가 작품과 등장인물을 함께 보관한다.
- Postgres 모드에서 API 서버는 `characters` 테이블에 트리를 영속한다. `works.characters_revision`은 작품별 등장인물 리비전이며 원고는 별도의 `tree_revision`을 사용한다.
- `GET /template`은 작품의 필드 정의를 읽는다. 아직 저장한 템플릿이 없으면 기본 여덟 필드를 리비전 0으로 돌려준다. `PUT /template`은 `fields`와 `expectedRevision`을 받아 `character_templates`에 저장한다. 템플릿은 자체 리비전을 쓰며 인물에 저장된 값은 그대로 남는다. 성공한 `PUT`은 트리 쓰기처럼 작품의 수정 시각을 갱신하고, 충돌이나 검증 실패는 갱신하지 않는다.

#### Settings

- **File → Preferences → Open User Settings (JSON)** 또는 F1의 **Preferences: Open User Settings (JSON)**으로 `settings.json`을 연다. Monaco에서 키 자동 완성과 스키마 진단을 제공한다. Ctrl+S(macOS에서는 Cmd+S)로 저장하면 열린 Monaco 편집기에 적용한다 (wr-cla6.dnq). [VS Code 설정 열기 커맨드](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts)
- 프로필 스토리지의 `user.settings.json` 키에 JSONC 텍스트 원문을 저장한다. 주석, 후행 쉼표, 알 수 없는 키를 보존한다. 구문이 깨지면 현재 탭의 마지막 유효한 설정을 적용하고, 새 탭에서 아직 유효한 설정을 읽은 적이 없으면 기본값을 쓴다. 명시적 저장이 실패하면 편집 중인 텍스트와 적용값을 유지한다. 다른 탭의 저장은 적용값을 갱신하면서 이 탭의 더티 텍스트를 보존한다. 프로그램에서 한 키를 바꿀 때는 현재 저장된 텍스트를 읽어 그 키의 값만 편집한다 (wr-cla6.dnq). [VS Code 설정 서비스](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/configuration/browser/configurationService.ts)
- `editor.fontSize`(14), `editor.tabSize`(4), `editor.wordWrap`(`off`), `editor.lineNumbers`(`on`), `editor.minimap.enabled`(`true`), `workbench.editor.closeEmptyGroups`(`true`), `workbench.commandPalette.history`(50)를 지원한다. 기록을 끄려면 `workbench.commandPalette.history`를 0으로 설정한다 (wr-cla6.dnq).
- v0.2.0에서 더한 워크벤치 설정은 `workbench.colorTheme`([테마와 뷰](extension-api-theming-and-views.md)), `workbench.editorAssociations`([Custom Editor](extension-api-custom-editors.md)), `files.refactoring.autoSave`([문서와 에디터](extension-api-documents.md)), `editor.quickSuggestions`와 언어별 `[언어]` 구역([설정 기여](extension-api-configuration.md)), `locale`([확장 런타임](extension-api-runtime.md))이다. 확장이 기여한 설정도 같은 `settings.json`에서 읽는다([설정 기여](extension-api-configuration.md)) (wr-jbmd).
- 열린 설정 탭의 미저장 초안은 에디터 배치 상태에서 복원한다. 새로고침 뒤에도 탭은 더티 상태이며, Ctrl+S를 누를 때까지 저장된 원문과 적용값은 유지한다 (wr-cla6.dnq).
- `editor.tabSize`를 열린 모든 Monaco 모델에 적용하며, 모델이 감지한 탭 크기도 이 값으로 갱신한다 — 설정을 문서에 관계없이 일관되게 적용하기 위해서다. VS Code는 `editor.detectIndentation`이 기본으로 켜져 있어 파일에서 감지한 크기를 우선한다 (wr-tw4t.u5g). [VS Code의 들여쓰기 설정](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/editor/common/config/editorConfigurationSchema.ts#L21-L50)
- `editor.fontSize` 기본값을 모든 운영체제에서 14px로 유지한다 — 설정 이슈에서 정한 공통 기본값이다. VS Code는 macOS 기본값으로 12px를 쓴다 (wr-tw4t.u5g). [VS Code의 글꼴 기본값](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/editor/common/config/fontInfo.ts#L222-L225)

### Extensions

[확장 API 색인](extension-api.md#영역별-문서)에서 영역별 선언과 지원 범위를 찾는다.

#### Manifest contributions

- Vite가 빌드 시 내장 확장 매니페스트를 읽고, 빌드 후 디렉터리를 `dist/extensions/`에 복사한다 — 개발과 배포에서 `extensionUri`를 기준으로 매니페스트와 리소스를 읽을 수 있게 한다 (wr-cla6.rmv). [VS Code 내장 확장 스캐너](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts)
- 파싱에 실패하는 `when`과 `enablement`는 해당 기여를 건너뛴다. 기여 집합이 바뀌어도 같은 확장의 뷰와 컨테이너를 유지해 열린 위치를 보존한다 (wr-cla6.v89). [VS Code 메뉴 기여 핸들러](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/actions/common/menusExtensionPoint.ts)

- 테마별 커맨드와 서브메뉴 아이콘은 등록 시 현재 테마에 맞는 경로를 고른다. 테마가 바뀌면 기여 지점을 다시 적용한다. VS Code는 두 경로를 메뉴 아이콘에 함께 유지하고 표시할 때 선택한다 (wr-efqx.6ek). [VS Code의 테마 아이콘 경로 선택](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/browser/menuEntryActionViewItem.ts#L291-L319)
- 확장 매니페스트 메뉴 항목의 `alt`는 문자열로 검증한다. 메뉴에는 기본 커맨드가 표시되고 실행된다. VS Code의 메뉴는 대체 커맨드를 표시하고 실행할 수 있다 (wr-efqx.6ek). [VS Code의 대체 메뉴 액션](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/browser/menuEntryActionViewItem.ts)

#### Extension host

- Writing Room은 영역별 기여로 Worker의 API와 확장 컨텍스트를 조립한다. VS Code는 `extHost.api.impl.ts`에 조립을 모은다. 영역의 진입 파일에서 함께 개발하는 기능을 별도로 등록하도록 분리했다 (wr-efqx.n9k). [VS Code API 조립](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/api/common/extHost.api.impl.ts)

- 앱과 같은 오리진에서 전용 모듈 Worker 하나를 지연 시작한다. Vite의 Worker URL 변환을 사용하고, 준비·초기화·종료 신호와 객체 기반 RPC가 전용 `MessagePort`를 공유한다. 시작 제한은 60초다. 포그라운드에서 응답이 끊기면 호스트를 중지하고, 재시작으로 이미 발생한 활성화 이벤트를 재생한다 (wr-cla6.rmv). [VS Code 웹 Worker 호스트](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts)
- 커맨드와 활성화 RPC는 식별자와 구조화 복제 가능한 값을 전달한다. 등록에는 확장 설치 세대의 키를 사용해 제거 후 같은 확장을 다시 설치해도 이전 호스트의 호출이 새 등록을 바꾸지 못하게 한다 (wr-cla6.rmv). [VS Code 확장 호스트 프로토콜](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/api/common/extHost.protocol.ts)

- 초기화 뒤 Worker의 잡히지 않은 오류와 Promise 거부는 Worker에서 잡아 스택에서 확장 진입 파일을 찾으면 Output의 `Extension Host (Worker)` 채널에 확장 ID와 함께 남기고, 주인을 찾지 못한 오류는 개발자 콘솔에 남긴다. VS Code 웹 호스트는 Worker를 띄운 iframe의 콘솔로 보낸다 — 한 확장의 비동기 예외가 다른 확장의 등록과 실행을 끊지 않게 하고, 어느 확장의 오류인지 화면에서 보이게 한다 (wr-cla6.rmv, wr-54me).

#### Extension API

- 트리 RPC는 핸들과 구조화 복제 가능한 행 데이터만 전달한다. 일반 갱신은 하위 목록을 요청하고, 요소 단위 갱신은 `$getTreeItem`으로 행을 다시 받는다. 상태 항목은 한 마이크로태스크에 갱신을 모으고 토스트는 원래 선택지의 인덱스로 응답한다 (wr-cla6.n6y). [VS Code 트리 프로토콜](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/api/common/extHost.protocol.ts)

- 상태 표시줄 항목의 접근 가능한 이름은 `name`을 우선 사용하며 기본값은 확장 식별자다 — 표시 텍스트가 동적으로 바뀌어도 안정적인 이름을 제공한다 (wr-cla6.n6y).
- 트리 항목 커맨드에서 `arguments`를 생략하면 해당 항목의 원래 요소 하나를 전달한다 — 간단한 행 커맨드가 대상 요소를 받을 수 있게 한다 (wr-cla6.n6y).

#### Extension installation

- 설치 목록은 프로필 범위 `extensions.user` 키에 매니페스트와 위치를 저장한다. 시작 시 사본을 다시 검사해 내장 확장과 함께 첫 레이아웃에 등록한다. 코드와 이미지 파일은 활성화할 때 해당 위치에 요청하며 설치 목록에는 저장하지 않는다 (wr-cla6.ayw). [VS Code 웹 확장 스캐너](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts)

- 원격 매니페스트, 진입 파일, 아이콘 요청은 같은 CORS 정책과 스트리밍 읽기 경로를 사용한다 — 읽는 중에 각각 256 KiB, 5 MiB, 256 KiB에서 멈춰 원격 응답의 메모리 사용을 제한한다 (wr-cla6.ayw).

Decided in: wr-e8v6, wr-pip6, wr-hze8, wr-ggyb, wr-k5og, wr-cla6, wr-jbmd, wr-ndsy, wr-h2sa, wr-cbej, wr-th5n, wr-1pn9, wr-df7m
