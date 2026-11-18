# VS Code의 상태와 설정

VS Code가 UI 상태(어떤 파트가 보이는지, 어떤 에디터가 열려 있는지)와 사용자 설정(`settings.json`)을 어디에 어떻게 보관하는지 정리한다. 두 가지는 저장소가 다르다. 상태는 키-값 스토리지 서비스(웹에서는 IndexedDB)에, 설정은 설정 서비스가 파일 서비스를 통해 읽고 쓰는 JSON 파일에 있다. 모든 경로와 심볼은 [README.md](README.md)에 적힌 고정 커밋에서 확인했다. 이 워크벤치의 대응 경로는 [architecture.md](architecture.md)의 대응표를 본다.

범위 밖(이름만 적는다): 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 고정 커밋의 `src/vs/workbench/browser/layout.ts`에는 채팅과 보조 사이드바 관련 키도 섞여 있지만 이 페이지는 v0.1.0이 따르는 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄) 쪽만 다룬다.

## 한눈에 보기

| 질문 | 답 | 근거 심볼 |
| --- | --- | --- |
| 상태는 어디에 저장되는가 | 웹에서는 IndexedDB. 스코프마다 데이터베이스가 따로 있다 | `src/vs/workbench/services/storage/browser/storageService.ts`의 `BrowserStorageService`, `IndexedDBStorageDatabase` |
| 설정은 어디에 저장되는가 | 사용자 프로필의 `settings.json` 파일. 파일 서비스가 읽고 쓴다. 웹에서 그 파일 시스템은 또 다른 IndexedDB 데이터베이스다 | `src/vs/workbench/browser/web.main.ts`의 `registerIndexedDBFileSystemProviders`, `src/vs/workbench/services/configuration/browser/configurationService.ts`의 `WorkspaceService` |
| 누가 저장을 요청하는가 | 저장 직전 `onWillSaveState` 이벤트를 받은 컴포넌트가 자기 상태를 스토리지에 쓴다 | `src/vs/platform/storage/common/storage.ts`의 `IStorageService.onWillSaveState`, `src/vs/workbench/common/component.ts`의 `Component` |
| 패널은 처음에 보이는가 | 아니오. 기본값이 숨김이다 | `src/vs/workbench/browser/layout.ts`의 `LayoutStateKeys.PANEL_HIDDEN` |

## 1. 스토리지 서비스

### 1.1 계약: `IStorageService`

파일: `src/vs/platform/storage/common/storage.ts`.

| 심볼 | 무엇을 결정하는가 |
| --- | --- |
| `IStorageService` | 동기 읽기(`get`, `getBoolean`, `getNumber`, `getObject`), 쓰기(`store`, `remove`), `keys`, `isNew`, `flush`, `optimize`, 변경 이벤트(`onDidChangeValue`, `onDidChangeTarget`, `onWillSaveState`)의 표면. 읽기는 동기이고 쓰기는 호출 즉시 메모리 캐시에 반영된다 |
| `StorageScope` | 값이 얼마나 넓게 공유되는가. `APPLICATION_SHARED = -2`(모든 워크스페이스와 프로필, 앱 사이에서도 공유), `APPLICATION = -1`(모든 워크스페이스와 프로필), `PROFILE = 0`(같은 프로필의 모든 워크스페이스), `WORKSPACE = 1`(현재 워크스페이스) |
| `StorageTarget` | 값이 사용자 것인가 머신 것인가. `USER`(머신 사이에서 동기화 대상), `MACHINE`(이 머신 전용). 스코프와 독립적인 두 번째 축이다 |
| `store(key, value, scope, target)` | 쓸 때마다 스코프와 타깃을 반드시 함께 준다. `undefined`나 `null`을 저장하면 키를 지운다 |
| `AbstractStorageService` | 백엔드와 무관한 공통 로직. 키별 타깃 기록(`updateKeyTarget`, 저장소 안의 `TARGET_KEY` 항목), `isNew`(`IS_NEW_KEY` 항목), `flush`, 주기적 유휴 플러시(`flushWhenIdleScheduler`, 기본 `DEFAULT_FLUSH_INTERVAL`은 1분)를 구현하고, 백엔드가 `getStorage(scope)`와 `doInitialize`를 채운다 |
| `WillSaveStateReason` | `NONE`(그냥 저장해 달라), `SHUTDOWN`(곧 종료). `flush(SHUTDOWN)`은 지연 없이 즉시 플러시한다 |

- 타깃은 값 옆이 아니라 별도 항목(`TARGET_KEY`)에 키별로 기록된다. `keys(scope, target)`가 타깃별 필터를 할 수 있는 이유다. `TARGET_KEY`가 바뀌면 `emitDidChangeValue`는 값 이벤트가 아니라 `onDidChangeTarget`으로 내보낸다.
- `store`와 `remove`는 `withPausedEmitters` 안에서 타깃 기록과 값 쓰기를 한 번에 하고 이벤트를 나중에 내보낸다.

