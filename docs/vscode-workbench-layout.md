# VS Code 워크벤치 레이아웃

고정 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`에서 VS Code가 창을 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄)로 어떻게 조립하고, 크기와 표시 여부를 어떻게 관리하는지 정리한다. 홈은 [README.md](README.md), 대응 규칙과 차이는 [architecture.md](architecture.md), 에디터 파트 내부는 [vscode-editor-groups.md](vscode-editor-groups.md), 저장되는 레이아웃 상태는 [vscode-state-settings.md](vscode-state-settings.md)를 본다.

## 범위

- 다루는 것: 제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄.
- 이 커밋의 레이아웃 코드에는 보조 사이드바(`AUXILIARYBAR_PART`), 배너, 채팅(`CHAT_PART`), 세션(`SESSIONS_PART`), 커스텀 뷰 그리드(`CUSTOM_VIEW_GRID_PART`), 플로팅 패널과 모던 UI 클래스도 들어 있다. v0.1.0이 따르지 않으므로 범위 밖이며 이름만 적는다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드도 같다.

## 1. 파트의 식별: `Parts`와 `IWorkbenchLayoutService`

파일: `src/vs/workbench/services/layout/browser/layoutService.ts`

| 심볼 | 결정하는 것 |
| --- | --- |
| `Parts` (`const enum`) | 파트 id 문자열. 여섯 파트는 `TITLEBAR_PART`(`workbench.parts.titlebar`), `ACTIVITYBAR_PART`, `SIDEBAR_PART`, `EDITOR_PART`, `PANEL_PART`, `STATUSBAR_PART`. 이 id가 DOM `id`, 그리드 직렬화의 `type`, 가시성 이벤트의 `partId`에 그대로 쓰인다. |
| `IWorkbenchLayoutService` | 파트를 다루는 유일한 창구. 다른 코드는 파트 인스턴스를 직접 잡지 않고 이 서비스를 쓴다. |
| `isVisible(part)` | 파트 가시성 질의. 구현은 `Layout.isVisible`이며 파트별 `LayoutStateKeys.*_HIDDEN`을 읽는다. |
| `setPartHidden(hidden, part)` | 파트 표시/숨김 변경. 구현은 `Layout.setPartHidden`. |
| `focusPart`, `hasFocus`, `getContainer` | 포커스 이동과 파트 DOM 컨테이너 조회. |
| `getSideBarPosition`, `getPanelPosition`, `setPanelPosition` | 사이드바(좌/우)와 패널(상/하/좌/우) 위치. 값은 `Position` (`LEFT`, `RIGHT`, `BOTTOM`, `TOP`)이고 `isHorizontal`이 상/하 여부를 가른다. |
| `toggleMaximizedPanel`, `isPanelMaximized`, `centerMainEditorLayout` | 패널 최대화, 에디터 가운데 정렬. |

- `Workbench`(`src/vs/workbench/browser/workbench.ts`)가 `Layout`을 상속하고 `serviceCollection.set(IWorkbenchLayoutService, this)`로 자기 자신을 서비스로 등록한다(`initServices`).
- 파트 인스턴스는 `Layout.registerPart(part)`로 `parts` 맵에 들어가고, `Layout.getPart(key)`가 꺼낸다. 등록 안 된 id는 `Unknown part` 오류다.

## 2. 창의 조립 순서

파일: `src/vs/workbench/browser/workbench.ts`, `src/vs/workbench/browser/layout.ts`

`Workbench.startup`의 호출 순서(소스 순서 그대로):

| 단계 | 호출 | 하는 일 |
| --- | --- | --- |
| 1 | `initServices` | 서비스 컬렉션 구성. `IWorkbenchLayoutService`로 자기 자신 등록. |
| 2 | `initLayout` (`Layout`) | 파트와 서비스 참조 확보, `initLayoutState`로 `LayoutStateModel` 생성. 이 시점에 기본값과 저장값이 합쳐진다. |
| 3 | 레지스트리 시작 | `IWorkbenchContributionsRegistry`, `IEditorFactoryRegistry`의 `start`, `WorkbenchContextKeysHandler` 생성. |
| 4 | `renderWorkbench` | `monaco-workbench` 클래스와 플랫폼 클래스를 붙이고, 파트 목록을 돌며 `createPart`로 컨테이너를 만든 뒤 `getPart(id).create(container, options)`를 부른다. 알림 핸들러를 만들고 `parent`에 붙인다. |
| 5 | `createWorkbenchLayout` (`Layout`) | `createGridDescriptor`가 만든 직렬화 그리드를 `SerializableGrid.deserialize`로 실체화하고 `mainContainer`에 prepend. |
| 6 | `layout` (`Layout`) | 컨테이너 크기를 재서 `workbenchGrid.layout(width, height)` 호출. |
| 7 | `restore` | `restoreParts`로 각 파트에 복원을 시키고, 이어서 라이프사이클을 `Restored` 단계로 넘긴다(느린 에디터는 최대 2초만 기다린다). |

각 단계의 세부:

- `renderWorkbench`의 파트 목록 순서: 제목 표시줄, 배너, 액티비티 바, 사이드바, (채팅, 등록된 경우만), 에디터, 패널, 보조 사이드바, 상태 표시줄. 에디터에는 `options: { restorePreviousState: this.willRestoreEditors() }`가 전달된다.
- `createPart(id, role, classes)`가 만드는 DOM: `div`(상태 표시줄만 `footer`), 클래스 `part` + 파트별 클래스, `id = partId`, `role` 속성. 역할은 `renderWorkbench`가 정한다: 제목 표시줄/액티비티 바/사이드바/패널은 `none`, 에디터는 `main`, 상태 표시줄은 `status`.
- 활성/사이드바 파트에는 `left`/`right` 클래스가 `getSideBarPosition()`으로, 패널에는 `positionToString(getPanelPosition())` 클래스가 붙는다.
- `createWorkbenchLayout`은 각 파트의 `onDidVisibilityChange`를 구독한다. 사이드바, 패널, 에디터가 스스로 보이거나 숨겨지면 `setSideBarHidden`, `setPanelHidden`, `setEditorHidden`으로 상태 모델을 맞춘다. 이어서 `_onDidChangePartVisibility`를 발사한다.
- `createWorkbenchLayout`은 `storageService.onWillSaveState`에서 사이드바/패널 크기를 `LayoutStateKeys.SIDEBAR_SIZE`, `PANEL_SIZE`에 되써 저장한다(숨겨져 있으면 `getViewCachedVisibleSize` 값을 쓴다).

## 3. 그리드 서술자: `createGridDescriptor`와 `arrangeMiddleSectionNodes`

파일: `src/vs/workbench/browser/layout.ts`

`createGridDescriptor`는 `ISerializedGrid`를 만든다. 루트는 `Orientation.VERTICAL` 브랜치다.

```
root (vertical branch)
 +- leaf  TITLEBAR_PART          size = titleBarPartView.minimumHeight
 +- leaf  BANNER_PART            (범위 밖, 항상 visible:false로 시작)
 +- branch middleSection         size = height - titleBar - statusBar
 |    +- (arrangeMiddleSectionNodes가 정하는 순서)
 +- leaf  STATUSBAR_PART         size = statusBarPartView.minimumHeight
