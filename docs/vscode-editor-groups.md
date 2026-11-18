# VS Code 에디터 그룹, 탭, 에디터

고정 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`의 VS Code 에디터 영역(여섯 파트 중 "에디터")을 설명한다. 모든 경로는 해당 커밋의 `src/vs/...` 기준이며, writing-room에서는 `src/vs/<path>`가 `src/<path>`에 대응한다([architecture.md](architecture.md)). 파트 조립과 그리드 엔진은 [vscode-workbench-layout.md](vscode-workbench-layout.md), 저장 방식은 [vscode-state-settings.md](vscode-state-settings.md), 개요는 [README.md](README.md)를 참조한다.

범위 제외(이름만 표기): 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 보조 창 에디터 파트(`auxiliaryEditorPart.ts`)와 모달 에디터 파트(`modalEditorPart.ts`), diff/multi-diff, 브레드크럼도 다루지 않는다.

## 구조 한눈에

| 층 | 심볼 | 파일 | 역할 |
|---|---|---|---|
| 서비스 계약 | `IEditorGroupsService`, `IEditorGroupsContainer`, `IEditorGroup` | `src/vs/workbench/services/editor/common/editorGroupsService.ts` | 그룹 컨테이너와 단일 그룹의 공개 계약 |
| 컨테이너 | `EditorPart` | `src/vs/workbench/browser/parts/editor/editorPart.ts` | 그룹들을 `SerializableGrid`에 담고 추가/제거/이동/병합/활성화 관리 |
| 단일 그룹(뷰) | `EditorGroupView` | `src/vs/workbench/browser/parts/editor/editorGroupView.ts` | DOM, 제목 컨트롤, 페인을 묶고 모델을 구동 |
| 단일 그룹(모델) | `EditorGroupModel` | `src/vs/workbench/common/editor/editorGroupModel.ts` | DOM과 무관한 탭 순서, 미리보기, 고정, 최근 사용 목록 관리 |
| 탭 | `EditorTitleControl`, `MultiEditorTabsControl` | `editorTitleControl.ts`, `multiEditorTabsControl.ts` (동일 `browser/parts/editor/`) | 탭 줄 렌더링, 탭 드래그 처리 |
| 입력 | `EditorInput` | `src/vs/workbench/common/editor/editorInput.ts` | 열 대상의 명세(리소스, 이름, 더티 상태, 기능 비트) |
| 페인 | `EditorPane`, `EditorPanes` | `editorPane.ts`, `editorPanes.ts` | 입력을 렌더링하는 위젯 및 전환 처리 |
| 드롭 | `EditorDropTarget`, `DropOverlay` | `editorDropTarget.ts` | 그룹 위로 드래그할 때의 드롭 영역 표시와 드롭 처리 |

## 1. 그룹 컨테이너: `EditorPart`

- `EditorPart extends Part<IEditorPartMemento> implements IEditorPart, IEditorGroupsView` (`editorPart.ts`). `Part`는 [vscode-workbench-layout.md](vscode-workbench-layout.md)에서 다룬 파트 기반 클래스다. 에디터 파트 자체의 `minimumWidth`/`minimumHeight`는 가운데 정렬 레이아웃(`centeredLayoutWidget`, `CenteredViewLayout`)의 최솟값과 `layoutService.getMaximumEditorDimensions` 중 작은 쪽이며, 내부 그리드는 내부 클래스 `GridWidgetView`(동일 파일)가 `gridWidget`의 최솟값을 노출한다.
- 각 그룹은 `SerializableGrid`(`src/vs/base/browser/ui/grid/grid.ts`)의 리프 노드다. `doCreateGridControl`이 첫 그룹으로 `new SerializableGrid(initialGroup)`을 생성하고, 저장된 상태가 있다면 `SerializableGrid.deserialize`로 복원한다.
- 그룹이 그리드 뷰이므로 그룹의 최소 크기는 페인에서 결정된다: `EditorGroupView.minimumWidth/minimumHeight`는 `editorPane`의 값을 반환하며, 기본 페인 최솟값은 `DEFAULT_EDITOR_MIN_DIMENSIONS`(220x70, `src/vs/workbench/browser/parts/editor/editor.ts`), 최댓값은 무한(`DEFAULT_EDITOR_MAX_DIMENSIONS`)이다.
- 방향/배치 관련 enum은 서비스 파일에 정의되어 있다: `GroupDirection`(UP/DOWN/LEFT/RIGHT), `GroupOrientation`, `GroupLocation`(FIRST/LAST/NEXT/PREVIOUS), `GroupsArrangement`(MAXIMIZE/EXPAND/EVEN), `GroupsOrder`, `MergeGroupMode`(COPY_EDITORS/MOVE_EDITORS).

### 그룹 연산

| 연산 (`EditorPart`) | 무엇을 결정하는가 |
|---|---|
| `addGroup(location, direction, groupToCopy?)` | 기준 그룹 옆에 새 그룹을 생성한다. `doCreateGroupView`가 `groupToCopy`가 있으면 `EditorGroupView.createCopy`, 직렬화 상태면 `createFromSerialized`, 그 외에는 `createNew`를 호출한다. 그리드에는 `gridWidget.addView(newGroupView, getSplitSizingStyle(), locationView, toGridViewDirection(direction))`로 추가한다. 크기 분배 방식은 설정 `splitSizing`(`distribute` -> `Sizing.Distribute`, `split` -> `Sizing.Split`, 기타 `Sizing.Auto`)을 따른다. 기준 그룹이 확장 상태였으면 `arrangeGroups(GroupsArrangement.EXPAND, ...)`로 새 그룹도 함께 확장한다. 기준이 다른 파트의 그룹이면 해당 파트의 `addGroup`에 위임한다. |
| `removeGroup(group, preserveFocus?)` | 그룹이 하나뿐이면 아무 작업도 하지 않는다(마지막 루트 그룹은 삭제 불가). 비어 있으면 `doRemoveEmptyGroup`: 활성 그룹이었다면 `getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)[1]`을 활성화하고 `gridWidget.removeView` 후 dispose한다. 에디터가 남아 있으면 `doRemoveGroupWithEditors`: 최근 활성 그룹으로 `mergeGroup`한 뒤 비워진 그룹을 제거한다. |
| `moveGroup(group, location, direction)` | 동일 파트 내 이동이면 `gridWidget.moveView`, 다른 파트 간 이동이면 대상 파트에 `addGroup(..., sourceView)`로 복사한 뒤 원본을 닫고 제거한다. 자기 자신 안으로 이동하려 하면 `Error`가 발생한다. 다른 파트로 이동할 때 `vetoGroupTransfer`가 거부하면 변경이 취소된다. |
| `copyGroup` | `addGroup(locationView, direction, groupView)`. 모델이 `clone()`되어 동일한 입력을 공유한다. |
| `mergeGroup(group, target, options?)` | 원본 에디터들을 `IMergeGroupOptions`(`mode`, `index`, `preserveExistingIndex`, `preserveFocus`)에 따라 대상 그룹으로 `moveEditors`/`copyEditors`한다. 옮기는 에디터가 대상 그룹에 이미 있고 거기서 고정(sticky) 상태이면(또는 `preserveExistingIndex`가 참이면) 그 에디터에만 `index`를 주지 않아 고정 상태를 잃지 않게 한다. 원본이 비워지면 `removeGroup`을 호출한다. `mergeAllGroups`는 모든 그룹을 병합한다. |
| `activateGroup(group, preserveWindowOrder?, reason?)` | `doSetGroupActive`가 활성 그룹과 최근 활성 목록(`mostRecentActiveGroups`)을 갱신하고, 창을 앞으로(`hostService.moveTop`) 올린다(`preserveWindowOrder`가 아니면) |
| `arrangeGroups`, `setGroupOrientation`, `applyLayout`/`getLayout`, `centerLayout` | 최대화/확장/균등 분배, 루트 방향 전환, `EditorGroupLayout` 적용/조회, 가운데 정렬 레이아웃(`CenteredViewLayout`) 적용. |
| `findGroup(scope, source, wrap)`, `getGroups(order)` | `IFindGroupScope`의 방향/위치로 인접 그룹 탐색, `GroupsOrder`(생성 순/최근 활성/그리드 순)에 따른 그룹 목록 반환. |

- 모든 연산은 `IEditorGroupView | GroupIdentifier`를 전달받아 `assertGroupView`를 거쳐 뷰 객체로 변환한다. 그룹 식별자는 숫자다.
- 이벤트: 연산마다 `_onDidAddGroup`, `_onDidRemoveGroup`, `_onDidMoveGroup`가 발생한다. 상태 복원(`doApplyState`) 중에는 이 이벤트를 일시 정지(`pause()`)했다가 제거 -> 추가 순서로 재개(`resume()`)한다(리스너가 그룹 id를 집합에 보관하기 때문).

## 2. 하나의 그룹: `EditorGroupView`와 `EditorGroupModel`

### 뷰

- `EditorGroupView`(`editorGroupView.ts`)는 생성자 대신 정적 팩토리 메서드 `createNew`, `createFromSerialized`, `createCopy`를 통해 인스턴스를 생성한다. 세 방식 모두 내부 `model: EditorGroupModel`을 생성한다(복사 시에는 `from.model.clone()`).
- 구성: `titleControl: EditorTitleControl`(탭 줄), `editorPane: EditorPanes`(활성 입력의 페인), 모델 이벤트(`onDidModelChange`)를 구독하여 제목 컨트롤과 컨텍스트 키를 갱신한다.
- `openEditor` -> `doOpenEditor`가 먼저 `model.openEditor(editor, options)`로 모델 상태를 변경하고, `doShowEditor`가 `editorPane.openEditor`로 페인을 연 뒤 `titleControl.openEditor`로 탭을 갱신한다. 즉 모델이 단일 진실 공급원이며 뷰는 이를 반영한다.
- 닫기: `closeEditor` -> `doCloseEditorWithConfirmationHandling`(`CannotClose` 기능 플래그가 있으면 거절, `handleCloseConfirmation`으로 더티 상태 확인) -> `doCloseEditor`. 활성 에디터인 경우 `doCloseActiveEditor`: 모델에서 제거하고 다음 활성 에디터를 `doOpenEditor`로 연다. 비활성 에디터라면 모델만 갱신한다. 마지막 에디터를 닫고 `closeEmptyGroups` 설정(기본값 `true`, `src/vs/workbench/browser/workbench.contribution.ts`)이 켜져 있으면 `groupsView.removeGroup`을 호출한다. 이때 깜박임과 불필요한 이벤트를 줄이기 위해 다음 최근 활성 그룹을 미리 활성화하는 최적화를 수행한다.

### 모델 (`editorGroupModel.ts`)

`EditorGroupModel`은 DOM에 의존하지 않으며 다음 상태만 관리한다: `editors`(탭 순서), `mru`(최근 사용 순서), `selection`(첫 항목이 활성), `preview`, `sticky`(고정 영역의 경계 인덱스), `transient`.

| 질문 | 답 (심볼) |
|---|---|
| 새 에디터가 어디에 열리는가 | `openEditor`. `options.index`가 지정되면 해당 위치에 열린다. 없으면 설정 `workbench.editor.openPositioning`(기본값 `right`): `first`는 0, `last`는 맨 끝, `left`/`right`는 활성 에디터의 왼쪽/오른쪽. 고정(sticky)이 아닌 에디터는 고정 영역 뒤(`this.sticky + 1`)로 밀린다. |
| 미리보기(preview)란 | `pinned`/`sticky` 옵션이 지정되지 않으면 `preview` 상태가 되며, 기존 미리보기 에디터를 `replaceEditor`로 대체한다. `pin`을 호출해 영구 고정할 수 있다. |
| 활성화 조건 | `makeActive = options.active \|\| 활성 없음 \|\| (고정 아님 && 활성이 미리보기)`. 활성화 시 `setSelection`으로 선택 목록 맨 앞에 위치한다. |
| 이미 열려 있는 경우 | `findEditor`로 검색하여 새 인스턴스를 만들지 않고, 필요 시 `doPin`/인덱스 이동 후 선택 상태만 갱신한다. |
| 에디터를 닫을 때 다음 활성 대상 | `doCloseEditor`(활성 + `openNext`): `mru.length > 1`일 때 설정 `workbench.editor.focusRecentEditorAfterClose`(기본값 `true`)이면 `mru[1]`, 비활성화 상태라면 마지막 탭일 때 이전 탭 `editors[index - 1]`, 그 외에는 다음 탭 `editors[index + 1]`. 마지막 에디터였으면 선택을 비운다. |
| 순서 조회 | `getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE \| SEQUENTIAL, { excludeSticky })` |
| 고정 및 잠금 | `stick`/`unstick`, `lock`/`isLocked` |
| 저장 | `serialize()`: `IEditorFactoryRegistry.getEditorSerializer`(`src/vs/workbench/common/editor.ts`)로 각 입력을 `ISerializedEditorInput { id: typeId, value }`로 변환하며, 직렬화할 수 없는 입력은 `mru`/활성/미리보기/고정 계산에서 제외한다. |

- 모델은 `onDidModelChange`를 통해 `GroupModelChangeKind` 이벤트(`IGroupEditorOpenEvent` 등)를 발생시킨다. 뷰는 이 이벤트를 구독하여 화면을 갱신한다.

## 3. 탭

- `EditorTitleControl`(`editorTitleControl.ts`)은 `createEditorTabsControl`에서 설정 `showTabs`에 따라 구현체를 선택한다: `none` -> `NoEditorTabsControl`, `single` -> `SingleEditorTabsControl`, `multiple`(기본 분기) -> `pinnedTabsOnSeparateRow`이면 `MultiRowEditorControl`, 아니면 `MultiEditorTabsControl`. 동일 위치에 `EditorHeaderControl`도 함께 존재한다.
- `MultiEditorTabsControl extends EditorTabsControl`(`multiEditorTabsControl.ts`)의 공개 메서드는 뷰에서 호출하는 `openEditor`, `closeEditor`, `moveEditor`, `pinEditor`, `stickEditor`/`unstickEditor`, `updateEditorDirty`, `updateEditorLabel` 등이다. 탭 너비는 `TAB_WIDTH`(`compact` 38, `shrink` 80, `fit` 120), 스크롤바 굵기는 `SCROLLBAR_SIZES`(`default` 3, `large` 10), 드래그 중 탭 자동 열림 지연 시간은 `DRAG_OVER_OPEN_TAB_THRESHOLD`(1500ms)이다.
- 탭은 모델의 `selectedEditors`를 시각적으로 보여주는 뷰일 뿐이다. 탭 줄 자체가 모델과 별개의 상태를 유지하지 않는다.

## 4. 입력과 페인

### 입력: `EditorInput`

- `abstract class EditorInput extends AbstractEditorInput`(`src/vs/workbench/common/editor/editorInput.ts`). 하위 클래스가 반드시 구현해야 하는 항목: `typeId`(동일 클래스는 동일한 타입 id, 직렬화 키로 사용)와 `resource`.
- 표시 속성: `getName`, `getDescription`, `getTitle`, `getIcon`. 상태 플래그: `isDirty`, `isModified`, `isSaving`, `isReadonly`. 동작 메서드: `resolve`, `save`, `saveAs`, `revert`, `rename`, `copy`, `matches`(동일성 비교, `findEditor`의 기반), `canMove`.
- `capabilities`는 `EditorInputCapabilities` 비트 플래그(`src/vs/workbench/common/editor.ts`)다: `Readonly`, `Untitled`, `Singleton`, `RequiresTrust`, `CanSplitInGroup`, `ForceDescription` 등이 있다. 활용 예: `Singleton`은 드롭 시 복사나 분할이 허용되지 않고(`isCopyOperation`), `RequiresTrust`는 신뢰되지 않은 워크스페이스에서 `EditorPanes.getEditorPaneDescriptor`가 플레이스홀더 페인으로 대체한다.

### 입력 -> 페인 해석

- `EditorPanes.doOpenEditor`가 `getEditorPaneDescriptor(editor)`를 통해 설명자를 가져온다. 레지스트리는 `EditorPaneRegistry.getEditorPane`(`src/vs/workbench/browser/editor.ts`)이며, `registerEditorPane(descriptor, [입력 SyncDescriptor...])` 형태로 등록된다. 등록된 설명자가 둘 이상이면 `editor.prefersEditorPane`이 우선순위를 결정한다.
- 설명자는 지연 인스턴스화된다(`EditorPaneDescriptor.create`). `doShowEditorPane`이 페인을 생성하거나 재사용하고, `doSetInput`이 `EditorPane.setInput`을 호출한다.

### 페인: `EditorPane`

- `abstract class EditorPane extends Composite`(`editorPane.ts`). 하위 클래스가 구현해야 하는 핵심 메서드는 `createEditor(parent)`와 `setInput`이다. 최소/최대 크기(`minimumWidth` 등)는 `DEFAULT_EDITOR_*_DIMENSIONS`를 따른다. `getViewState`, `clearInput`, `setVisible`을 포함한다.
- 뷰 상태 보관: 동일 파일의 `EditorMemento`가 `StorageScope.WORKSPACE`, `StorageTarget.MACHINE` 범위의 메멘토에 제한 용량(기본 10개, 뷰 상태 페인은 100개)까지 상태를 저장한다(`getEditorMemento`). 세부 내용은 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다.

### 텍스트 페인 계층

| 클래스 | 파일 | 하는 일 |
|---|---|---|
| `AbstractEditorWithViewState` | `editorWithViewState.ts` | 입력을 벗어나거나 숨길 때 `computeEditorViewState`로 뷰 상태를 저장하고 다시 열 때 복원한다. 설정 `workbench.editor.restoreViewState`(기본값 복원 활성화). 하위 클래스에서 `tracksEditorViewState`, `toEditorViewStateResource`를 정의한다. |
| `AbstractTextEditor` | `textEditor.ts` | 설정(`IEditorConfiguration`)을 `computeConfiguration`을 통해 에디터 옵션에 반영한다. `createEditorControl`, `getMainControl` 등을 추상 메서드로 선언한다. |
| `AbstractTextCodeEditor` | `textCodeEditor.ts` | `createEditorControl`에서 `CodeEditorWidget`을 `createInstance`로 만든다 |
| `TextResourceEditor` | `textResourceEditor.ts` | 텍스트 리소스 및 제목 없는 에디터를 위한 구체 페인 구현체(`ID = 'workbench.editors.textResourceEditor'`). `editor.contribution.ts`에서 등록된다. |

(위 파일들은 모두 `src/vs/workbench/browser/parts/editor/`에 위치한다.)

### 이름 없는 에디터

- `src/vs/workbench/services/untitled/common/`: `UntitledTextEditorService`(`create`, `get`, `resolve`)가 `UntitledTextEditorModel`을 관리하며, `UntitledTextEditorInput`(`typeId`는 `UntitledTextEditorInput.ID = 'workbench.editors.untitledEditorInput'`)이 해당 모델을 에디터 입력으로 감싼다. `UntitledTextEditorInputSerializer`(`untitledTextEditorHandler.ts`)가 재시작 시 상태 복원을 담당한다.

## 5. 에디터 자체와 Monaco

- VS Code는 `src/vs/editor`를 내부에 직접 포함한다. 텍스트 페인이 `src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts`의 `CodeEditorWidget`을 `IInstantiationService`로 생성하며(`textCodeEditor.ts`), 모델, 언어, 마커, 테마, 키바인딩 등은 워크벤치의 실제 구현 서비스를 주입받는다.
- `monaco-editor` 패키지는 동일한 `src/vs/editor`의 독립 실행형 패키지다. 진입점은 `src/vs/editor/editor.api.ts`(`createMonacoEditorAPI`를 `src/vs/editor/standalone/browser/standaloneEditor.ts`에서 가져옴)이며, 주요 API는 `standaloneEditor.ts`의 `create(domElement, options, override)`, `createModel(value, language, uri)`, `createDiffEditor`, `getModel`, `onDidCreateEditor`, `defineTheme`/`setTheme`, `colorize` 등이다.
- `create`는 `StandaloneServices.initialize(override || {})`를 통해 서비스 컬렉션을 초기화하고 `StandaloneEditor`(`standaloneCodeEditor.ts`, `extends StandaloneCodeEditor extends CodeEditorWidget`)를 인스턴스화한다. 서비스는 `src/vs/editor/standalone/browser/standaloneServices.ts`가 `registerSingleton`을 통해 독립 실행형 구현체를 등록한다: `StandaloneConfigurationService`, `StandaloneKeybindingService`, `StandaloneCommandService`, `StandaloneThemeService`, `StandaloneNotificationService`, `StandaloneWorkspaceContextService` 등이 해당한다. 단, 이 서비스 집합에는 에디터 그룹, 탭, `IEditorService`가 포함되어 있지 않다.

| 항목 | 패키지(`monaco-editor`)를 사용하는 워크벤치 | 소스를 직접 임베드하는 워크벤치(VS Code 방식) |
|---|---|---|
| 장점 | 완성된 형태의 에디터 엔진 활용 가능. 복잡한 설정 및 서비스 연결이 불필요하며 번들 크기와 버전 관리 경로가 단순하고 공개 API가 안정적이다. | 워크벤치 서비스(`IEditorService`, `ITextFileService`, `IModelService` 실구현체)와 직접 연동 가능. 동일 인스턴스를 다른 UI와 유연하게 공유하며 내부 심볼에 직접 접근할 수 있다. |
| 단점 | 그룹, 탭, 입력, 페인, 뷰 상태, 제목 없는 에디터, 파일 모델 등을 자체 구현해야 한다. 서비스 변경은 `override` 옵션으로만 가능하며, 내부 심볼 접근이 제한되고 확장 호스트 및 키바인딩 계약은 `Standalone*` 구현체로 대체된다. | 소스 동기화 및 빌드 유지보수 부담 증가(`src/vs/editor`가 워크벤치 서비스와 동일 커밋에 결합됨). 전체 번들 크기가 비대해진다. |
| 에디터 상태 보관 | 호스트 애플리케이션이 모델 및 뷰 상태(`saveViewState`)를 직접 저장한다. | `AbstractEditorWithViewState` + `EditorMemento` 경로를 활용한다. |

## 6. 드래그 앤 드롭

### 전송 데이터

- `LocalSelectionTransfer<T>`(`src/vs/platform/dnd/browser/dnd.ts`)는 애플리케이션 내부 드래그를 처리하는 싱글톤 저장소다. `getInstance()`, `setData(data, proto)`, `hasData(proto)`, `getData(proto)`, `clearData(proto)`를 노출한다. 데이터 종류는 프로토타입 객체로 식별한다.
- `src/vs/workbench/browser/dnd.ts`: `DraggedEditorIdentifier { identifier: IEditorIdentifier }`(에디터 및 그룹 id 식별자), `DraggedEditorGroupIdentifier { identifier: GroupIdentifier }`. 외부 파일 및 리소스 드래그는 `ResourcesDropHandler`가 전담한다.

### 탭 핸들러 (`MultiEditorTabsControl`)

- 드래그 시작: 선택된 모든 에디터를 `DraggedEditorIdentifier`로 감싸 `editorTransfer.setData`에 등록하고, `dataTransfer.effectAllowed = 'copyMove'`, 드래그 이미지, 외부 애플리케이션용 리소스 데이터(`doFillResourceDataTransfers`)를 설정한다. 탭 줄의 빈 공간 드래그는 `onGroupDragStart`(`editorTabsControl.ts`)가 담당하며 그룹 단위 전송으로 처리된다.
- 드래그 중: `updateDropFeedback`이 탭의 좌우 위치(`getTabDragOverLocation`)에 따라 삽입 지점 표시선을 그리고, 1500ms 이상 머무르면 해당 탭을 `preserveFocus` 옵션으로 연다.
- 드롭: 대상 인덱스(오른쪽 반이면 +1)를 정해 `onDrop`이 처리한다. 그룹 드롭은 `mergeGroup`(복사면 `MergeGroupMode.COPY_EDITORS`)이고, 에디터 드롭은 `isMoveOperation`이면 `sourceGroup.moveEditor`, 아니면 `copyEditor`. 같은 그룹에서 앞쪽을 뒤로 옮기면 인덱스를 하나 줄여 순서를 유지한다. 복사 수식키는 Windows/Linux에서 Ctrl, macOS에서 Alt(`isCopyIntoOtherGroup`).
- 드래그 종료(`onDragEnd`): 새 창으로 분리하는 동작(`transferToNewWindowAt`)일 경우 이동 또는 복사를 실행한다.

### 에디터 영역 오버레이 (`editorDropTarget.ts`)

- `EditorDropTarget`이 컨테이너의 `dragenter/leave/over/end` 이벤트를 감지하고 대상 그룹별로 `DropOverlay`를 생성한다. `DropOverlay.update`가 드래그 좌표에 맞춰 오버레이를 화면에 배치한다.
- 드롭 영역은 `getSplitDirection(mousePosX, mousePosY, width, height, isDraggingGroup, preferSplitVertically, splitsOnly)`가 계산하며 `GroupDirection | undefined`를 반환한다. `undefined`는 "그룹 내 병합(MERGE)"을 의미한다.

```text
가장자리 임계: 에디터 드래그는 폭/높이의 10%. 그룹 드래그는 선호 방향 쪽을 30%로 넓힘.
가장자리 안쪽(중앙): 분할 없음 = MERGE (splitsOnly면 가장 가까운 변으로 분할)
가장자리 띠 안에서는 아래 그림대로 방향을 정한다.