### 1.2 캐시와 데이터베이스: `Storage`

파일: `src/vs/base/parts/storage/common/storage.ts`.

| 심볼 | 무엇을 결정하는가 |
| --- | --- |
| `IStorageDatabase` | 백엔드가 만족해야 하는 계약: `getItems`, `updateItems`, `optimize`, `close`, 그리고 다른 창이 쓴 것을 알리는 `onDidChangeItemsExternal` |
| `Storage` | `IStorageDatabase` 하나를 감싸는 메모리 캐시. `init`에서 `database.getItems()`로 전체를 `cache`(`Map<string, string>`)에 한 번에 읽는다. 이후 `get*`은 캐시에서만 읽는다 |
| `Storage.set`, `Storage.delete` | 캐시를 즉시 바꾸고, 변경 내용을 `pendingInserts`와 `pendingDeletes`에 쌓고, `onDidChangeStorage`를 내보낸 뒤 `doFlush`로 쓰기를 예약한다. 같은 값이면 아무것도 하지 않는다 |
| `Storage.DEFAULT_FLUSH_DELAY` | 100ms. `ThrottledDelayer`가 짧은 시간의 여러 쓰기를 한 번의 `updateItems`로 묶는다 |
| `Storage.flush`, `whenFlushed`, `close` | `close`는 `doFlush(0)`을 한 번 더 돌린 뒤 `database.close`를 부른다. 플러시가 실패해도 닫는다 |
| `StorageHint` | `STORAGE_DOES_NOT_EXIST`는 초기 읽기를 건너뛴다. `STORAGE_IN_MEMORY`는 디바운스 없이 플러시한다 |
| `InMemoryStorageDatabase` | 메모리 전용 데이터베이스. IndexedDB 연결이 실패했을 때의 대체 수단이다(1.3절) |

### 1.3 브라우저 백엔드: `BrowserStorageService`

파일: `src/vs/workbench/services/storage/browser/storageService.ts`.

**스코프마다 하나씩, 별도 IndexedDB 데이터베이스**

| 스코프 | 만드는 함수 | 데이터베이스 id | 다른 창에 알리는가 |
| --- | --- | --- | --- |
| `APPLICATION` | `IndexedDBStorageDatabase.createApplicationStorage` | `global` | 예(`broadcastChanges: true`) |
| `APPLICATION_SHARED` | `createApplicationSharedStorage` | `global-shared` | 예 |
| `PROFILE` | `createProfileStorage` | `global-<프로필 id>`. 기본 프로필(`isProfileUsingDefaultStorage`)은 위의 `global`과 같은 `Storage` 인스턴스를 재사용한다 | 예 |
| `WORKSPACE` | `createWorkspaceStorage` | `<워크스페이스 id>` | 아니오(옵션 없음) |

- 실제 IndexedDB 이름은 접두어 `vscode-web-state-db-`(`STORAGE_DATABASE_PREFIX`)에 위 id를 붙인 것이고, 객체 저장소는 하나, `ItemTable`(`STORAGE_OBJECT_STORE`)이다. 키와 값 모두 문자열이다.
- 이 데이터베이스는 설정 파일을 담는 `vscode-web-db`(`web.main.ts`의 `registerIndexedDBFileSystemProviders`)와 별개다(2절).
- `BrowserStorageService.doInitialize`는 네 스토리지를 `Promises.settled`로 병렬로 연다. `web.main.ts`의 `createStorageService`가 `initialize()`를 `await`한 뒤에야 워크벤치가 서비스를 쓴다. 따라서 읽기가 동기여도 안전하다.
- `IndexedDBStorageDatabase.create`는 연결에 실패하면 로그를 남기고 `InMemoryIndexedDBStorageDatabase`를 돌려준다. IndexedDB가 막힌 브라우저에서도 세션 동안은 동작하지만 새로고침하면 사라진다.

**언제 디스크(IndexedDB)에 쓰는가**

| 계층 | 간격 | 심볼 |
| --- | --- | --- |
| 값 변경 후 쓰기 묶음 | 100ms | `Storage.DEFAULT_FLUSH_DELAY` |
| 주기적 상태 수집(`onWillSaveState`) | 5초. 기본 1분이 아니라 브라우저용으로 줄였다. 이유는 소스 주석대로 종료 시점에 비동기 작업을 믿을 수 없기 때문이다 | `BrowserStorageService.BROWSER_DEFAULT_FLUSH_INTERVAL` |
| 주기 플러시 건너뛰기 | 문서에 포커스가 없거나 진행 중인 쓰기(`hasPendingUpdate`)가 있으면 건너뛴다 | `BrowserStorageService.shouldFlushWhenIdle` |
| 종료 | `beforeunload`와 `shutdown`에서 `flush(WillSaveStateReason.SHUTDOWN)`. 브라우저가 끝까지 실행해 준다는 보장이 없어서 낙관적으로 부른다 | `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts`의 `doShutdown`, `shutdown`, `withExpectedShutdown` |