```

- 각 leaf의 `visible`은 `LayoutStateKeys.*_HIDDEN`의 부정이다. 서술자 크기는 `getInitializationValue(SIDEBAR_SIZE / PANEL_SIZE)`에서 온다.
- 에디터 leaf의 `size`는 0으로 두고, `arrangeMiddleSectionNodes`가 "전체 너비 - 활동 바 - 사이드바 - 패널 - 보조 사이드바"로 채운다.

`arrangeMiddleSectionNodes`가 결정하는 것은 중간 섹션 안의 배치다(기준: `PANEL_POSITION`, `SIDEBAR_POSITON`, `PANEL_ALIGNMENT`).

| 조건 | 결과 |
| --- | --- |
| 패널이 세로 위치(`LEFT`/`RIGHT`) | 가로 한 줄: 에디터를 중심으로 패널을 해당 쪽에, 활동 바 + 사이드바를 `SIDEBAR_POSITON` 쪽에, 보조 사이드바를 반대쪽에 둔다. |
| 패널이 가로 위치(`TOP`/`BOTTOM`) | 에디터와 패널을 담는 브랜치를 만든다(`BOTTOM`이면 `[editorNodes, panel]`, `TOP`이면 `[panel, editorNodes]`). 사이드바/보조 사이드바가 에디터 옆에 붙을지 패널 바깥으로 빠질지는 `PANEL_ALIGNMENT`(`center`/`left`/`right`/`justify`)와 사이드바 위치로 정한다(`sideBarNextToEditor`, `auxiliaryBarNextToEditor`). |
| 활동 바 | 항상 가장자리: 사이드바가 왼쪽이면 맨 왼쪽, 오른쪽이면 맨 오른쪽. |

- 채팅 노드는 `insertChatNodeBesideEditor`가 넣으며 채팅 파트가 등록된 경우에만 존재한다. 범위 밖.
- `arrangeEditorNodes`가 에디터 옆에 사이드바/보조 사이드바를 같이 붙이는 보조 함수다.

## 4. 표시/숨김: `setPartHidden`과 `set...Hidden` 계열

파일: `src/vs/workbench/browser/layout.ts`

| 함수 | 하는 일 |
| --- | --- |
| `setPartHidden(hidden, part)` | `switch (part)`로 아래 함수에 위임. 제목 표시줄과 상태 표시줄은 이 스위치에 case가 없다(상태 표시줄은 비공개 `setStatusBarHidden`이 따로 다룬다). |
| `setActivityBarHidden` | `LayoutStateKeys.ACTIVITYBAR_HIDDEN` 갱신, `noactivitybar` 클래스 토글, 그리드 뷰 가시성 변경. |
| `setSideBarHidden` | `SIDEBAR_HIDDEN` 갱신, `nosidebar` 클래스, 그리드 가시성 변경. 숨길 때 활성 뷰 컨테이너를 닫고 `focusPanelOrEditor`로 포커스를 옮긴다. 다시 보일 때는 마지막 활성 컨테이너를 연다. |
| `setPanelHidden(hidden, skipLayout?)` | `PANEL_HIDDEN` 갱신, `nopanel` 클래스, 그리드 가시성 변경. 패널을 열 때 마지막 활성 패널(뷰가 있는 경우)이나 뷰가 있는 첫 패널 컨테이너를 연다. 숨길 때는 활성 패널을 닫고 에디터에 포커스를 준다. |
| `setEditorHidden` | `EDITOR_HIDDEN`, `nomaineditorarea` 클래스. 에디터와 패널은 동시에 숨길 수 없어서, 에디터를 숨기면 패널이 숨겨져 있을 때 패널을 연다(최대화 보조 사이드바나 채팅이 있으면 예외). |
| `setStatusBarHidden` | `STATUSBAR_HIDDEN` 갱신, `nostatusbar` 클래스, 그리드 가시성 변경. |
| `getLayoutClasses` | 위 상태를 `nosidebar`, `nopanel` 등의 클래스 목록으로 환산. `renderWorkbench`가 첫 렌더에 쓴다. |

- 가시성 변경 공통 순서: 상태 모델 `setRuntimeValue` -> `mainContainer` 클래스 토글 -> `workbenchGrid.setViewVisible(view, visible)` -> `_onDidChangePartVisibility` 발사.
- 전체 상태 키는 `LayoutStateKeys`(같은 파일, 비공개 `const`). 이 페이지와 관련된 키의 기본값은 아래 표에 있다.

### 시작 시 패널이 숨겨져 있다

`LayoutStateKeys.PANEL_HIDDEN`은 `new RuntimeStateKey<boolean>('panel.hidden', StorageScope.WORKSPACE, StorageTarget.MACHINE, true)`로 기본값이 `true`다. 즉 처음 여는 창에서 패널은 숨겨져 있고, 사용자가 연 뒤에는 `WORKSPACE` 범위로 저장된다. 사이드바(`SIDEBAR_HIDDEN`, 기본 `false`)와 상태 표시줄(`STATUSBAR_HIDDEN`, 기본 `false`)은 보이는 채로 시작한다.

## 5. 파트란 무엇인가: `Part`와 다섯 구체 파트

파일: `src/vs/workbench/browser/part.ts`

`Part<MementoType>`는 `Component<MementoType>`를 상속하고 `ISerializableView`를 구현하는 추상 클래스다.

| 멤버 | 의미 |
| --- | --- |
| `create(parent, options?)` | DOM 생성. 내부에서 `createTitleArea`/`createContentArea`를 부른다. |
| `minimumWidth`, `maximumWidth`, `minimumHeight`, `maximumHeight` | 추상 속성. 그리드가 `IView` 제약으로 읽는다. 크기 표의 출처. |
| `layout(width, height, top, left)` | 그리드가 할당한 칸을 받아 `dimension`, `contentPosition`을 기록. 하위 클래스가 오버라이드해 내용을 다시 배치. |
| `setVisible(visible)` | `onDidVisibilityChange` 발사. |
| `toJSON()` | `{ type: Parts.X }`. 그리드 직렬화에서 파트를 식별. 역직렬화는 `createWorkbenchLayout`의 `fromJSON`이 `type`으로 `viewMap`을 찾는다. |
| `onDidVisibilityChange` | `Layout`이 구독하는 이벤트. |

파트별 구체 클래스:

| 파트 | 클래스와 파일 | 비고 |
| --- | --- | --- |
| 제목 표시줄 | `BrowserTitlebarPart`, `MainBrowserTitlebarPart` (`src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`) | `WindowTitle`(`windowTitle.ts`), `CommandCenterControl`(`commandCenterControl.ts`), `CustomMenubarControl`(`menubarControl.ts`)를 포함. 메뉴 바는 [vscode-menus-commands.md](vscode-menus-commands.md). |
| 액티비티 바 | `ActivitybarPart` (`src/vs/workbench/browser/parts/activitybar/activitybarPart.ts`) | `PaneCompositeBar`(`src/vs/workbench/browser/parts/paneCompositeBar.ts`)로 뷰 컨테이너 아이콘을 그린다. `AbstractPaneCompositePart`가 아니라 `Part`를 상속. |
| 사이드바 | `SidebarPart` (`src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`) | `AbstractPaneCompositePart`(`src/vs/workbench/browser/parts/paneCompositePart.ts`) 상속. 뷰 컨테이너를 탑재. |
| 에디터 | `EditorPart`, `MainEditorPart` (`src/vs/workbench/browser/parts/editor/editorPart.ts`) | 내부는 [vscode-editor-groups.md](vscode-editor-groups.md). |
| 패널 | `PanelPart` (`src/vs/workbench/browser/parts/panel/panelPart.ts`) | `AbstractPaneCompositePart` 상속. |
| 상태 표시줄 | `MainStatusbarPart` (`src/vs/workbench/browser/parts/statusbar/statusbarPart.ts`) | 베이스 `StatusbarPart`(비공개)가 `addEntry(entry, id, alignment, priority)`를 제공. |

- 사이드바와 패널은 같은 `AbstractPaneCompositePart` + `CompositePart`(`src/vs/workbench/browser/parts/compositePart.ts`) 구조다. 다른 점은 위치와 크기 제약뿐이며, 어느 뷰 컨테이너가 어디 있는지는 뷰 컨테이너 위치(6절)가 정한다.
- 이 커밋의 파트 상속 구조는 `Part` -> `CompositePart` -> `AbstractPaneCompositePart` -> `SidebarPart`/`PanelPart`이고 활동 바와 상태 표시줄, 제목 표시줄은 `Part` 직계다.

## 6. 엔진: 그리드, 분할 뷰, 새시

가장 아래 계층이다. 파트는 이 계층의 `IView`로만 보인다.

| 계층 | 파일 | 심볼 | 역할 |
| --- | --- | --- | --- |
| `Grid` | `src/vs/base/browser/ui/grid/grid.ts` | `Grid`, `SerializableGrid`, `getRelativeLocation`, `Direction` | `Grid`는 방향(`Direction.Up/Down/Left/Right`)과 기준 뷰로 `addView`, `moveView`, `swapViews`, `removeView`, `resizeView`, `setViewVisible`, `maximizeView`를 노출. `getRelativeLocation(rootOrientation, location, direction)`은 "이 위치에서 이 방향"을 그리드 좌표(`GridLocation`)로 바꾼다. `SerializableGrid`는 `serialize()`와 정적 `deserialize`를 더해 `ISerializedGrid`(`root`, `orientation`, `width`, `height`)로 왕복한다. |
| `GridView` | `src/vs/base/browser/ui/grid/gridview.ts` | `GridView`, `BranchNode`, `LeafNode`, `IView`, `ISerializableView` | 트리 자료구조. `BranchNode`(비공개)는 자식 목록을 담고 방향이 교대로 바뀌는 `SplitView`를 하나 갖는다. `LeafNode`(비공개)는 `IView` 하나를 감싼다. `orthogonal(orientation)`이 교대를 계산. `GridView.layout(width, height)`가 루트부터 칸을 내려보낸다. |
| `SplitView` | `src/vs/base/browser/ui/splitview/splitview.ts` | `SplitView`, `Sizing`, `LayoutPriority`, `IView` | 한 방향의 선형 분할. `IView`는 `minimumSize`, `maximumSize`, `priority`, `snap`, `proportionalLayout`, `layout`을 요구. `Sizing`은 뷰를 넣거나 뺄 때 크기 정책: `Distribute`, `Split(index)`, `Auto(index)`, `Invisible(cachedVisibleSize)`. `LayoutPriority`는 `Normal`, `Low`, `High`이며, `proportionalLayout`이 꺼져 있을 때 컨테이너 크기가 변하면 `High` 뷰가 먼저 늘고 줄어든다. |
| `Sash` | `src/vs/base/browser/ui/sash/sash.ts` | `Sash`, `SashState`, `ISashEvent`, `setGlobalSashSize` | 뷰 사이의 드래그 손잡이. `onDidStart/onDidChange/onDidEnd/onDidReset` 이벤트(`onDidReset`은 더블 클릭 초기화). `orthogonalStartSash`로 직교 새시와 모서리를 공유. 전역 굵기는 `setGlobalSashSize`(기본 4)로 정한다. |

워크벤치가 쓰는 방식:

- `createWorkbenchLayout`이 `SerializableGrid.deserialize(this.createGridDescriptor(), { fromJSON }, { proportionalLayout: false })`로 그리드를 만든다. 즉 창 크기가 바뀌면 비례 분배가 아니라 `LayoutPriority`로 흡수한다(에디터가 `High`라서 창 크기 변화를 대부분 에디터가 흡수).
- `workbenchGrid.edgeSnapping`은 전체 화면 상태(`mainWindowFullscreen`)에 맞춰 켜진다.
- 새시 굵기: `src/vs/workbench/contrib/sash/browser/sash.ts`가 설정 `workbench.sash.size`를 읽어 4~20으로 clamp해 CSS 변수 `--vscode-sash-size`를 쓰고, 호버 크기는 1~8로 clamp한다.

## 7. 뷰 컨테이너와 그 위치

사이드바와 패널은 내용물을 직접 정하지 않는다. 어떤 뷰 컨테이너가 어디에 있는지는 레지스트리와 서비스가 정한다.

| 심볼 | 파일 | 결정하는 것 |
| --- | --- | --- |
| `ViewContainerLocation` (`Sidebar`, `Panel`, `AuxiliaryBar`) | `src/vs/workbench/common/views.ts` | 컨테이너가 놓일 수 있는 위치. `ViewContainerLocationToString`이 `sidebar`/`panel`/`auxiliarybar` 문자열로 변환. |
| `Extensions.ViewContainersRegistry`, `IViewContainersRegistry.registerViewContainer(descriptor, location, options?)` | `src/vs/workbench/common/views.ts` | 뷰 컨테이너 등록과 기본 위치. `getViewContainerLocation(container)`가 등록 시점 위치를 돌려준다. |
| `Extensions.ViewsRegistry`, `IViewsRegistry.registerViews(views, viewContainer)` | `src/vs/workbench/common/views.ts` | 뷰를 컨테이너에 붙인다. |
| `ViewDescriptorService` | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` | 기본 위치 위에 사용자 커스터마이징을 얹은 현재 위치. |
| `getViewContainerLocation(container)` | 같은 파일 | `viewContainersCustomLocations`의 값이 있으면 그것, 없으면 `getDefaultViewContainerLocation`. |
| `moveViewContainerToLocation(container, location, requestedIndex?, reason?)` | 같은 파일 | 컨테이너 이동 후 `saveViewCustomizations`로 저장. `canMoveViews()`가 거짓이면 아무것도 안 한다. |
| `moveViewToLocation(view, location, reason?)` | 같은 파일 | 뷰 하나를 새 컨테이너로 이동. |

