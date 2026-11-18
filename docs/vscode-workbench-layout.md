# VS Code 워크벤치 레이아웃

고정 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`를 바탕으로 VS Code가 창을 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄)로 조립하고, 각 파트의 크기와 표시 여부를 관리하는 방식을 정리한다. 개요는 [README.md](README.md), 대응 규칙과 차이점은 [architecture.md](architecture.md), 에디터 파트 내부는 [vscode-editor-groups.md](vscode-editor-groups.md), 저장되는 레이아웃 상태는 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다.

## 범위

- 다루는 내용: 제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄.
- 이 커밋의 레이아웃 코드에는 보조 사이드바(`AUXILIARYBAR_PART`), 배너, 채팅(`CHAT_PART`), 세션(`SESSIONS_PART`), 커스텀 뷰 그리드(`CUSTOM_VIEW_GRID_PART`), 플로팅 패널 및 모던 UI 클래스도 포함되어 있다. v0.1.0에서는 이를 구현하지 않으므로 범위에서 제외하며 이름만 표기한다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드 역시 제외한다.

## 1. 파트의 식별: `Parts`와 `IWorkbenchLayoutService`

파일: `src/vs/workbench/services/layout/browser/layoutService.ts`

| 심볼 | 결정하는 것 |
| --- | --- |
| `Parts` (`const enum`) | 파트 id 문자열. 여섯 파트는 `TITLEBAR_PART`(`workbench.parts.titlebar`), `ACTIVITYBAR_PART`, `SIDEBAR_PART`, `EDITOR_PART`, `PANEL_PART`, `STATUSBAR_PART`이다. 이 id가 DOM `id`, 그리드 직렬화의 `type`, 가시성 이벤트의 `partId`에 그대로 쓰인다. |
| `IWorkbenchLayoutService` | 파트를 다루는 유일한 창구. 다른 코드는 파트 인스턴스를 직접 참조하지 않고 이 서비스를 사용한다. |
| `isVisible(part)` | 파트 가시성 조회. 구현체는 `Layout.isVisible`이며 파트별 `LayoutStateKeys.*_HIDDEN` 값을 읽는다. |
| `setPartHidden(hidden, part)` | 파트 표시/숨김 변경. 구현체는 `Layout.setPartHidden`이다. |
| `focusPart`, `hasFocus`, `getContainer` | 포커스 이동과 파트 DOM 컨테이너 조회. |
| `getSideBarPosition`, `getPanelPosition`, `setPanelPosition` | 사이드바(좌/우)와 패널(상/하/좌/우) 위치. 값은 `Position` (`LEFT`, `RIGHT`, `BOTTOM`, `TOP`)이며 `isHorizontal`로 상/하 여부를 판별한다. |
| `toggleMaximizedPanel`, `isPanelMaximized`, `centerMainEditorLayout` | 패널 최대화, 에디터 가운데 정렬. |

- `Workbench`(`src/vs/workbench/browser/workbench.ts`)가 `Layout`을 상속하고 `serviceCollection.set(IWorkbenchLayoutService, this)`로 자기 자신을 서비스로 등록한다(`initServices`).
- 파트 인스턴스는 `Layout.registerPart(part)`를 통해 `parts` 맵에 등록되며, `Layout.getPart(key)`로 조회한다. 등록되지 않은 id를 조회하면 `Unknown part` 오류가 발생한다.

## 2. 창의 조립 순서

파일: `src/vs/workbench/browser/workbench.ts`, `src/vs/workbench/browser/layout.ts`

`Workbench.startup`의 호출 순서(소스 코드 순서 그대로):

| 단계 | 호출 | 하는 일 |
| --- | --- | --- |
| 1 | `initServices` | 서비스 컬렉션 구성. `IWorkbenchLayoutService`로 자기 자신 등록. |
| 2 | `initLayout` (`Layout`) | 파트와 서비스 참조 확보, `initLayoutState`로 `LayoutStateModel` 생성. 이 시점에 기본값과 저장값이 병합된다. |
| 3 | 레지스트리 시작 | `IWorkbenchContributionsRegistry`, `IEditorFactoryRegistry`의 `start`, `WorkbenchContextKeysHandler` 생성. |
| 4 | `renderWorkbench` | `monaco-workbench` 클래스와 플랫폼 클래스를 추가하고, 파트 목록을 순회하며 `createPart`로 컨테이너를 생성한 뒤 `getPart(id).create(container, options)`를 호출한다. 알림 핸들러를 생성하여 `parent`에 추가한다. |
| 5 | `createWorkbenchLayout` (`Layout`) | `createGridDescriptor`가 생성한 직렬화 그리드를 `SerializableGrid.deserialize`로 실체화하여 `mainContainer`의 맨 앞에 삽입(prepend)한다. |
| 6 | `layout` (`Layout`) | 컨테이너 크기를 측정하여 `workbenchGrid.layout(width, height)` 호출. |
| 7 | `restore` | `restoreParts`로 각 파트를 복원하고 라이프사이클을 `Restored` 단계로 전환한다(지연되는 에디터는 최대 2초 동안만 대기한다). |

각 단계의 세부 사항:

- `renderWorkbench`의 파트 목록 순서: 제목 표시줄, 배너, 액티비티 바, 사이드바, (채팅, 등록된 경우만), 에디터, 패널, 보조 사이드바, 상태 표시줄 순이다. 에디터에는 `options: { restorePreviousState: this.willRestoreEditors() }`가 전달된다.
- `createPart(id, role, classes)`가 생성하는 DOM: `div`(상태 표시줄만 `footer`), `part` 클래스 및 파트별 클래스, `id = partId`, `role` 속성으로 구성된다. 역할(role)은 `renderWorkbench`가 결정한다: 제목 표시줄/액티비티 바/사이드바/패널은 `none`, 에디터는 `main`, 상태 표시줄은 `status`다.
- 활성/사이드바 파트에는 `left`/`right` 클래스가 `getSideBarPosition()`으로, 패널에는 `positionToString(getPanelPosition())` 클래스가 붙는다.
- `createWorkbenchLayout`은 각 파트의 `onDidVisibilityChange`를 구독한다. 사이드바, 패널, 에디터가 자체적으로 표시되거나 숨겨지면 `setSideBarHidden`, `setPanelHidden`, `setEditorHidden`으로 상태 모델을 동기화한다. 이어서 `_onDidChangePartVisibility` 이벤트를 발생시킨다.
- `createWorkbenchLayout`은 `storageService.onWillSaveState` 시점에 사이드바와 패널 크기를 `LayoutStateKeys.SIDEBAR_SIZE`, `PANEL_SIZE`에 덮어써 저장한다(숨겨진 상태라면 `getViewCachedVisibleSize` 값을 사용한다).

## 3. 그리드 서술자: `createGridDescriptor`와 `arrangeMiddleSectionNodes`

파일: `src/vs/workbench/browser/layout.ts`

`createGridDescriptor`는 `ISerializedGrid`를 생성한다. 루트는 `Orientation.VERTICAL` 브랜치다.

```
root (vertical branch)
 +- leaf  TITLEBAR_PART          size = titleBarPartView.minimumHeight
 +- leaf  BANNER_PART            (범위 밖, 항상 visible:false로 시작)
 +- branch middleSection         size = height - titleBar - statusBar
 |    +- (arrangeMiddleSectionNodes가 정하는 순서)
 +- leaf  STATUSBAR_PART         size = statusBarPartView.minimumHeight