- `close()`는 Safari에서만 데이터베이스를 명시적으로 닫는다(멈춤 이슈 우회). 다른 브라우저는 언로드 때 쓰기가 일어나도록 연결을 열어 둔다. 어느 쪽이든 `dispose()`한다.
- `clear()`는 모든 키를 지우고 데이터베이스를 비운다. `web.main.ts`의 `registerDeveloperActions`가 등록하는 `workbench.action.resetUserData`가 `provider.reset()`과 함께 부른다.

**두 탭이 서로의 쓰기를 아는 방법**

1. `IndexedDBStorageDatabase.updateItems`가 쓰기에 성공하면, `broadcastChanges`가 켜진 데이터베이스는 `{ changed, deleted }`를 `BroadcastDataChannel`(`src/vs/base/browser/broadcast.ts`)에 `postData`한다. 채널 이름은 데이터베이스 이름이다.
2. 다른 탭의 같은 이름 데이터베이스가 `onDidReceiveData`로 받아 `isStorageItemsChangeEvent`로 검사한 뒤 `onDidChangeItemsExternal`을 내보낸다.
3. `Storage.onDidChangeItemsExternal`이 이벤트를 `acceptExternal`로 캐시에 받아들인다. 값이 달라졌을 때만 `onDidChangeStorage({ key, external: true })`를 내보낸다.
4. `AbstractStorageService.emitDidChangeValue`가 `scope`와 `external`을 붙여 `onDidChangeValue` 구독자에게 전달한다.

- 탭 사이에서 캐시를 직접 읽는 일은 없다. 다른 탭이 쓴 값은 이벤트를 거쳐 내 캐시에 들어온다.
- `WORKSPACE` 데이터베이스는 `broadcastChanges`를 켜지 않으므로 이 경로가 없다. 같은 워크스페이스를 두 탭에서 열어도 서로의 워크스페이스 쓰기를 이 메커니즘으로는 받지 못한다.
- 마지막 쓰기가 이긴다. 두 탭이 같은 키를 쓰면 나중에 플러시한 쪽 값이 남는다.
- `compareAndSwapApplicationStorage`와 `compareAndSwapApplicationSharedValue`는 IndexedDB 트랜잭션 안에서 기대값과 비교한 뒤 쓴다. 이 경로는 일반 `store`와 달리 캐시를 거치지 않고 데이터베이스를 직접 읽는다(`readApplicationSharedValue`, `getApplicationStorageValue`).

**프로필 전환**: `BrowserStorageService.switchToProfile`은 옛 프로필 스토리지를 닫고(기본 프로필이면 닫지 않는다) 새 프로필 스토리지를 열고, `switchData`로 변경된 키마다 이벤트를 낸다. `switchToWorkspace`는 웹에서 미지원이다(`Error`를 던진다).

## 2. 누가 무엇을 언제 저장하는가

### 2.1 컴포넌트의 저장 경로: `Component`와 `Memento`

| 심볼 | 파일 | 역할 |
| --- | --- | --- |
| `Component` | `src/vs/workbench/common/component.ts` | 생성자에서 `storageService.onWillSaveState`를 구독한다. 이벤트가 오면 (1) 하위 클래스의 `saveState()`로 상태를 memento 객체에 쓰게 하고 (2) `memento.saveMemento()`로 그 객체를 스토리지에 쓴다. `getMemento(scope, target)`, `reloadMemento`, `onDidChangeMementoValue`를 하위 클래스에 제공한다 |
| `Memento` | `src/vs/workbench/common/memento.ts` | `id` 앞에 `memento/` 접두어(`COMMON_PREFIX`)를 붙인 키 하나에 객체 전체를 JSON으로 저장한다. 스코프별 정적 맵(`workspaceMementos`, `profileMementos`, `applicationMementos`, `applicationSharedMementos`)에 `ScopedMemento`를 하나씩 두어 같은 id는 같은 객체를 공유한다 |
| `ScopedMemento` | 같은 파일 | 처음 `getMemento`를 부를 때 `getObject`로 로드한다(파싱 오류는 로그만 남기고 빈 객체). `save()`는 객체가 비어 있으면 키를 삭제하고 아니면 `store`한다. `reload()`는 같은 객체를 비우고 다시 채운다(참조를 유지한다) |

- 동작 순서: 컴포넌트가 평소에는 필드(메모리)만 바꾸고, 저장 시점에 `saveState()`가 memento 객체에 옮겨 쓰며, `saveMemento()`가 스토리지에 쓰고, `Storage`가 100ms 지연 뒤 IndexedDB에 쓴다.
- memento는 처음 요청한 `(scope, target)`을 `ScopedMemento`에 고정한다. 같은 id를 나중에 다른 타깃으로 요청해도 첫 타깃이 쓰인다.
- 컴포넌트가 아닌 코드(상태 표시줄 모델 등)는 `onWillSaveState`나 값 변경 시점에 `storageService.store`를 직접 부른다. 아래 표의 "경로" 열이 구분한다.

