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

- `when`은 불리언 키와 리터럴, 동등·부등 비교, 논리 부정·곱·합, 괄호를 지원한다. 정규식, 포함 관계, 수치 순서 비교는 구문 오류로 보고한다 — v0.1.0의 메뉴와 키바인딩에 공통으로 적용하는 구문을 이 부분집합으로 정했다 (wr-cla6.jvs). [VS Code의 `Parser`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/contextkey/common/contextkey.ts#L174)
- `MenuRegistry`는 VS Code와 같이 같은 마이크로태스크에 들어온 변경을 메뉴 id 집합으로 묶는다. VS Code의 `MenuImpl` 기본 지연은 50ms이며 여기서는 관련 레지스트리 알림을 받거나 참조한 컨텍스트 키가 바뀌면 바로 알린다 — 한 번의 등록 묶음을 합치면서 이미 열린 메뉴에는 컨텍스트 변경을 즉시 반영한다 (wr-cla6.jvs). [VS Code의 `MenuRegistry`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/common/actions.ts#L525-L529), [VS Code의 `MenuService.createMenu`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/actions/common/menuService.ts#L35-L37)
- 최상위 메뉴 후보는 코어가 등록하는 File, Edit, View, Help 네 가지이며 표시할 항목이 있는 메뉴만 나타난다. VS Code는 Selection, Go, Terminal 등도 등록한다 — 여기서는 v0.1.0의 셸과 커맨드 범위에 맞춰 메뉴 후보를 줄였다 (wr-cla6.jvs). [VS Code의 메뉴 바 기여](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts)
- 키바인딩은 US 배열 기준 `KeyboardEvent.code`의 물리 위치를 해석하고 OS에 맞는 수정자 레이블을 표기한다. 다른 배열에서는 키가 입력하는 문자와 메뉴·팔레트 레이블이 다를 수 있다. VS Code는 배열을 감지하는 키보드 매퍼와 사용자 `keybindings.json`을 적용한다 — v0.1.0에서는 기본 및 기여 단축키에 공통 물리 키 규칙을 사용한다 (wr-cla6.em5). [VS Code의 `WorkbenchKeybindingService`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/keybinding/browser/keybindingService.ts)
- F1 또는 **View → Command Palette...**로 팔레트를 연다. Firefox를 제외하면 Ctrl+Shift+P(macOS에서는 Cmd+Shift+P)도 쓸 수 있다. VS Code는 `>`를 넣어 커맨드 제공자를 선택한다 — v0.1.0에는 커맨드 모드만 있어 빈 입력으로 시작한다 (wr-cla6.nzs). [VS Code의 `ShowAllCommandsAction`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts#L273-L294)
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

#### Monaco editor

- 에디터는 VS Code처럼 `src/vs/editor`를 내장하지 않고 같은 코드를 독립 실행형으로 묶은 `monaco-editor` 패키지를 쓴다. 패키지를 임포트하는 파일은 `src/editor/browser/monaco.ts` 하나이며 `loadMonaco()`가 처음 열리는 텍스트 에디터에서 지연 로드한다 — 워크벤치의 첫 페인트가 수 MB의 패키지와 워커를 기다리지 않게 한다 (wr-cla6.36n)
- `IModelService.createModel`은 비동기다. VS Code는 동기다 — 패키지를 처음 쓸 때 로드하므로 모델을 만들기 전에 기다려야 한다 (wr-cla6.36n)
- 에디터 페인 레지스트리는 입력의 `typeId`로 페인을 찾는다(`registerEditorPane(descriptor, editorTypeIds)`). VS Code는 입력 생성자의 `SyncDescriptor`로 찾는다 — 입력 타입 id가 이미 계약이라 `instanceof`가 필요 없다 (wr-cla6.36n)
- 제목 없는 에디터의 이름은 언제나 `Untitled-N`이다. VS Code는 텍스트의 첫 줄에서 이름을 만든다 (wr-cla6.36n)
- `URI`는 퍼센트 인코딩 없이 구성 요소를 그대로 이어 쓴다 — v0.1.0의 리소스는 워크벤치가 만드는 `untitled:Untitled-N`뿐이다. 그렇게 이어 쓰면 다른 URI로 읽히는 구성 요소(경로의 `?`·`#`, authority가 있을 때 `/`로 시작하지 않는 경로 등)는 거부한다 (wr-cla6.36n)
- `TextEditorPane`은 입력별 뷰 상태를 페인 안의 메모리 맵에 두고 입력이 dispose되면 지운다. VS Code의 `AbstractEditorWithViewState`는 그룹과 리소스 키로 memento에 저장한다 — 새로고침 뒤 복원은 레이아웃과 에디터 저장 멤버의 몫이다. 다른 페인으로 옮길 때는 `getViewState()`와 `setInput`의 `viewState` 옵션으로 넘긴다 (wr-cla6.36n)
- 페인은 새 입력을 로드하는 동안 이전 모델을 떼어(`setModel(null)`) 둔다. VS Code는 새 모델로 바로 바꾼다 — 패키지나 모델 로드가 늦을 때 이전 탭의 텍스트가 새 탭 아래 보이지 않게 한다. 떼기 전에 에디터에 포커스가 있었으면 새 모델이 붙을 때 되돌린다 (wr-cla6.36n)
- Monaco 자체의 F1 바인딩(`editor.action.quickCommand`)을 지운다 — F1은 워크벤치의 커맨드 팔레트로 간다. Monaco의 컨텍스트 메뉴, 찾기 위젯, 다른 키바인딩은 그대로 둔다 (wr-cla6.36n)
- `editorTextFocus`, `editorFocus`, `textInputFocus`는 페인 요소에 만든 범위 컨텍스트 키 서비스에서 Monaco의 포커스 이벤트를 따른다. VS Code는 `CodeEditorWidget`이 자기 범위 서비스에서 설정한다 (wr-cla6.36n)
- Monaco의 CSS도 `@vscode/codicons`와 같은 `codicon` 글꼴 패밀리를 선언하므로, Monaco가 로드된 뒤에는 나중에 온 Monaco의 글꼴이 워크벤치 아이콘에도 쓰인다. monaco-editor 0.57.0의 글꼴은 `@vscode/codicons` 0.0.46-24의 아이콘 746개를 모두 같은 코드 포인트로 담고 있어 지금은 보이는 차이가 없다. 두 패키지 중 하나를 올리면 다시 확인한다 (wr-cla6.36n)

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
- 페인은 워크벤치의 인스턴스화 서비스로 만들어지므로 페인 요소의 범위 컨텍스트 키 서비스(`editorTextFocus` 등)의 부모는 그룹의 범위가 아니라 전역 서비스다. 그래서 텍스트 에디터에 포커스가 있을 때는 그룹 범위의 `groupEditorsCount`가 보이지 않는다. VS Code는 그룹의 범위 컨텍스트 키 서비스를 담은 자식 인스턴스화 서비스로 페인을 만든다 — 인스턴스화 서비스에 자식 서비스가 아직 없다 (wr-cla6.vge)
- dirty한 제목 없는 에디터는 확인 없이 닫힌다 — v0.1.0에는 저장할 파일도 확인 대화 상자도 없다 (wr-cla6.vge)
- Close Editor는 VS Code처럼 Ctrl+W(Windows는 Ctrl+F4와 Ctrl+W, macOS는 Cmd+W)로 선언하지만 일반 브라우저 탭에서 Ctrl+W는 브라우저가 가져가 페이지에 닿지 않는다 (wr-cla6.vge)
- `workbench.action.files.newUntitledFile`은 `parts/editor/editorActions.ts`에 둔다. VS Code는 `contrib/files/browser/fileActions.contribution.ts`에 둔다 — 파일 기여가 아직 없다. 키는 VS Code 웹의 것(Ctrl+Alt+N, Windows는 Ctrl+K N)이다. Ctrl+N은 브라우저가 가져간다 (wr-cla6.vge)
- Welcome 페이지는 `parts/editor/welcomeEditor.ts`의 작은 페인과 입력(`workbench.editors.gettingStartedInput`)이며, 시작할 때 그룹이 비어 있으면 포커스를 옮기지 않고 연다. VS Code의 Getting Started는 `contrib/welcomeGettingStarted`에 있고 설정과 복원 상태에 따라 연다 — 레이아웃과 에디터 저장 전에는 매번이 첫 실행이다 (wr-cla6.vge)
- **View → Editor Layout**에 Split Up/Down/Left/Right와 **Join All Editor Groups**를 둔다. VS Code의 Editor Layout 메뉴에는 레이아웃 프리셋도 있다 — 프리셋은 범위 밖이다 (wr-cla6.vge)

#### 에디터 그룹 조작

- **File → New Text File**(Ctrl+Alt+N, Windows는 Ctrl+K N, macOS는 Cmd+Option+N)이 활성 그룹에 `Untitled-N` 텍스트 에디터를 연다. 처음 열 때 Monaco를 받아 온다. 타이핑하면 탭에 점이 붙는다. 첫 화면의 그룹에는 Welcome 페이지가 열린다.
- 탭을 누르면 그 에디터로 바꾸고, 탭의 닫기 버튼이나 가운데 버튼으로 닫는다. 배경 탭을 닫아도 활성 탭은 그대로다. 탭에 포커스가 있으면 좌우 화살표, Home, End로 탭 사이를 옮긴다. 탭을 오른쪽 클릭하면 Close, Close Others, Close All과 네 방향 분할이 나온다.
- 각 그룹 타이틀의 **Split Editor Right** 버튼(Ctrl+\\, macOS는 Cmd+\\)이나 **View → Editor Layout**의 Split Up/Down/Left/Right가 같은 에디터를 옆 그룹에 연다. 두 그룹은 같은 텍스트를 편집한다. **Join All Editor Groups**는 모든 그룹을 활성 그룹으로 합친다. 마지막 탭을 닫은 그룹은 다른 그룹이 있으면 사라진다.
- 그룹 사이 경계를 끌어 크기를 바꾼다. 그룹은 220 x 70 px보다 작아지지 않는다. 팔레트(F1)의 `View:` 커맨드로 다음 그룹 포커스, 다음 그룹으로 에디터 이동, 모든 에디터 닫기도 할 수 있다.

### Storage and settings

#### Storage

- `getNumber`는 `Number(value)`로 문자열을 숫자로 변환한다. VS Code는 `parseInt(value, 10)`을 쓴다 — `store`로 쓴 소수와 지수 표기 숫자를 같은 값으로 읽기 위해서다 (wr-cla6.68r). [VS Code의 `getNumber`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/platform/storage/common/storage.ts#L115-L125)
- 유휴 저장은 마지막 유휴 저장 후 최소 60초 간격으로 실행되고, 문서가 숨겨지거나 `pagehide`가 발생하면 동기 저장한다. VS Code 웹은 5초 주기로 포커스가 있고 대기 중인 쓰기가 없을 때 유휴 저장한다 — 동기 백엔드가 페이지를 떠날 때 상태를 반영할 수 있어 주기 저장의 빈도를 낮췄다 (wr-cla6.68r). [VS Code 웹의 저장 주기와 조건](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/storage/browser/storageService.ts)
- `Memento`의 상태 객체는 인스턴스와 스코프별로 유지된다. VS Code는 같은 ID와 스코프의 객체를 정적 맵에서 공유한다 — 여기서는 상태 객체의 수명을 컴포넌트 인스턴스에 맞춘다. 같은 저장 키를 가진 여러 인스턴스가 각각 수정하면 마지막으로 저장한 값이 남는다 (wr-cla6.68r). [VS Code의 `Memento`](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/common/memento.ts#L11-L60)

### Extensions

#### Manifest contributions

- Vite가 빌드 시 내장 확장 매니페스트를 읽고 참조할 수 있는 파일을 URL 에셋으로 발행한다. 매니페스트 위치와 리소스 URL의 매핑은 개발과 배포에서 같은 확장 설명을 쓰게 한다 (wr-cla6.v89). [VS Code 내장 확장 스캐너](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts)
- 파싱에 실패하는 `when`과 `enablement`는 해당 기여를 건너뛴다. 기여 집합이 바뀌어도 같은 확장의 뷰와 컨테이너를 유지해 열린 위치를 보존한다 (wr-cla6.v89). [VS Code 메뉴 기여 핸들러](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/actions/common/menusExtensionPoint.ts)

#### Extension host

- 앱과 같은 오리진에서 전용 모듈 Worker 하나를 지연 시작한다. Vite의 Worker URL 변환을 사용하고, 준비·초기화·종료 신호와 객체 기반 RPC가 전용 `MessagePort`를 공유한다. 시작 제한은 60초다. 포그라운드에서 응답이 끊기면 호스트를 중지하고, 재시작으로 이미 발생한 활성화 이벤트를 재생한다 (wr-cla6.rmv). [VS Code 웹 Worker 호스트](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts)
- 커맨드와 활성화 RPC는 식별자와 구조화 복제 가능한 값을 전달한다. 등록에는 확장 설치 세대의 키를 사용해 제거 후 같은 확장을 다시 설치해도 이전 호스트의 호출이 새 등록을 바꾸지 못하게 한다 (wr-cla6.rmv). [VS Code 확장 호스트 프로토콜](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/api/common/extHost.protocol.ts)

#### Extension API

- 트리 RPC는 핸들과 구조화 복제 가능한 행 데이터만 전달한다. 일반 갱신은 하위 목록을 요청하고, 요소 단위 갱신은 `$getTreeItem`으로 행을 다시 받는다. 상태 항목은 한 마이크로태스크에 갱신을 모으고 토스트는 원래 선택지의 인덱스로 응답한다 (wr-cla6.n6y). [VS Code 트리 프로토콜](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/api/common/extHost.protocol.ts)

#### Extension installation

- 설치 목록은 프로필 범위 `extensions.user` 키에 매니페스트와 위치를 저장한다. 시작 시 사본을 다시 검사해 내장 확장과 함께 첫 레이아웃에 등록한다. 코드와 이미지 파일은 활성화할 때 해당 위치에 요청하며 설치 목록에는 저장하지 않는다 (wr-cla6.ayw). [VS Code 웹 확장 스캐너](https://github.com/microsoft/vscode/blob/41004e061e582855eb1e99b6a6e5d52994f661be/src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts)

Decided in: wr-e8v6, wr-pip6, wr-hze8, wr-ggyb