```

- 각 leaf의 `visible`은 `LayoutStateKeys.*_HIDDEN`의 부정(NOT) 값이다. 서술자 크기는 `getInitializationValue(SIDEBAR_SIZE / PANEL_SIZE)`에서 가져온다.
- 에디터 leaf의 `size`는 처음에 0으로 설정되며, `arrangeMiddleSectionNodes`가 "전체 너비 - 액티비티 바 - 사이드바 - 패널 - 보조 사이드바"를 계산해 채운다.

`arrangeMiddleSectionNodes`는 중간 섹션 내부의 배치를 결정한다(기준: `PANEL_POSITION`, `SIDEBAR_POSITON`, `PANEL_ALIGNMENT`).

| 조건 | 결과 |
| --- | --- |
| 패널이 세로 위치(`LEFT`/`RIGHT`) | 가로 한 줄: 에디터를 중심으로 패널을 해당 위치에 두고, 액티비티 바 + 사이드바를 `SIDEBAR_POSITON` 쪽에, 보조 사이드바를 반대쪽에 배치한다. |
| 패널이 가로 위치(`TOP`/`BOTTOM`) | 에디터와 패널을 포함하는 브랜치를 생성한다(`BOTTOM`이면 `[editorNodes, panel]`, `TOP`이면 `[panel, editorNodes]`). 사이드바/보조 사이드바가 에디터 옆에 나란히 붙을지 패널 바깥으로 빠질지는 `PANEL_ALIGNMENT`(`center`/`left`/`right`/`justify`)와 사이드바 위치(`sideBarNextToEditor`, `auxiliaryBarNextToEditor`)로 결정한다. |
| 액티비티 바 | 항상 가장자리에 위치한다: 사이드바가 왼쪽이면 맨 왼쪽, 오른쪽이면 맨 오른쪽에 둔다. |

- 채팅 노드는 `insertChatNodeBesideEditor`가 삽입하며 채팅 파트가 등록된 경우에만 존재한다. 범위 밖이다.
- `arrangeEditorNodes`는 에디터 옆에 사이드바와 보조 사이드바를 나란히 배치하는 보조 함수다.

## 4. 표시/숨김: `setPartHidden`과 `set...Hidden` 계열

파일: `src/vs/workbench/browser/layout.ts`

| 함수 | 하는 일 |
| --- | --- |
| `setPartHidden(hidden, part)` | `switch (part)` 구문으로 아래 개별 함수에 처리를 위임한다. 제목 표시줄과 상태 표시줄은 이 switch 구문에 case가 없다(상태 표시줄은 비공개 함수 `setStatusBarHidden`이 별도로 처리한다). |
| `setActivityBarHidden` | `LayoutStateKeys.ACTIVITYBAR_HIDDEN` 갱신, `noactivitybar` 클래스 토글, 그리드 뷰 가시성 변경. |
| `setSideBarHidden` | `SIDEBAR_HIDDEN` 갱신, `nosidebar` 클래스 토글, 그리드 가시성 변경. 숨길 때는 활성 뷰 컨테이너를 닫고 `focusPanelOrEditor`로 포커스를 이동한다. 다시 표시할 때는 마지막 활성 컨테이너를 연다. |
| `setPanelHidden(hidden, skipLayout?)` | `PANEL_HIDDEN` 갱신, `nopanel` 클래스 토글, 그리드 가시성 변경. 패널을 열 때는 마지막 활성 패널(뷰가 존재하는 경우)이나 뷰가 포함된 첫 번째 패널 컨테이너를 연다. 숨길 때는 활성 패널을 닫고 에디터에 포커스를 부여한다. |
| `setEditorHidden` | `EDITOR_HIDDEN` 갱신, `nomaineditorarea` 클래스 토글. 에디터와 패널은 동시에 숨길 수 없으므로, 에디터를 숨길 때 패널이 숨겨져 있다면 패널을 강제로 연다(최대화된 보조 사이드바나 채팅이 있는 경우는 예외). |
| `setStatusBarHidden` | `STATUSBAR_HIDDEN` 갱신, `nostatusbar` 클래스 토글, 그리드 가시성 변경. |
| `getLayoutClasses` | 위 상태들을 종합하여 `nosidebar`, `nopanel` 등의 클래스 목록으로 변환. `renderWorkbench`가 초기 렌더링에 사용한다. |

- 가시성 변경 공통 처리 순서: 상태 모델 `setRuntimeValue` -> `mainContainer` 클래스 토글 -> `workbenchGrid.setViewVisible(view, visible)` -> `_onDidChangePartVisibility` 이벤트 발생.
- 전체 상태 키는 `LayoutStateKeys`(동일 파일 내 비공개 `const`)에 정의되어 있다. 본 문서와 관련된 키의 기본값은 아래 표와 같다.

### 시작 시 패널이 숨겨져 있다

`LayoutStateKeys.PANEL_HIDDEN`은 `new RuntimeStateKey<boolean>('panel.hidden', StorageScope.WORKSPACE, StorageTarget.MACHINE, true)`로 선언되어 기본값이 `true`다. 즉 새로 여는 창에서 패널은 기본적으로 숨겨져 있으며, 사용자가 한 번 연 뒤에는 `WORKSPACE` 범위로 상태가 저장된다. 반면 사이드바(`SIDEBAR_HIDDEN`, 기본 `false`)와 상태 표시줄(`STATUSBAR_HIDDEN`, 기본 `false`)은 표시된 상태로 시작한다.

## 5. 파트란 무엇인가: `Part`와 다섯 구체 파트

파일: `src/vs/workbench/browser/part.ts`

`Part<MementoType>`는 `Component<MementoType>`를 상속하고 `ISerializableView`를 구현하는 추상 클래스다.

| 멤버 | 의미 |
| --- | --- |
| `create(parent, options?)` | DOM 생성. 내부에서 `createTitleArea`/`createContentArea`를 호출한다. |
| `minimumWidth`, `maximumWidth`, `minimumHeight`, `maximumHeight` | 추상 속성. 그리드가 `IView` 제약으로 읽는다. 크기 표의 출처. |
| `layout(width, height, top, left)` | 그리드가 할당한 공간을 받아 `dimension`, `contentPosition`을 기록. 하위 클래스가 오버라이드하여 내부 요소를 재배치한다. |
| `setVisible(visible)` | `onDidVisibilityChange` 이벤트 발생. |
| `toJSON()` | `{ type: Parts.X }`. 그리드 직렬화에서 파트를 식별한다. 역직렬화는 `createWorkbenchLayout`의 `fromJSON`이 `type`으로 `viewMap`을 찾는다. |
| `onDidVisibilityChange` | `Layout`이 구독하는 이벤트. |

파트별 구체 클래스:

| 파트 | 클래스와 파일 | 비고 |
| --- | --- | --- |
| 제목 표시줄 | `BrowserTitlebarPart`, `MainBrowserTitlebarPart` (`src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`) | `WindowTitle`(`windowTitle.ts`), `CommandCenterControl`(`commandCenterControl.ts`), `CustomMenubarControl`(`menubarControl.ts`)를 포함. 메뉴 바는 [vscode-menus-commands.md](vscode-menus-commands.md). |
| 액티비티 바 | `ActivitybarPart` (`src/vs/workbench/browser/parts/activitybar/activitybarPart.ts`) | `PaneCompositeBar`(`src/vs/workbench/browser/parts/paneCompositeBar.ts`)로 뷰 컨테이너 아이콘을 렌더링한다. `AbstractPaneCompositePart`가 아니라 `Part`를 상속한다. |
| 사이드바 | `SidebarPart` (`src/vs/workbench/browser/parts/sidebar/sidebarPart.ts`) | `AbstractPaneCompositePart`(`src/vs/workbench/browser/parts/paneCompositePart.ts`) 상속. 뷰 컨테이너를 탑재. |
| 에디터 | `EditorPart`, `MainEditorPart` (`src/vs/workbench/browser/parts/editor/editorPart.ts`) | 내부는 [vscode-editor-groups.md](vscode-editor-groups.md). |
| 패널 | `PanelPart` (`src/vs/workbench/browser/parts/panel/panelPart.ts`) | `AbstractPaneCompositePart` 상속. |
| 상태 표시줄 | `MainStatusbarPart` (`src/vs/workbench/browser/parts/statusbar/statusbarPart.ts`) | 기본 클래스 `StatusbarPart`(비공개)가 `addEntry(entry, id, alignment, priority)`를 제공. |

- 사이드바와 패널은 동일한 `AbstractPaneCompositePart` + `CompositePart`(`src/vs/workbench/browser/parts/compositePart.ts`) 구조다. 다른 점은 위치와 크기 제약뿐이며, 어느 뷰 컨테이너가 어디에 배치되는지는 뷰 컨테이너 위치(6절)가 결정한다.
- 이 커밋의 파트 상속 구조는 `Part` -> `CompositePart` -> `AbstractPaneCompositePart` -> `SidebarPart`/`PanelPart`이며 액티비티 바, 상태 표시줄, 제목 표시줄은 `Part`를 직접 상속한다.

## 6. 엔진: 그리드, 분할 뷰, 새시

가장 하위 계층이다. 파트는 이 계층에서 `IView`의 형태로만 인식된다.

| 계층 | 파일 | 심볼 | 역할 |
| --- | --- | --- | --- |
| `Grid` | `src/vs/base/browser/ui/grid/grid.ts` | `Grid`, `SerializableGrid`, `getRelativeLocation`, `Direction` | `Grid`는 방향(`Direction.Up/Down/Left/Right`)과 기준 뷰를 바탕으로 `addView`, `moveView`, `swapViews`, `removeView`, `resizeView`, `setViewVisible`, `maximizeView`를 노출한다. `getRelativeLocation(rootOrientation, location, direction)`은 "특정 위치 기준 특정 방향"을 그리드 좌표(`GridLocation`)로 변환한다. `SerializableGrid`는 `serialize()`와 정적 `deserialize`를 추가해 `ISerializedGrid`(`root`, `orientation`, `width`, `height`) 형태로 상호 변환한다. |
| `GridView` | `src/vs/base/browser/ui/grid/gridview.ts` | `GridView`, `BranchNode`, `LeafNode`, `IView`, `ISerializableView` | 트리 자료구조. `BranchNode`(비공개)는 자식 목록을 담고 방향이 교대로 전환되는 `SplitView`를 하나 갖는다. `LeafNode`(비공개)는 `IView` 하나를 감싼다. `orthogonal(orientation)`이 방향 전환을 계산한다. `GridView.layout(width, height)`가 루트부터 각 칸의 크기를 내려보낸다. |
| `SplitView` | `src/vs/base/browser/ui/splitview/splitview.ts` | `SplitView`, `Sizing`, `LayoutPriority`, `IView` | 단일 축 방향의 선형 분할. `IView`는 `minimumSize`, `maximumSize`, `priority`, `snap`, `proportionalLayout`, `layout`을 요구한다. `Sizing`은 뷰를 추가하거나 제거할 때의 크기 정책(`Distribute`, `Split(index)`, `Auto(index)`, `Invisible(cachedVisibleSize)`)을 정의한다. `LayoutPriority`는 `Normal`, `Low`, `High`로 나뉘며, `proportionalLayout`이 비활성화되어 있을 때 컨테이너 크기가 변하면 `High` 뷰가 먼저 늘어나거나 줄어든다. |
| `Sash` | `src/vs/base/browser/ui/sash/sash.ts` | `Sash`, `SashState`, `ISashEvent`, `setGlobalSashSize` | 뷰 사이의 드래그 핸들. `onDidStart/onDidChange/onDidEnd/onDidReset` 이벤트(`onDidReset`은 더블 클릭 초기화)를 제공한다. `orthogonalStartSash`로 직교 새시와 모서리를 공유한다. 전역 굵기는 `setGlobalSashSize`(기본값 4)로 설정한다. |

워크벤치가 사용하는 방식:

- `createWorkbenchLayout`이 `SerializableGrid.deserialize(this.createGridDescriptor(), { fromJSON }, { proportionalLayout: false })`로 그리드를 생성한다. 즉 창 크기가 변할 때 비례 분배하는 대신 `LayoutPriority`로 흡수한다(에디터가 `High`이므로 창 크기 변화를 대부분 에디터가 흡수).
- `workbenchGrid.edgeSnapping`은 전체 화면 상태(`mainWindowFullscreen`)에 맞춰 활성화된다.
- 새시 굵기: `src/vs/workbench/contrib/sash/browser/sash.ts`가 `workbench.sash.size` 설정을 읽어 4~20으로 제한(clamp)한 뒤 CSS 변수 `--vscode-sash-size`에 적용하며, 호버 크기는 1~8로 제한한다.

## 7. 뷰 컨테이너와 그 위치

사이드바와 패널은 내부 콘텐츠를 직접 결정하지 않는다. 어떤 뷰 컨테이너가 어디에 배치되는지는 레지스트리와 서비스가 결정한다.

| 심볼 | 파일 | 결정하는 것 |
| --- | --- | --- |
| `ViewContainerLocation` (`Sidebar`, `Panel`, `AuxiliaryBar`) | `src/vs/workbench/common/views.ts` | 컨테이너가 놓일 수 있는 위치. `ViewContainerLocationToString`이 `sidebar`/`panel`/`auxiliarybar` 문자열로 변환. |
| `Extensions.ViewContainersRegistry`, `IViewContainersRegistry.registerViewContainer(descriptor, location, options?)` | `src/vs/workbench/common/views.ts` | 뷰 컨테이너 등록과 기본 위치 지정. `getViewContainerLocation(container)`가 등록 시점의 위치를 반환한다. |
| `Extensions.ViewsRegistry`, `IViewsRegistry.registerViews(views, viewContainer)` | `src/vs/workbench/common/views.ts` | 뷰를 컨테이너에 등록. |
| `ViewDescriptorService` | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` | 기본 위치 위에 사용자 맞춤 설정을 반영한 현재 위치 관리. |
| `getViewContainerLocation(container)` | 같은 파일 | `viewContainersCustomLocations`에 값이 있으면 그 값을, 없으면 `getDefaultViewContainerLocation`을 반환. |
| `moveViewContainerToLocation(container, location, requestedIndex?, reason?)` | 같은 파일 | 컨테이너 이동 후 `saveViewCustomizations`로 저장. `canMoveViews()`가 거짓이면 아무 작업도 하지 않는다. |
| `moveViewToLocation(view, location, reason?)` | 같은 파일 | 단일 뷰를 새 컨테이너로 이동. |