- 저장: `VIEWS_CUSTOMIZATIONS = 'views.customizations'`을 `StorageScope.PROFILE`, `StorageTarget.USER`에 쓴다. 옛 키 `views.cachedViewContainerLocations`, `views.cachedViewPositions`는 읽어서 이관하고 지운다. 저장 위치와 두 탭 동기화는 [vscode-state-settings.md](vscode-state-settings.md).
- 드래그: `CompositeDragAndDrop`(`src/vs/workbench/browser/parts/compositeBar.ts`)의 `drop`이 갈림길이다. 같은 위치의 바면 `moveComposite`(순서 변경), 다른 위치의 바면 `moveViewContainerToLocation(..., 'dnd')`. 뷰를 끌어온 경우 `canMoveView`가 참일 때만 `moveViewToLocation`. 이동 후 `openComposite`로 연다.
- 드래그 데이터와 수신 등록은 `CompositeDragAndDropData`, `CompositeDragAndDropObserver`(`registerTarget`, `registerDraggable`) (`src/vs/workbench/browser/dnd.ts`). 드롭 가능 여부는 `canDrop`이 정한다.
- 확장이 컨테이너와 뷰를 기여하는 방법은 [vscode-extensions.md](vscode-extensions.md)의 `viewsContainers`/`views`.