splitting 선호 = 세로(기본값, openSideBySideDirection === 'right')
 +--------+-----------+--------+
 |        | SPLIT UP  |        |  x가 가운데 1/3: y < 높이/2 -> UP
 | SPLIT  +-----------+ SPLIT  |
 | LEFT   |   MERGE   | RIGHT  |  x < 폭/3 -> LEFT, x > 폭*2/3 -> RIGHT
 |        | SPLIT DOWN|        |
 +--------+-----------+--------+

splitting 선호 = 가로(openSideBySideDirection === 'down')
 +-----------------------------+
 |           SPLIT UP          |  y < 높이/3
 +------------+-------+--------+
 | SPLIT LEFT | MERGE | SPLIT  |  x < 폭/2 -> LEFT, 그 외 RIGHT
 |            |       | RIGHT  |
 +------------+-------+--------+
 |          SPLIT DOWN         |  y > 높이*2/3
 +-----------------------------+
```

(위 그림은 `getSplitDirection` 내부 주석의 도식을 본 문서 표기에 맞춰 요약한 것이다. 원본 구현은 해당 함수 코드를 참조한다.)

- 선호 방향은 `DropOverlay.positionOverlay`가 `partOptions.openSideBySideDirection === 'right'`로 정해 `preferSplitVertically`로 넘긴다. 설정 `workbench.editor.openSideBySideDirection`의 기본값은 `right`(`src/vs/workbench/browser/parts/editor/editor.ts`의 `DEFAULT_EDITOR_PART_OPTIONS`)이므로 기본 동작은 위쪽 그림이다.

- 오버레이는 탭 줄 하단 영역만 덮는다: `getDropAreaOffsetHeight`는 에디터가 존재하고 `showTabs === 'multiple'`일 때 `titleHeight.offset` 높이를 제외한다.
- 드롭 실행 `DropOverlay.handleDrop`: 분할 동작일 경우 `ensureTargetGroup`이 `editorGroupService.addGroup(groupView, splitDirection)`를 호출한다(그룹 드래그 시 복사면 `copyGroup`, 이동이면 `moveGroup`, 병합은 `mergeGroup`). 소스 그룹의 마지막 에디터를 이동하며 `closeEmptyGroups` 설정이 켜져 있고 분할인 경우, 에디터 개별 이동 대신 `moveGroup`으로 그룹 전체를 통째로 이전하는 최적화를 수행한다. 그 외의 경우에는 `sourceGroup.moveEditors/copyEditors(prepareMoveCopyEditors(...), targetGroup)`를 호출한다. 마지막으로 대상 그룹에 포커스를 맞춘다.

### 드롭이 제공되지 않는 경우

| 경우 | 동작 (심볼) |
|---|---|
| 설정 `allowDropIntoGroup`이 꺼져 있음 | `EditorDropTarget.onDragEnter`가 `dropEffect = 'none'`으로 설정 |
| 지원하지 않는 전송 형식(파일/리소스/에디터/기여 형식이 아님) | `containsDragType` 검사 실패 시 `dropEffect = 'none'`으로 설정 |
| 입력 위젯이 직접 드롭을 처리하는 위치(`isInputDropTargetEvent`) | 오버레이를 숨기고 입력 위젯이 처리하도록 위임 |
| 콘텐츠 영역이 직접 드롭을 수신하는 위치(`isContentDropTargetEvent`) | 에디터/그룹 드래그가 분할을 유도하지 않았다면 오버레이 제거 |
| 동일 그룹 내 드롭인데 결과가 빈 그룹이 되는 경우 | `DropOverlay.update`: 복사가 아니고 소스와 대상이 일치하며, 그룹 드래그이거나 `count < 2`인 경우 `hideOverlay` 호출 |
| 분할 비활성화(`splitOnDragAndDrop` 꺼짐, 또는 `supportsSplitting`이 false) | 분할 영역 구분 없이 전체를 MERGE로 처리. `Alt`(macOS는 `Shift`) 키를 눌러 동작을 반전 가능(`isToggleSplitOperation`) |
| `Singleton` 입력인 경우 | 복사 동작으로 취급되지 않으며(`isCopyOperation`), 분할 및 복사 불가 |
| 다른 파트로 이동할 때 입력이 이전을 거부하는 경우 | `isTransferVetoed`가 `getEditorsTransferVeto`를 확인한 뒤 사용자에게 안내하고 전송을 취소 |
| 로컬 전송 데이터가 없는 경우(외부 드래그) | `dropEffect = 'copy'`로 강제 지정하고 `ResourcesDropHandler` 경로로 처리 |
| 오버레이 정리 예외 처리 | 마우스가 오버레이 위에서 비정상 감지되면 `cleanupOverlayScheduler`(300ms)로 제거(가상 머신/호스트 OS 간 DnD 버그 방지) |

## 7. 이 워크벤치에 주는 시사점

(상단은 사실 관계 요약이며, 하단은 설계 해석이다.)

- writing-room의 에디터 파트가 동일한 계층 분리를 적용한다면: 모델(순서/미리보기/고정/MRU)은 DOM 의존성 없이 독립적으로 단위 테스트가 가능하고, 뷰는 모델 이벤트를 구독하여 화면을 갱신하며, 입력과 페인은 레지스트리 패턴으로 느슨하게 결합할 수 있다.
- 그리드 엔진이 `SerializableGrid` 형태로 구현되어 있다면 그룹 추가/제거/이동은 단순 `addView`/`removeView`/`moveView` 메서드 호출로 캡슐화되며, 상태 저장은 `serialize()` 결과에 `activeGroup` 및 최근 활성 목록을 병합하는 방식으로 구성된다(`IEditorPartUIState`).
- 에디터 병합과 분할 판정 로직을 `getSplitDirection`과 같은 순수 함수로 분리하면 DOM 환경 없이도 정확하게 검증할 수 있다.
- Monaco 독립형 패키지를 채택할 경우 위 5절 비교표의 "단점"(그룹/탭/입력/상태 관리)에 해당하는 영역이 writing-room에서 직접 구현해야 할 핵심 범위가 된다.

Decided in: wr-e8v6
