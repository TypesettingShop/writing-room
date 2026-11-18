# VS Code 에디터 그룹, 탭, 에디터

고정 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`의 VS Code 에디터 영역(여섯 파트 중 "에디터")을 설명한다. 모든 경로는 그 커밋의 `src/vs/...` 이며, 이 워크벤치(writing-room)에서는 `src/vs/<path>`가 `src/<path>`에 대응한다([architecture.md](architecture.md)). 파트 조립과 그리드 엔진은 [vscode-workbench-layout.md](vscode-workbench-layout.md), 저장 방식은 [vscode-state-settings.md](vscode-state-settings.md), 홈은 [README.md](README.md)에 있다.

범위 밖(이름만): 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 보조 창 에디터 파트(`auxiliaryEditorPart.ts`)와 모달 에디터 파트(`modalEditorPart.ts`), 디프/멀티디프, 브레드크럼도 설명하지 않는다.

## 구조 한눈에

| 층 | 심볼 | 파일 | 역할 |
|---|---|---|---|
| 서비스 계약 | `IEditorGroupsService`, `IEditorGroupsContainer`, `IEditorGroup` | `src/vs/workbench/services/editor/common/editorGroupsService.ts` | 그룹 컨테이너와 한 그룹의 공개 계약 |
| 컨테이너 | `EditorPart` | `src/vs/workbench/browser/parts/editor/editorPart.ts` | 그룹들을 `SerializableGrid`에 담고 추가/제거/이동/병합/활성화 |
| 한 그룹(뷰) | `EditorGroupView` | `src/vs/workbench/browser/parts/editor/editorGroupView.ts` | DOM, 제목 컨트롤, 페인을 묶고 모델을 구동 |
| 한 그룹(모델) | `EditorGroupModel` | `src/vs/workbench/common/editor/editorGroupModel.ts` | DOM 없는 순서, 미리보기, 고정, 최근 사용 목록 |
| 탭 | `EditorTitleControl`, `MultiEditorTabsControl` | `editorTitleControl.ts`, `multiEditorTabsControl.ts` (같은 `browser/parts/editor/`) | 탭 줄 그리기, 탭 드래그 |
| 입력 | `EditorInput` | `src/vs/workbench/common/editor/editorInput.ts` | 무엇을 여는가(리소스, 이름, 더티 상태, 기능 비트) |
| 페인 | `EditorPane`, `EditorPanes` | `editorPane.ts`, `editorPanes.ts` | 입력을 그리는 위젯과 그 전환 |
| 드롭 | `EditorDropTarget`, `DropOverlay` | `editorDropTarget.ts` | 그룹 위 드래그의 영역 표시와 처리 |

## 1. 그룹 컨테이너: `EditorPart`

- `EditorPart extends Part<IEditorPartMemento> implements IEditorPart, IEditorGroupsView` (`editorPart.ts`). `Part`는 [vscode-workbench-layout.md](vscode-workbench-layout.md)의 파트 기반 클래스다. 에디터 파트 자신의 `minimumWidth`/`minimumHeight`는 가운데 정렬 레이아웃(`centeredLayoutWidget`, `CenteredViewLayout`)의 최소값과 `layoutService.getMaximumEditorDimensions` 중 작은 쪽이고, 그 안의 그리드는 내부 클래스 `GridWidgetView`(같은 파일)가 `gridWidget`의 최소값을 노출한다.
- 그룹들은 `SerializableGrid`(`src/vs/base/browser/ui/grid/grid.ts`) 안의 리프다. `doCreateGridControl`이 첫 그룹으로 `new SerializableGrid(initialGroup)`을 만들고, 저장 상태가 있으면 `SerializableGrid.deserialize`로 복원한다.
- 그룹이 그리드 뷰이므로 그룹의 최소 크기는 페인에서 온다: `EditorGroupView.minimumWidth/minimumHeight`는 `editorPane`의 값을 돌려주고, 기본 페인 최소는 `DEFAULT_EDITOR_MIN_DIMENSIONS`(220x70, `src/vs/workbench/browser/parts/editor/editor.ts`), 최대는 무한(`DEFAULT_EDITOR_MAX_DIMENSIONS`)이다.
- 방향/배치 열거형은 서비스 파일에 있다: `GroupDirection`(UP/DOWN/LEFT/RIGHT), `GroupOrientation`, `GroupLocation`(FIRST/LAST/NEXT/PREVIOUS), `GroupsArrangement`(MAXIMIZE/EXPAND/EVEN), `GroupsOrder`, `MergeGroupMode`(COPY_EDITORS/MOVE_EDITORS).

### 그룹 연산

| 연산 (`EditorPart`) | 무엇을 결정하는가 |
|---|---|
| `addGroup(location, direction, groupToCopy?)` | 기준 그룹 옆에 새 그룹을 만든다. `doCreateGroupView`가 `groupToCopy`가 있으면 `EditorGroupView.createCopy`, 직렬화 상태면 `createFromSerialized`, 아니면 `createNew`. 그리드에는 `gridWidget.addView(newGroupView, getSplitSizingStyle(), locationView, toGridViewDirection(direction))`로 넣는다. 크기 방식은 설정 `splitSizing`(`distribute` -> `Sizing.Distribute`, `split` -> `Sizing.Split`, 그 외 `Sizing.Auto`). 기준 그룹이 확장 상태였으면 `arrangeGroups(GroupsArrangement.EXPAND, ...)`로 새 그룹도 확장한다. 기준이 다른 파트의 그룹이면 그 파트의 `addGroup`에 위임 |
| `removeGroup(group, preserveFocus?)` | 그룹이 하나뿐이면 아무것도 하지 않는다(마지막 루트 그룹은 지울 수 없음). 비어 있으면 `doRemoveEmptyGroup`: 활성 그룹이었다면 `getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)[1]`을 활성화하고 `gridWidget.removeView` 후 dispose. 에디터가 있으면 `doRemoveGroupWithEditors`: 최근 활성 그룹으로 `mergeGroup`한 뒤 그룹이 비어 제거됨 |
| `moveGroup(group, location, direction)` | 같은 파트면 `gridWidget.moveView`, 다른 파트면 대상에 `addGroup(..., sourceView)`로 복사한 뒤 원본을 닫고 제거. 자기 자신 안으로는 `Error`. 다른 파트로 갈 때 `vetoGroupTransfer`가 거부하면 아무것도 바뀌지 않는다 |
| `copyGroup` | `addGroup(locationView, direction, groupView)`. 모델이 `clone()`되어 같은 입력을 공유 |
| `mergeGroup(group, target, options?)` | 소스 에디터를 `IMergeGroupOptions`(`mode`, `index`, `preserveExistingIndex`, `preserveFocus`)대로 대상에 `moveEditors`/`copyEditors`. 대상에 이미 고정된(sticky) 에디터는 `index`를 비워 상태를 잃지 않게 한다. 소스가 비면 `removeGroup`. `mergeAllGroups`는 전부 |
| `activateGroup(group, preserveWindowOrder?, reason?)` | `doSetGroupActive`가 활성 그룹과 최근 활성 목록(`mostRecentActiveGroups`)을 갱신하고, 창을 앞으로(`hostService.moveTop`) 올린다(`preserveWindowOrder`가 아니면) |
| `arrangeGroups`, `setGroupOrientation`, `applyLayout`/`getLayout`, `centerLayout` | 최대화/확장/균등, 루트 방향 전환, `EditorGroupLayout` 적용/조회, 가운데 정렬 레이아웃(`CenteredViewLayout`) |
| `findGroup(scope, source, wrap)`, `getGroups(order)` | `IFindGroupScope`의 방향/위치로 이웃 탐색, `GroupsOrder`(생성 순/최근 활성/그리드 순) 반환 |

- 모든 연산은 `IEditorGroupView | GroupIdentifier`를 받고 `assertGroupView`로 뷰로 해석한다. 그룹 식별자는 숫자다.
- 이벤트: `_onDidAddGroup`, `_onDidRemoveGroup`, `_onDidMoveGroup`가 연산마다 발생. 상태 복원(`doApplyState`) 중에는 이 이벤트를 `pause()`했다가 제거 -> 추가 순서로 `resume()`한다(리스너가 그룹 id를 집합에 보관하기 때문).

## 2. 하나의 그룹: `EditorGroupView`와 `EditorGroupModel`

### 뷰

- `EditorGroupView`(`editorGroupView.ts`)는 생성자 대신 정적 팩토리 `createNew`, `createFromSerialized`, `createCopy`로 만든다. 세 가지 모두 내부 `model: EditorGroupModel`을 만든다(복사는 `from.model.clone()`).
- 구성: `titleControl: EditorTitleControl`(탭 줄), `editorPane: EditorPanes`(활성 입력의 페인), 모델 이벤트(`onDidModelChange`)를 받아 제목 컨트롤과 컨텍스트 키를 갱신한다.
- `openEditor` -> `doOpenEditor`가 `model.openEditor(editor, options)`로 모델을 먼저 바꾸고, `doShowEditor`가 `editorPane.openEditor`로 페인을 연 뒤 `titleControl.openEditor`로 탭을 갱신한다. 즉 모델이 진실의 원천이고 뷰는 따라간다.
- 닫기: `closeEditor` -> `doCloseEditorWithConfirmationHandling`(`CannotClose` 기능이면 거절, `handleCloseConfirmation`으로 더티 확인) -> `doCloseEditor`. 활성이면 `doCloseActiveEditor`: 모델에서 닫고 다음 활성 에디터를 `doOpenEditor`로 연다. 비활성이면 모델만 갱신. 마지막 에디터를 닫고 설정 `closeEmptyGroups`(기본 `true`, `src/vs/workbench/browser/workbench.contribution.ts`)이면 `groupsView.removeGroup`을 호출한다. 그 전에 최적화로 다음 최근 활성 그룹을 먼저 활성화해 이벤트와 깜박임을 줄인다.

### 모델 (`editorGroupModel.ts`)

`EditorGroupModel`은 DOM이 없고 다음 상태만 가진다: `editors`(탭 순서), `mru`(최근 사용 순서), `selection`(첫 항목이 활성), `preview`, `sticky`(고정 구간의 경계 인덱스), `transient`.

| 질문 | 답 (심볼) |
|---|---|
| 새 에디터가 어디에 열리나 | `openEditor`. `options.index`가 있으면 그 자리. 없으면 설정 `workbench.editor.openPositioning`(기본 `right`): `first`는 0, `last`는 끝, `left`/`right`는 활성 에디터의 왼쪽/오른쪽. 고정(sticky)이 아닌 에디터는 고정 구간 뒤(`this.sticky + 1`)로 밀린다 |
| 미리보기란 | `pinned`/`sticky` 옵션이 없으면 `preview`가 되어 기존 미리보기를 `replaceEditor`로 대체한다. `pin`으로 고정 |
| 활성화되는가 | `makeActive = options.active \|\| 활성 없음 \|\| (고정 아님 && 활성이 미리보기)`. 활성이면 `setSelection`으로 선택 맨 앞이 된다 |
| 이미 열려 있으면 | `findEditor`로 찾아 새로 만들지 않고, 필요하면 `doPin`/인덱스 이동 후 선택만 갱신 |
| 닫을 때 무엇이 활성이 되나 | `doCloseEditor`(활성 + `openNext`): `mru.length > 1`이면, 설정 `workbench.editor.focusRecentEditorAfterClose`(기본 `true`)일 때 `mru[1]`, 아니면 마지막 탭이면 앞 탭 `editors[index - 1]`, 그 외 다음 탭 `editors[index + 1]`. 마지막 하나였으면 선택을 비운다 |
| 순서 조회 | `getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE \| SEQUENTIAL, { excludeSticky })` |
| 고정/잠금 | `stick`/`unstick`, `lock`/`isLocked` |
| 저장 | `serialize()`: `IEditorFactoryRegistry.getEditorSerializer`(`src/vs/workbench/common/editor.ts`)로 각 입력을 `ISerializedEditorInput { id: typeId, value }`로 만들고, 직렬화 불가능한 입력은 `mru`/활성/미리보기/고정 계산에서 뺀다 |

- 모델은 `onDidModelChange`로 `GroupModelChangeKind` 이벤트(`IGroupEditorOpenEvent` 등)를 낸다. 뷰는 이를 구독만 한다.

## 3. 탭

- `EditorTitleControl`(`editorTitleControl.ts`)은 `createEditorTabsControl`에서 설정 `showTabs`로 구현을 고른다: `none` -> `NoEditorTabsControl`, `single` -> `SingleEditorTabsControl`, `multiple`(기본 분기) -> `pinnedTabsOnSeparateRow`이면 `MultiRowEditorControl`, 아니면 `MultiEditorTabsControl`. 같은 위치에 `EditorHeaderControl`도 있다.
- `MultiEditorTabsControl extends EditorTabsControl`(`multiEditorTabsControl.ts`)의 공개 면은 뷰가 호출하는 `openEditor`, `closeEditor`, `moveEditor`, `pinEditor`, `stickEditor`/`unstickEditor`, `updateEditorDirty`, `updateEditorLabel` 등이다. 탭 폭은 `TAB_WIDTH`(`compact` 38, `shrink` 80, `fit` 120), 스크롤바는 `SCROLLBAR_SIZES`(`default` 3, `large` 10), 드래그 중 탭 자동 열기는 `DRAG_OVER_OPEN_TAB_THRESHOLD`(1500ms).
- 탭은 모델의 `selectedEditors`를 보여 주는 뷰일 뿐이다. 탭 줄이 모델과 다른 상태를 갖지 않는다.

## 4. 입력과 페인

### 입력: `EditorInput`

- `abstract class EditorInput extends AbstractEditorInput`(`src/vs/workbench/common/editor/editorInput.ts`). 하위 클래스가 반드시 정하는 것: `typeId`(같은 클래스는 같은 타입 id, 직렬화 키)와 `resource`.
- 표시: `getName`, `getDescription`, `getTitle`, `getIcon`. 상태: `isDirty`, `isModified`, `isSaving`, `isReadonly`. 동작: `resolve`, `save`, `saveAs`, `revert`, `rename`, `copy`, `matches`(동일성 비교, `findEditor`의 기반), `canMove`.
- `capabilities`는 `EditorInputCapabilities` 비트 집합(`src/vs/workbench/common/editor.ts`): `Readonly`, `Untitled`, `Singleton`, `RequiresTrust`, `CanSplitInGroup`, `ForceDescription` 등. 소비처의 예: `Singleton`은 드롭에서 복사/분할이 안 되고(`isCopyOperation`), `RequiresTrust`는 `EditorPanes.getEditorPaneDescriptor`가 신뢰되지 않은 워크스페이스에서 자리표시 페인으로 대체한다.

### 입력 -> 페인 해석

- `EditorPanes.doOpenEditor`가 `getEditorPaneDescriptor(editor)`로 설명자를 얻는다. 레지스트리는 `EditorPaneRegistry.getEditorPane`(`src/vs/workbench/browser/editor.ts`)이며, 등록은 `registerEditorPane(descriptor, [입력 SyncDescriptor...])`. 설명자가 둘 이상이면 `editor.prefersEditorPane`이 고른다.
- 설명자는 지연 로드된다(`EditorPaneDescriptor.create`). `doShowEditorPane`이 페인을 만들거나 재사용하고, `doSetInput`이 `EditorPane.setInput`을 호출한다.

### 페인: `EditorPane`

- `abstract class EditorPane extends Composite`(`editorPane.ts`). 하위 클래스가 구현하는 것은 `createEditor(parent)`와 `setInput`. 최소/최대 크기(`minimumWidth` 등)는 `DEFAULT_EDITOR_*_DIMENSIONS`. `getViewState`, `clearInput`, `setVisible`을 가진다.
- 뷰 상태 보관: 같은 파일의 `EditorMemento`가 `StorageScope.WORKSPACE`, `StorageTarget.MACHINE`의 메멘토에 한도(기본 10, 뷰 상태 페인은 100)까지 보관한다(`getEditorMemento`). 상세는 [vscode-state-settings.md](vscode-state-settings.md).

### 텍스트 페인 계층

| 클래스 | 파일 | 하는 일 |
|---|---|---|
| `AbstractEditorWithViewState` | `editorWithViewState.ts` | 입력을 떠날 때/숨길 때 `computeEditorViewState`로 뷰 상태를 저장하고 다시 열 때 복원. 설정 `workbench.editor.restoreViewState`(기본 복원). 하위가 `tracksEditorViewState`, `toEditorViewStateResource`를 정함 |
| `AbstractTextEditor` | `textEditor.ts` | 설정(`IEditorConfiguration`)을 `computeConfiguration`으로 편집기 옵션에 반영. `createEditorControl`, `getMainControl` 등을 추상으로 둠 |
| `AbstractTextCodeEditor` | `textCodeEditor.ts` | `createEditorControl`에서 `CodeEditorWidget`을 `createInstance`로 만든다 |
| `TextResourceEditor` | `textResourceEditor.ts` | 텍스트 리소스/이름 없는 에디터용 구체 페인(`ID = 'workbench.editors.textResourceEditor'`). `editor.contribution.ts`에서 등록 |

(모든 파일은 `src/vs/workbench/browser/parts/editor/`.)

### 이름 없는 에디터

- `src/vs/workbench/services/untitled/common/`: `UntitledTextEditorService`(`create`, `get`, `resolve`)가 `UntitledTextEditorModel`을 관리하고, `UntitledTextEditorInput`(`typeId`는 `UntitledTextEditorInput.ID = 'workbench.editors.untitledEditorInput'`)이 그 모델을 에디터 입력으로 감싼다. `UntitledTextEditorInputSerializer`(`untitledTextEditorHandler.ts`)가 재시작 복원을 담당한다.

## 5. 에디터 자체와 Monaco

- VS Code는 `src/vs/editor`를 직접 임베드한다. 텍스트 페인이 `src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts`의 `CodeEditorWidget`을 `IInstantiationService`로 만들며(`textCodeEditor.ts`), 모델/언어/마커/테마/키바인딩 등은 워크벤치의 실제 서비스 구현을 주입받는다.
- `monaco-editor` 패키지는 같은 `src/vs/editor`의 독립 실행형 패키징이다. 진입점은 `src/vs/editor/editor.api.ts`(`createMonacoEditorAPI`를 `src/vs/editor/standalone/browser/standaloneEditor.ts`에서 가져옴)이고, 표면은 `standaloneEditor.ts`의 `create(domElement, options, override)`, `createModel(value, language, uri)`, `createDiffEditor`, `getModel`, `onDidCreateEditor`, `defineTheme`/`setTheme`, `colorize`이다.
- `create`는 `StandaloneServices.initialize(override || {})`로 서비스 컬렉션을 만들고 `StandaloneEditor`(`standaloneCodeEditor.ts`, `extends StandaloneCodeEditor extends CodeEditorWidget`)를 만든다. 서비스는 `src/vs/editor/standalone/browser/standaloneServices.ts`가 `registerSingleton`으로 독립 실행형 구현을 등록한다: `StandaloneConfigurationService`, `StandaloneKeybindingService`, `StandaloneCommandService`, `StandaloneThemeService`, `StandaloneNotificationService`, `StandaloneWorkspaceContextService` 등. 이 서비스 집합에는 에디터 그룹/탭/`IEditorService`가 없다.

| 항목 | 패키지(`monaco-editor`)를 쓰는 워크벤치 | 소스를 임베드하는 워크벤치(VS Code 방식) |
|---|---|---|
| 얻는 것 | 에디터 엔진 완성품. 설정/서비스 배선 불필요, 번들 크기와 업그레이드 경로가 단순, 공개 API가 안정 | 워크벤치 서비스(`IEditorService`, `ITextFileService`, `IModelService` 실구현)와 직접 연결, 같은 인스턴스를 다른 UI가 공유, 내부 접근 |
| 잃는 것 | 그룹/탭/입력/페인/뷰 상태/이름 없는 에디터/파일 모델을 직접 만들어야 한다. 서비스를 `override`로만 바꿀 수 있다. 내부 심볼 접근 불가, 확장 호스트와 키바인딩 계약은 `Standalone*` 구현이 대체 | 소스 동기화와 빌드 부담(`src/vs/editor`가 워크벤치 서비스와 같은 커밋에 묶임), 번들이 커짐 |
| 에디터 상태 보관 | 호스트가 모델과 뷰 상태(`saveViewState`)를 직접 저장 | `AbstractEditorWithViewState` + `EditorMemento` 경로 |

## 6. 드래그 앤 드롭

### 전송 데이터

- `LocalSelectionTransfer<T>`(`src/vs/platform/dnd/browser/dnd.ts`)는 앱 내부 드래그의 싱글톤 저장소다. `getInstance()`, `setData(data, proto)`, `hasData(proto)`, `getData(proto)`, `clearData(proto)`. 종류는 프로토타입으로 구분한다.
- `src/vs/workbench/browser/dnd.ts`: `DraggedEditorIdentifier { identifier: IEditorIdentifier }`(에디터, 그룹 id), `DraggedEditorGroupIdentifier { identifier: GroupIdentifier }`. 외부 드래그(파일/리소스)는 `ResourcesDropHandler`가 처리한다.

### 탭 핸들러 (`MultiEditorTabsControl`)

- 드래그 시작: 선택된 에디터 전부를 `DraggedEditorIdentifier`로 `editorTransfer.setData`하고, `dataTransfer.effectAllowed = 'copyMove'`, 드래그 이미지, 외부 앱용 리소스 데이터(`doFillResourceDataTransfers`)를 채운다. 탭 줄 빈 곳 드래그는 `onGroupDragStart`(`editorTabsControl.ts`)가 그룹 전송이다.
- 드래그 중: `updateDropFeedback`이 탭의 왼쪽/오른쪽(`getTabDragOverLocation`)에 삽입 표시를 그리고, 1500ms 이상 머물면 그 탭을 `preserveFocus`로 연다.
- 드롭: 대상 인덱스(오른쪽 반이면 +1)를 정해 `onDrop`이 처리한다. 그룹 드롭은 `mergeGroup`(복사면 `MergeGroupMode.COPY_EDITORS`)이고, 에디터 드롭은 `isMoveOperation`이면 `sourceGroup.moveEditor`, 아니면 `copyEditor`. 같은 그룹에서 앞쪽을 뒤로 옮기면 인덱스를 하나 줄여 순서를 유지한다. 복사 수식키는 Windows/Linux에서 Ctrl, macOS에서 Alt(`isCopyIntoOtherGroup`).
- 드래그 종료(`onDragEnd`): 새 창으로 끌어내는 동작(`transferToNewWindowAt`)이면 이동/복사.

### 에디터 영역 오버레이 (`editorDropTarget.ts`)

- `EditorDropTarget`이 컨테이너의 `dragenter/leave/over/end`를 듣고, 대상 그룹마다 `DropOverlay`를 만든다. `DropOverlay.update`가 드래그 위치에 따라 오버레이를 배치한다.
- 영역은 `getSplitDirection(mousePosX, mousePosY, width, height, isDraggingGroup, preferSplitVertically, splitsOnly)`가 결정하며 `GroupDirection | undefined`를 돌려준다. `undefined`는 "그룹 안으로 합치기(MERGE)"다.

```text
가장자리 임계: 에디터 드래그는 폭/높이의 10%. 그룹 드래그는 선호 방향 쪽을 30%로 넓힘.
가장자리 안쪽(중앙): 분할 없음 = MERGE (splitsOnly면 가장 가까운 변으로 분할)