## 8. 크기와 제약

| 파트 | 최소 | 최대 | 우선순위/스냅 | 출처 |
| --- | --- | --- | --- | --- |
| 제목 표시줄 | 높이: 명령 센터 표시 중이거나 윈도 컨트롤 오버레이(WCO)면 `DEFAULT_CUSTOM_TITLEBAR_HEIGHT`(35), 아니면 30 | 높이 = 최소 높이. 너비 `0` ~ 무한 | - | `BrowserTitlebarPart.minimumHeight`, `DEFAULT_CUSTOM_TITLEBAR_HEIGHT`(`src/vs/platform/window/common/window.ts`) |
| 활동 바 | 너비: `ActivitybarPart.ACTIVITYBAR_WIDTH` 48(컴팩트 36) | 너비 = 최소 너비(고정). 높이 `0` ~ 무한 | - | `ActivitybarPart.minimumWidth`/`maximumWidth`, `ACTIVITYBAR_WIDTH`, `COMPACT_ACTIVITYBAR_WIDTH` |
| 활동 바 항목 높이 | 48(컴팩트 28) | - | - | `ActivitybarPart.ACTION_HEIGHT`, `COMPACT_ACTION_HEIGHT` |
| 사이드바 | 너비 170 | 무한 | `LayoutPriority.Low`, `snap` = `true`(닫힘으로 스냅) | `SidebarPart.minimumWidth`, `priority`, `snap` |
| 에디터 | 너비/높이: 중앙 정렬 위젯의 최소와 `getMaximumEditorDimensions`의 작은 쪽. 에디터 그룹 기본 최소는 220 x 70 | 중앙 정렬 위젯의 최대 | `LayoutPriority.High`, `snap` = 패널 정렬이 `center`일 때만 | `EditorPart.minimumWidth`, `priority`, `snap`, `DEFAULT_EDITOR_MIN_DIMENSIONS`(`src/vs/workbench/browser/parts/editor/editor.ts`) |
| 패널 | 너비 300, 높이 77 | 무한 | 우선순위 지정 없음(`Normal`), `snap`은 `AbstractPaneCompositePart.snap`(보이거나 보이는 컨테이너가 있을 때) | `PanelPart.minimumWidth`/`minimumHeight` |
| 상태 표시줄 | 높이 `StatusbarPart.HEIGHT` 22 | 높이 = 최소 높이 | - | `StatusbarPart.HEIGHT`, `minimumHeight`, `maximumHeight` |
| 보조 사이드바(범위 밖) | 너비 170 | 무한 | `Low` | `AuxiliaryBarPart` |