### 2.2 저장 항목 목록

| 상태 | 키 또는 심볼 | 스코프 / 타깃 | 경로 | 파일 |
| --- | --- | --- | --- | --- |
| 레이아웃: 파트 표시, 위치, 크기, 중앙 정렬 에디터 | `workbench.<name>` 키들(3절) | 키마다 다름 | `LayoutStateModel.save`가 `onWillSaveState`에서 | `src/vs/workbench/browser/layout.ts` |
| 에디터 파트: 그리드 배치, 활성 그룹, 그룹 최근 사용 순서 | memento `editorpart.state`(`IEditorPartUIState`: `serializedGrid`, `activeGroup`, `mostRecentActiveGroups`) | `WORKSPACE` / `USER` | `EditorPart.saveState`가 `createState()`로 만들어 memento에 | `src/vs/workbench/browser/parts/editor/editorPart.ts` |
| 중앙 정렬 보기 | memento `editorpart.centeredview` | `PROFILE` / `MACHINE` | `EditorPart.saveState`. 기본값이면 삭제 | 같은 파일 |
| 각 그룹 안의 열린 에디터와 순서 | `ISerializedEditorGroupModel`(`id`, `locked`, `editors`, `mru`, `preview`, `sticky`)이 `serializedGrid`의 리프에 들어간다 | `editorpart.state`에 포함 | `EditorGroupView.toJSON`이 `EditorGroupModel.serialize()`를 부른다 | `src/vs/workbench/browser/parts/editor/editorGroupView.ts`, `src/vs/workbench/common/editor/editorGroupModel.ts` |
| 에디터를 연 순서(전체) | 키 `editors.mru` | `WORKSPACE` / `MACHINE` | `EditorsObserver.saveState`가 `onWillSaveState`에서 | `src/vs/workbench/browser/parts/editor/editorsObserver.ts` |
| 에디터별 뷰 상태(커서, 스크롤) | `EditorMemento`가 페인 memento 안에 최대 10개(`limit`)까지 LRU | `WORKSPACE` / `MACHINE` | `EditorPane.saveState`, `AbstractEditorWithViewState.saveState` | `src/vs/workbench/browser/parts/editor/editorPane.ts`, `editorWithViewState.ts` |
| 뷰 컨테이너와 뷰의 위치 재배치 | 키 `views.customizations`(`IViewsCustomizations`: `viewContainerLocations`, `viewLocations`, `viewContainerBadgeEnablementStates`) | `PROFILE` / `USER` | 변경 즉시 `setStoredViewCustomizationsValue` | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` |
| 사이드바와 패널에서 마지막으로 활성이던 뷰 컨테이너 | 키 `workbench.sidebar.activeviewletid`(`SidebarPart.activeViewletSettingsKey`), `workbench.panelpart.activepanelid`(`PanelPart.activePanelSettingsKey`) | `WORKSPACE` / `MACHINE` | 컴포지트를 열 때 `CompositePart.showComposite`가 저장. 기본 컴포지트면 키를 지운다 | `src/vs/workbench/browser/parts/compositePart.ts`, `sidebar/sidebarPart.ts`, `panel/panelPart.ts` |
| 액티비티 바 고정/숨김 상태 | `PaneCompositeBar`의 `pinnedViewContainersKey`, `placeholderViewContainersKey`, `viewContainersWorkspaceStateKey` 옵션이 가리키는 키 | `PROFILE`(고정은 `USER`, 자리표시자는 `MACHINE`), 워크스페이스 상태는 `WORKSPACE` | 변경 즉시 | `src/vs/workbench/browser/parts/paneCompositeBar.ts` |
| 상태 표시줄에서 숨긴 항목 | 키 `workbench.statusbar.hidden` | `PROFILE` / `USER` | `StatusbarViewModel.saveState`가 변경 즉시 | `src/vs/workbench/browser/parts/statusbar/statusbarModel.ts` |

- 에디터 직렬화: 에디터 입력이 복원 가능하려면 `EditorInput` 종류마다 `IEditorSerializer`(`canSerialize`, `serialize`, `deserialize`)를 `Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer`로 등록해야 한다. 정의는 `src/vs/workbench/common/editor.ts`, 등록 예는 `src/vs/workbench/browser/parts/editor/editor.contribution.ts`(`UntitledTextEditorInputSerializer`, `SideBySideEditorInputSerializer`, `DiffEditorInputSerializer`).
- `EditorGroupModel.serialize`는 직렬화기가 없거나 `canSerialize`가 거짓이거나 `serialize`가 문자열을 주지 않는 에디터를 건너뛰고, 건너뛴 만큼 `mru`, `preview`, `sticky` 인덱스를 다시 계산한다. 즉 복원되지 않는 에디터는 최근 사용 순서에서도 사라진다.
- 에디터 파트가 비어 있으면(`isEmpty`) `editorpart.state`를 지운다. 복원 쪽(`doCreateGridControlWithPreviousState`)은 `loadState()`의 `serializedGrid`가 있어야 그리드를 되살리고, 오류가 나면 로그를 남기고 그룹을 지워 빈 상태로 시작한다.
- 에디터 파트는 `onDidChangeMementoValue(StorageScope.WORKSPACE)`를 구독한다. 외부(`e.external`) 워크스페이스 변경이 오면 `reloadMemento` 뒤 `applyState`로 다른 창의 상태를 받아들인다. 1.3절에서 보았듯 웹의 `WORKSPACE` 데이터베이스는 방송하지 않으므로 이 경로는 웹 백엔드에서는 사실상 발화하지 않는다. 방송을 켜는 백엔드(예: 데스크톱)를 위한 코드다.

### 2.3 레이아웃 상태: `LayoutStateModel`과 `LayoutStateKeys`

파일: `src/vs/workbench/browser/layout.ts`. 둘 다 이 파일 안의 모듈 비공개 심볼이다(`export`되지 않는다). `Layout.initLayoutState`가 `new LayoutStateModel(...)`로 만들고 `load({ mainContainerDimension, resetLayout })`를 부른다.

**키 종류**

- `RuntimeStateKey`: 실행 중에 바뀌고 `getRuntimeValue`/`setRuntimeValue`로 읽고 쓴다.
- `InitializationStateKey`: 시작할 때만 값이 쓰이고(`getInitializationValue`), 저장 직전에 `onWillSaveState`에서 현재 그리드 크기를 읽어 `setInitializationValue`로 갱신한다. 파트 크기 세 개(`SIDEBAR_SIZE`, `PANEL_SIZE`, `AUXILIARYBAR_SIZE`)가 이 종류다.

**이 페이지의 여섯 파트에 해당하는 키**

저장소 키는 `LayoutStateModel.STORAGE_PREFIX`(`workbench.`) 뒤에 `name`을 붙인 것이다.

| `LayoutStateKeys` | name | 스코프 / 타깃 | 기본값 |
| --- | --- | --- | --- |
| `ACTIVITYBAR_HIDDEN` | `activityBar.hidden` | `WORKSPACE` / `MACHINE` | `false`(설정 `workbench.activityBar.location`이 `default`가 아니면 로드 시 덮어쓴다. `zenModeIgnore`) |
| `SIDEBAR_HIDDEN` | `sideBar.hidden` | `WORKSPACE` / `MACHINE` | `false`. 로드 때 `defaultValue`를 `workbenchState === WorkbenchState.EMPTY`로 바꾼다. 즉 폴더가 없는 빈 워크스페이스에서는 숨김이 기본이다 |
| `PANEL_HIDDEN` | `panel.hidden` | `WORKSPACE` / `MACHINE` | **`true`. 패널은 숨겨진 채로 시작한다** |
| `EDITOR_HIDDEN` | `editor.hidden` | `WORKSPACE` / `MACHINE` | `false`. 패널과 에디터가 둘 다 숨김으로 로드되면 `applyOverrides`가 에디터를 다시 보이게 한다(보조 사이드바가 최대화된 경우 제외) |
| `STATUSBAR_HIDDEN` | `statusBar.hidden` | `WORKSPACE` / `MACHINE` | `false`(설정 `workbench.statusBar.visible`로 덮어쓴다. `zenModeIgnore`) |
| `SIDEBAR_POSITON`(철자 그대로) | `sideBar.position` | `WORKSPACE` / `MACHINE` | `Position.LEFT`(설정 `workbench.sideBar.location`으로 덮어쓴다) |
| `PANEL_POSITION` | `panel.position` | `WORKSPACE` / `MACHINE` | 설정 `workbench.panel.defaultLocation`, 없으면 `Position.BOTTOM` |
| `PANEL_ALIGNMENT` | `panel.alignment` | `PROFILE` / `USER` | `'center'` |
| `SIDEBAR_SIZE` | `sideBar.size` | `PROFILE` / `MACHINE` | `Math.min(300, 창 너비 / 4)`(로드 때 계산) |
| `PANEL_SIZE` | `panel.size` | `PROFILE` / `MACHINE` | 패널이 가로면 `창 높이 / 3`, 세로면 `창 너비 / 4` |
| `PANEL_LAST_NON_MAXIMIZED_HEIGHT`, `PANEL_LAST_NON_MAXIMIZED_WIDTH`, `PANEL_WAS_LAST_MAXIMIZED` | `panel.lastNonMaximizedHeight` 등 | 앞 둘 `PROFILE`, 마지막 `WORKSPACE` / `MACHINE` | 300, 300, `false` |
| `MAIN_EDITOR_CENTERED` | `editor.centered` | `WORKSPACE` / `MACHINE` | `false` |
| `ZEN_MODE_ACTIVE`, `ZEN_MODE_EXIT_INFO` | `zenMode.active`, `zenMode.exitInfo` | `WORKSPACE` / `MACHINE` | `false`, 복귀 정보 객체 |

보조 사이드바(`AUXILIARYBAR_*`)와 채팅 관련 키(`EDITOR_HIDDEN_BY_CHAT`)는 범위 밖이다.

**흐름**

1. `load`가 `resetLayout`이 아니면 모든 키를 `loadKeyFromStorage`로 읽는다. 기본값 타입(`boolean`, `number`, `object`)으로 문자열을 되돌린다.
2. 레거시 설정 세 개(활동 표시줄 위치, 상태 표시줄 표시, 사이드바 위치)를 설정 서비스에서 읽어 캐시를 덮어쓴다. 즉 이 세 값은 저장소 값보다 설정이 우선한다.
3. 동적 기본값(크기, 사이드바 숨김, 패널 위치)을 계산한 뒤 아직 비어 있는 키에 기본값을 채운다.
4. `applyOverrides`가 시작 시 불가능한 조합을 고친다.
5. 실행 중 `setRuntimeValue`는 캐시를 바꾼다. 스코프가 `PROFILE`인 키만 그 자리에서 `saveKeyToStorage`까지 한다. `WORKSPACE` 키는 캐시에만 있다가 저장 시점에 쓰인다.
6. `Layout`이 `onWillSaveState`에서 세 파트 크기를 그리드에서 읽어 `setInitializationValue`로 갱신한 뒤 `stateModel.save(true, true)`를 부른다. 이 인자는 "워크스페이스 키 저장, 프로필 키 저장"이다. 젠 모드에서는 `zenModeIgnore` 키를 쓰지 않는다(젠 모드가 숨긴 것을 영구 저장하지 않기 위해서).
7. 프로필 스코프이면서 `USER` 타깃인 `RuntimeStateKey`(현재는 `PANEL_ALIGNMENT`)는 `storageService.onDidChangeValue(StorageScope.PROFILE, ...)`를 구독해 다른 창이 바꾼 값을 받아 `onDidChangeState`를 내보낸다.
8. `LayoutStateModel`은 `isNew`를 스코프별로 기록한다(`storageService.isNew`와, 저장된 키가 하나라도 읽히면 `false`로). 첫 실행인지에 따라 보조 사이드바 기본값과 작은 창 크기 보정이 달라진다.

- `updateLegacySettingsFromState`는 활동 표시줄, 상태 표시줄, 사이드바 위치를 설정으로 되쓰는 코드지만 `setRuntimeValue`에서 `PROFILE` 스코프 분기 안에서만 불린다. 위 세 키는 `WORKSPACE` 스코프라서 이 커밋의 코드를 읽으면 그 경로가 실제로 실행되지 않는다. 확인은 읽기 기준이며 실행해 보지는 않았다.
- 기본값의 "패널 숨김"은 영구 정책이 아니라 키의 기본값일 뿐이다. 사용자가 패널을 열면 `setPanelHidden`이 `PANEL_HIDDEN`을 `false`로 바꾸고 다음 저장 때 `workbench.panel.hidden = false`가 기록되어 다음 시작에서도 열려 있다.

### 2.4 이 섹션이 이 워크벤치에 주는 시사점

사실과 구분한다. 아래는 해석이다.

- 설계 단위 세 가지를 따로 만들 필요가 있다: (a) 스코프 x 타깃 키-값 저장소, (b) 저장 시점 알림(`onWillSaveState`)과 이를 받는 컴포넌트 기반 클래스, (c) 레이아웃 상태 모델.
- v0.1.0이 영속성을 포함하므로 최소한 에디터 파트 상태와 레이아웃 상태가 새로고침 후 복원되어야 한다. 그러려면 에디터 입력마다 직렬화기(`IEditorSerializer`에 해당)가 필요하다.
- 같은 키를 여러 탭이 쓰는 문제를 어떻게 다룰지(마지막 쓰기 승리, 방송 여부)는 VS Code가 스코프별로 다르게 둔 결정이므로 이 워크벤치도 명시해야 한다.

## 3. 설정

### 3.1 서비스 계약과 스코프

| 심볼 | 파일 | 무엇을 결정하는가 |
| --- | --- | --- |
| `IConfigurationService` | `src/vs/platform/configuration/common/configuration.ts` | `getValue`, `updateValue`, `inspect`, `reloadConfiguration`, `keys`, `onDidChangeConfiguration`. 읽기는 동기 |
| `ConfigurationTarget` | 같은 파일 | 쓰기와 `inspect` 결과의 층: `APPLICATION`, `USER`, `USER_LOCAL`, `USER_REMOTE`, `WORKSPACE`, `WORKSPACE_FOLDER`, `DEFAULT`, `MEMORY` |
| `IConfigurationValue`, `isConfigured` | 같은 파일 | `inspect`가 층별 값(`defaultValue`, `userValue` 등)을 돌려준다. `isConfigured`는 사용자가 명시했는지 판별한다 |
| `ConfigurationRegistry`(`IConfigurationRegistry`) | `src/vs/platform/configuration/common/configurationRegistry.ts` | 설정 선언의 레지스트리. `registerConfiguration`으로 `IConfigurationNode`(속성, 기본값, 타입, `scope`)를 등록한다. `registerDefaultConfigurations`는 기본값 재정의(예: 언어별 기본값, `configurationDefaults`)를 등록한다. `getConfigurationProperties`가 전체 속성 사전을 준다. 레지스트리 키는 `Extensions.Configuration` |
| `ConfigurationScope` | 같은 파일 | 속성이 어느 층에서 설정될 수 있는가: `APPLICATION`, `MACHINE`, `APPLICATION_MACHINE`, `WINDOW`, `RESOURCE`, `LANGUAGE_OVERRIDABLE`, `MACHINE_OVERRIDABLE`. 스코프별 허용 속성 사전(`applicationSettings`, `machineSettings`, `windowSettings`, `resourceSettings` 등)이 등록 시 채워지고, 사용자 `settings.json`을 읽을 때 허용 범위를 거른다 |
| `DefaultConfiguration` | `src/vs/platform/configuration/common/configurations.ts` | 레지스트리의 기본값을 `ConfigurationModel`로 만들고 `onDidUpdateConfiguration`을 구독해 갱신한다 |
| `Configuration`(`getValue`, `inspect`) | `src/vs/platform/configuration/common/configurationModels.ts` | 층별 `ConfigurationModel`을 합쳐(`getConsolidatedConfigurationModel`) 값을 낸다 |

### 3.2 워크벤치 서비스: `WorkspaceService`

파일: `src/vs/workbench/services/configuration/browser/configurationService.ts`. `IConfigurationService`와 `IWorkspaceContextService`를 하나의 클래스가 구현한다(`IWorkbenchConfigurationService`).

| 구성 요소 | 하는 일 |
| --- | --- |
| `defaultConfiguration` | 브라우저용 `DefaultConfiguration`(`src/vs/workbench/services/configuration/browser/configuration.ts`). 웹 옵션의 `configurationDefaults`를 등록하고, 기본값 재정의를 캐시한다 |
| `policyConfiguration` | 정책으로 고정된 값 |
| `applicationConfiguration` | 프로필이 기본이 아닐 때 `APPLICATION` 스코프 설정을 기본 프로필의 `settingsResource`에서 읽는다(`ApplicationConfiguration`) |
| `localUserConfiguration` | `UserConfiguration`. 현재 프로필의 `settingsResource`를 `IFileService`로 읽고 `fileService.watch`와 파일 변경 이벤트로 다시 읽는다 |
| `workspaceConfiguration`, `cachedFolderConfigs` | 워크스페이스 파일과 폴더의 `.vscode/settings.json` |
| `configurationCache`(`ConfigurationCache`) | 네이티브가 아닌 리소스의 설정을 캐시 디렉터리에 저장해 다음 시작을 빠르게 한다. 웹에서는 `Schemas.file`, `Schemas.vscodeUserData`, `Schemas.tmp`를 제외한다고 `web.main.ts`의 `createWorkspaceService`가 지정한다 |

- 읽기: `getValue`/`inspect`는 합쳐진 `Configuration`에서 동기로 답한다. 우선순위는 기본값, 사용자(애플리케이션 포함), 워크스페이스, 폴더 순이고 뒤가 앞을 덮는다.
- 쓰기: `updateValue(key, value, target)`는 `MEMORY`이면 메모리 모델만 바꾸고 이벤트를 낸다. 그 밖의 타깃은 `toEditableConfigurationTarget`으로 편집 가능한 타깃으로 바꾼 뒤 `ConfigurationEditing.writeConfiguration`(`src/vs/workbench/services/configuration/common/configurationEditing.ts`)에 맡긴다. `ConfigurationEditing`은 `Queue`로 쓰기를 직렬화하고, JSON 편집(`setProperty`, `src/vs/base/common/jsonEdit.ts`)을 텍스트 모델에 적용해 파일을 저장한다. 끝나면 해당 층을 다시 읽어(`reloadLocalUserConfiguration` 등) `onDidChangeConfiguration`을 낸다. `DEFAULT` 타깃은 쓸 수 없다(`'Invalid configuration target'`).
- 변경 이벤트: `triggerConfigurationChange`가 `ConfigurationChangeEvent`를 만들고 `source`에 타깃을 담아 `_onDidChangeConfiguration`을 내보낸다. 구독자는 `affectsConfiguration(key)`로 관심 있는 키만 걸러 쓴다.
- 초기화: `web.main.ts`의 `createWorkspaceService`가 `workspaceService.initialize(workspace)`를 `await`한다. 스토리지와 설정 서비스는 `createWorkspaceConfigAndStorageServices`에서 병렬로 준비된다.

### 3.3 웹에서 `settings.json`은 어디에 있는가

- 사용자 프로필의 `settingsResource`(`IUserDataProfile`)가 가리키는 파일이다. `src/vs/workbench/services/preferences/browser/preferencesService.ts`의 `userSettingsResource`가 `userDataProfileService.currentProfile.settingsResource`를 돌려준다.
- 이 URI의 스킴은 `Schemas.vscodeUserData`다. `web.main.ts`의 `registerIndexedDBFileSystemProviders`가 이 스킴에 `IndexedDBFileSystemProvider`(`src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`)를 등록하고, 데이터베이스 `vscode-web-db`의 객체 저장소 `vscode-userdata-store`에 파일 내용을 둔다. 로그(`vscode-logs-store`)와 파일 핸들(`vscode-filehandles-store`)도 같은 데이터베이스의 다른 저장소다.
- IndexedDB를 쓸 수 없으면 `InMemoryFileSystemProvider`로 대체한다(`'Using in-memory user data provider'`). 이때 설정은 새로고침하면 사라진다.
- 결과적으로 웹의 영속 저장소는 서로 다른 두 곳이다: 상태는 `vscode-web-state-db-*`(`Storage` 캐시와 쓰기 묶음), 사용자 설정은 `vscode-web-db`(파일 시스템). 두 쪽의 플러시 시점과 변경 감지 경로도 다르다. 설정은 `IFileService`의 변경 이벤트로, 상태는 `BroadcastDataChannel`로 알린다.

### 3.4 사용자의 `settings.json`을 여는 커맨드

파일: `src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts`.

| 항목 | 값 |
| --- | --- |
| 커맨드 id | `workbench.action.openSettingsJson`("Open User Settings (JSON)"), `f1: true`로 커맨드 팔레트에 노출 |
| 구현 | `registerAction2`로 등록한 `Action2`. `run`이 `IPreferencesService.openSettings({ jsonEditor: true, ...args })`를 부른다 |
| 서비스 | `src/vs/workbench/services/preferences/browser/preferencesService.ts`의 `PreferencesService`. `openUserSettings`가 `userSettingsResource`를 `open`한다 |
| 관련 | 같은 파일의 `workbench.action.openApplicationSettingsJson`(기본 프로필이 아닐 때만 팔레트에 노출), `workbench.action.openRawDefaultSettings`(기본 설정 JSON), `workbench.action.openSettings2`(설정 UI. 범위 밖) |

- 파일은 일반 텍스트 에디터로 열린다. 사용자가 저장하면 파일 서비스 변경 이벤트가 `UserConfiguration`을 거쳐 `onDidChangeConfiguration`이 된다. 즉 코드가 `updateValue`로 쓰는 경로와 사용자가 직접 편집해 저장하는 경로가 같은 파일, 같은 리로드로 합쳐진다.

### 3.5 이 섹션이 이 워크벤치에 주는 시사점

사실과 구분한다. 아래는 해석이다.

- VS Code의 구분(레이아웃 상태는 키-값 스토리지, 사용자 설정은 JSON 파일)을 따르면, 파트 숨김처럼 "UI가 바꾸는 값"과 `settings.json`처럼 "사용자가 편집하는 값"의 읽기 경로가 달라진다.
- 레이아웃 키 세 개가 설정과 상태 양쪽에 걸쳐 있다는 점(2.3절의 레거시 설정 덮어쓰기)은 이 워크벤치가 같은 값에 두 출처를 두지 않도록 결정해야 하는 지점이다.
- 설정 스코프(`ConfigurationScope`)와 층(`ConfigurationTarget`)은 v0.1.0에서 어디까지 구현할지(예: 사용자와 기본값 두 층만) 정해 [architecture.md](architecture.md)의 `### Storage and settings` 아래에 차이로 적어야 한다.

## 4. 이 페이지가 다루지 않는 것

- 설정 에디터 UI, 키바인딩 편집기, 확장 설치 상태의 저장(확장 쪽은 [vscode-extensions.md](vscode-extensions.md)), 원격(`USER_REMOTE`)과 사용자 데이터 동기화, 프로필 UI, 데스크톱 백엔드의 스토리지.
- 키바인딩 레지스트리와 사용자 `keybindings.json` 로딩은 [vscode-menus-commands.md](vscode-menus-commands.md)가 다룬다.
- 웹 진입점과 서비스 조립의 전체 순서는 [vscode-web-build.md](vscode-web-build.md)가, 파트의 크기 제약은 [vscode-workbench-layout.md](vscode-workbench-layout.md)가, 에디터 그룹 구조는 [vscode-editor-groups.md](vscode-editor-groups.md)가 다룬다.

Decided in: wr-e8v6