splitting 선호 = 가로(기본, openSideBySideDirection != 'right')
 +-----------------------------+
 |           SPLIT UP          |  y < 높이/3
 +------------+-------+--------+
 | SPLIT LEFT | MERGE | SPLIT  |  x < 폭/2 -> LEFT, 그 외 RIGHT
 |            |       | RIGHT  |
 +------------+-------+--------+
 |          SPLIT DOWN         |  y > 높이*2/3
 +-----------------------------+

splitting 선호 = 세로(`openSideBySideDirection === 'right'`)
 +--------+-----------+--------+
 |        | SPLIT UP  |        |  x가 가운데 1/3: y < 높이/2 -> UP
 | SPLIT  +-----------+ SPLIT  |
 | LEFT   |   MERGE   | RIGHT  |  x < 폭/3 -> LEFT, x > 폭*2/3 -> RIGHT
 |        | SPLIT DOWN|        |
 +--------+-----------+--------+
```

(그림은 `getSplitDirection` 안의 주석 도식을 이 문서 표기로 요약한 것이다. 원문은 해당 함수를 읽는다.)

- 오버레이는 탭 줄 아래만 덮는다: `getDropAreaOffsetHeight`는 에디터가 있고 `showTabs === 'multiple'`일 때 `titleHeight.offset`을 제외한다.
- 드롭 처리 `DropOverlay.handleDrop`: 분할이면 `ensureTargetGroup`이 `editorGroupService.addGroup(groupView, splitDirection)`(그룹 드래그는 복사면 `copyGroup`, 아니면 `moveGroup`; 합치기는 `mergeGroup`). 에디터를 옮기다 소스 그룹의 마지막 에디터이고 `closeEmptyGroups`이며 분할이면 에디터 대신 `moveGroup`으로 그룹째 옮긴다(최적화). 그 외에는 `sourceGroup.moveEditors/copyEditors(prepareMoveCopyEditors(...), targetGroup)`. 마지막에 대상 그룹에 포커스.

### 드롭이 제공되지 않는 경우

| 경우 | 동작 (심볼) |
|---|---|
| 설정 `allowDropIntoGroup`이 꺼짐 | `EditorDropTarget.onDragEnter`가 `dropEffect = 'none'` |
| 지원하지 않는 전송 형식(파일/리소스/에디터/기여 형식 아님) | `containsDragType` 검사 실패 시 `dropEffect = 'none'` |
| 입력 위젯이 드롭을 받는 위치(`isInputDropTargetEvent`) | 오버레이 제거, 입력이 처리 |
| 콘텐츠가 드롭을 받는 위치(`isContentDropTargetEvent`) | 에디터/그룹 드래그가 분할을 켜지 않았다면 오버레이 제거 |
| 자기 그룹에 드롭하는데 결과가 빈 그룹 | `DropOverlay.update`: 복사가 아니고 소스 = 대상이며 그룹 드래그이거나 `count < 2`이면 `hideOverlay` |
| 분할 비활성(`splitOnDragAndDrop` 꺼짐, 또는 `supportsSplitting`이 false) | 분할 영역 없이 전체가 MERGE. `Alt`(macOS는 `Shift`)로 반전(`isToggleSplitOperation`) |
| `Singleton` 입력 | 복사로 취급되지 않음(`isCopyOperation`), 분할/복사 불가 |
| 다른 파트로 가는데 입력이 이동을 거부 | `isTransferVetoed`가 `getEditorsTransferVeto`로 확인 후 안내하고 전송 취소 |
| 로컬 데이터 없음(외부 드래그) | `dropEffect = 'copy'`로 강제, `ResourcesDropHandler` 경로 |
| 오버레이 정리 | 마우스가 오버레이 위에서 감지되면 `cleanupOverlayScheduler`(300ms)로 제거(VM/호스트 DnD 버그 방지) |

## 7. 이 워크벤치에 주는 시사점

(위는 사실, 아래는 해석이다.)

- 이 워크벤치의 에디터 파트가 같은 층 분리를 따르면: 모델(순서/미리보기/고정/MRU)은 DOM 없이 단위 테스트, 뷰는 모델 이벤트만 구독, 입력과 페인은 레지스트리로 연결.
- 그리드가 이미 `SerializableGrid` 대응물이면 그룹 추가/제거/이동은 `addView`/`removeView`/`moveView` 호출로 줄고, 저장은 `serialize()`에 `activeGroup`과 최근 활성 목록을 더하면 된다(`IEditorPartUIState`).
- 합치기 vs 분할 판정은 `getSplitDirection` 순수 함수로 분리하면 DOM 없이 검증할 수 있다.
- Monaco 패키지를 쓴다면 위 5절 표의 "잃는 것"(그룹/탭/입력/상태)이 이 워크벤치가 직접 구현할 범위다.

Decided in: wr-e8v6