초기 크기(저장값이 없을 때):

| 항목 | 기본값 | 출처 |
| --- | --- | --- |
| 사이드바 너비 | `Math.min(300, 창 너비 / 4)` | `LayoutStateModel`의 동적 기본값(`LayoutStateKeys.SIDEBAR_SIZE.defaultValue`) |
| 패널 크기 | 가로 위치면 `창 높이 / 3`, 세로 위치면 `창 너비 / 4` | `LayoutStateKeys.PANEL_SIZE.defaultValue` |
| 패널 위치 | `bottom`(설정 `WorkbenchLayoutSettings.PANEL_POSITION`) | `LayoutStateKeys.PANEL_POSITION` |
| 사이드바 위치 | `Position.LEFT`(레거시 설정 `LegacyWorkbenchLayoutSettings.SIDEBAR_POSITION`) | `LayoutStateKeys.SIDEBAR_POSITON` |
| 사이드바 숨김 | 빈 창(`WorkbenchState.EMPTY`)이면 `true`, 아니면 `false` | `LayoutStateKeys.SIDEBAR_HIDDEN.defaultValue` |
| 패널 숨김 | `true` | `LayoutStateKeys.PANEL_HIDDEN` |
| 패널 정렬 | `center` | `LayoutStateKeys.PANEL_ALIGNMENT` |