- 저장: `VIEWS_CUSTOMIZATIONS = 'views.customizations'` 키를 `StorageScope.PROFILE`, `StorageTarget.USER`에 저장한다. 기존 키인 `views.cachedViewContainerLocations`, `views.cachedViewPositions`는 읽어서 새 키로 이전한 뒤 삭제한다. 저장 위치와 다중 탭 동기화는 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다.
- 드래그 앤 드롭: `CompositeDragAndDrop`(`src/vs/workbench/browser/parts/compositeBar.ts`)의 `drop`이 분기점이다. 동일한 위치의 바 내 이동이면 `moveComposite`(순서 변경), 다른 위치의 바 간 이동이면 `moveViewContainerToLocation(..., 'dnd')`를 호출한다. 개별 뷰를 드래그한 경우에는 `canMoveView`가 참일 때만 `moveViewToLocation`을 수행한다. 이동 후에는 `openComposite`로 해당 항목을 연다.
- 드래그 데이터 전달과 드롭 대상 등록은 `CompositeDragAndDropData`, `CompositeDragAndDropObserver`(`registerTarget`, `registerDraggable`) (`src/vs/workbench/browser/dnd.ts`)가 담당한다. 드롭 가능 여부는 `canDrop`이 결정한다.
- 확장이 컨테이너와 뷰를 기여하는 방법은 [vscode-extensions.md](vscode-extensions.md)의 `viewsContainers`/`views`를 참조한다.