- 새시 굵기: 기본 4 (`src/vs/base/browser/ui/sash/sash.ts`의 `globalSize`), 설정으로 4~20 (6절).
- 창 크기 폴백: `Layout.layout`이 `getClientArea`에 `DEFAULT_EMPTY_WINDOW_DIMENSIONS`/`DEFAULT_WORKSPACE_WINDOW_DIMENSIONS`를 넘겨 DOM이 아직 0일 때를 흡수한다.

## 9. 이 워크벤치에 주는 시사점

이 절은 사실이 아니라 해석이다. 대응 규칙: VS Code의 `src/vs/<path>`가 여기서는 `src/<path>`.

- 한 곳에서 파트 id와 가시성을 관리하는 서비스(`IWorkbenchLayoutService` 역할)를 두면 메뉴, 단축키, 상태 저장이 파트 인스턴스를 몰라도 된다.
- 그리드는 "직렬화 가능한 트리 + 파트별 최소/최대/우선순위"로 분리된다. 창 크기 변화를 에디터가 흡수하게 하려면 `proportionalLayout: false`와 에디터 `High` 우선순위가 함께 필요하다.
- v0.1.0이 패널을 보이는 채로 시작하면 VS Code와 다르다(`LayoutStateKeys.PANEL_HIDDEN` 기본 `true`). 그 차이는 `docs/architecture.md`의 `### Layout and parts`에 적는다.
- 상태 저장 방식(VS Code는 IndexedDB 위에 저장소를 둔다)과 설정은 [vscode-state-settings.md](vscode-state-settings.md).

Decided in: wr-e8v6