## 8. 크기와 제약

| 파트 | 최소 | 최대 | 우선순위/스냅 | 출처 |
| --- | --- | --- | --- | --- |
| 제목 표시줄 | 높이: 명령 센터 표시 중이거나 윈도우 컨트롤 오버레이(WCO)면 `DEFAULT_CUSTOM_TITLEBAR_HEIGHT`(35), 아니면 30 | 높이 = 최소 높이. 너비 `0` ~ 무한 | - | `BrowserTitlebarPart.minimumHeight`, `DEFAULT_CUSTOM_TITLEBAR_HEIGHT`(`src/vs/platform/window/common/window.ts`) |
| 액티비티 바 | 너비: `ActivitybarPart.ACTIVITYBAR_WIDTH` 48(컴팩트 36) | 너비 = 최소 너비(고정). 높이 `0` ~ 무한 | - | `ActivitybarPart.minimumWidth`/`maximumWidth`, `ACTIVITYBAR_WIDTH`, `COMPACT_ACTIVITYBAR_WIDTH` |
| 액티비티 바 항목 높이 | 48(컴팩트 28) | - | - | `ActivitybarPart.ACTION_HEIGHT`, `COMPACT_ACTION_HEIGHT` |
| 사이드바 | 너비 170 | 무한 | `LayoutPriority.Low`, `snap` = `true`(닫힘으로 스냅) | `SidebarPart.minimumWidth`, `priority`, `snap` |
| 에디터 | 너비/높이: 중앙 정렬 위젯의 최소와 `getMaximumEditorDimensions`의 작은 쪽. 에디터 그룹 기본 최소는 220 x 70 | 중앙 정렬 위젯의 최대 | `LayoutPriority.High`, `snap` = 패널 정렬이 `center`일 때만 | `EditorPart.minimumWidth`, `priority`, `snap`, `DEFAULT_EDITOR_MIN_DIMENSIONS`(`src/vs/workbench/browser/parts/editor/editor.ts`) |
| 패널 | 너비 300, 높이 77 | 무한 | 우선순위 지정 없음(`Normal`), `snap`은 `AbstractPaneCompositePart.snap`(보이거나 표시 가능한 컨테이너가 있을 때) | `PanelPart.minimumWidth`/`minimumHeight` |
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
- 창 크기 폴백: `Layout.layout`이 `getClientArea`에 `DEFAULT_EMPTY_WINDOW_DIMENSIONS`/`DEFAULT_WORKSPACE_WINDOW_DIMENSIONS`를 전달하여 DOM 크기가 아직 0일 때의 예외를 처리한다.

## 9. 이 워크벤치에 주는 시사점

이 절은 사실 기술이 아니라 설계 방향에 대한 해석이다. 대응 규칙: VS Code의 `src/vs/<path>`는 writing-room의 `src/<path>`에 대응한다.

- 한곳에서 파트 id와 가시성을 총괄 관리하는 서비스(`IWorkbenchLayoutService` 역할)를 두면 메뉴, 단축키, 상태 저장 로직이 개별 파트 인스턴스를 직접 참조하지 않아도 된다.
- 그리드는 "직렬화 가능한 트리 + 파트별 최소/최대/우선순위"로 분리된다. 창 크기 변화를 에디터가 주로 흡수하게 하려면 `proportionalLayout: false`와 에디터의 `High` 우선순위를 함께 설정해야 한다.
- v0.1.0에서 패널을 표시된 채로 시작한다면 VS Code와 차이가 발생한다(`LayoutStateKeys.PANEL_HIDDEN` 기본값은 `true`). 해당 차이점은 `docs/architecture.md`의 `### Layout and parts`에 기록한다.
- 상태 저장 방식(VS Code는 IndexedDB 기반 스토리지를 사용)과 설정 구조는 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다.

Decided in: wr-e8v6
