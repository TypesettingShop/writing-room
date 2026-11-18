# VS Code의 상태와 설정

VS Code가 UI 상태(어떤 파트가 표시되는지, 어떤 에디터가 열려 있는지)와 사용자 설정(`settings.json`)을 어디에 어떻게 보관하는지 정리한다. 두 데이터는 물리적 저장소가 서로 다르다. UI 상태는 키-값 스토리지 서비스(웹 환경에서는 IndexedDB)에 보관되며, 설정은 설정 서비스가 파일 서비스를 통해 읽고 쓰는 JSON 파일로 관리된다. 모든 경로와 심볼은 [README.md](README.md)에 명시된 고정 커밋을 기준으로 검증하였다. writing-room의 대응 경로는 [architecture.md](architecture.md)의 대응표를 참조한다.

범위 제외(이름만 표기): 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 고정 커밋의 `src/vs/workbench/browser/layout.ts`에는 채팅과 보조 사이드바 관련 키도 포함되어 있으나, 본 문서는 v0.1.0이 다루는 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄)의 메커니즘만을 다룬다.

## 한눈에 보기

| 질문 | 답 | 근거 심볼 |
| --- | --- | --- |
| 상태는 어디에 저장되는가 | 웹 환경에서는 IndexedDB에 저장된다. 스코프마다 독립된 데이터베이스를 사용한다 | `src/vs/workbench/services/storage/browser/storageService.ts`의 `BrowserStorageService`, `IndexedDBStorageDatabase` |
| 설정은 어디에 저장되는가 | 사용자 프로필 디렉터리의 `settings.json` 파일에 저장된다. 파일 서비스를 통해 읽고 쓰며, 웹 환경에서 해당 가상 파일 시스템은 별도의 IndexedDB 데이터베이스로 구현된다 | `src/vs/workbench/browser/web.main.ts`의 `registerIndexedDBFileSystemProviders`, `src/vs/workbench/services/configuration/browser/configurationService.ts`의 `WorkspaceService` |
| 누가 상태 저장을 트리거하는가 | 저장 직전에 발생하는 `onWillSaveState` 이벤트를 수신한 각 컴포넌트가 자신의 상태를 스토리지 서비스에 기록한다 | `src/vs/platform/storage/common/storage.ts`의 `IStorageService.onWillSaveState`, `src/vs/workbench/common/component.ts`의 `Component` |
| 패널은 초기 실행 시 표시되는가 | 기본값은 숨김이다 | `src/vs/workbench/browser/layout.ts`의 `LayoutStateKeys.PANEL_HIDDEN` |

## 1. 스토리지 서비스

### 1.1 계약: `IStorageService`

파일: `src/vs/platform/storage/common/storage.ts`.

| 심볼 | 무엇을 결정하는가 |
| --- | --- |
| `IStorageService` | 동기 읽기(`get`, `getBoolean`, `getNumber`, `getObject`), 비동기 영속화 쓰기(`store`, `remove`), `keys`, `isNew`, `flush`, `optimize`, 변경 이벤트(`onDidChangeValue`, `onDidChangeTarget`, `onWillSaveState`)를 정의하는 서비스 인터페이스. 읽기는 메모리 캐시로부터 동기로 수행되며 쓰기 호출 즉시 캐시에 반영된다 |
| `StorageScope` | 저장된 값이 공유되는 유효 범위. `APPLICATION_SHARED = -2`(모든 워크스페이스, 프로필 및 애플리케이션 인스턴스 간 공유), `APPLICATION = -1`(모든 워크스페이스 및 프로필 간 공유), `PROFILE = 0`(동일 프로필 내 모든 워크스페이스 공유), `WORKSPACE = 1`(현재 워크스페이스 전용) |
| `StorageTarget` | 값이 사용자 것인가 머신 것인가. `USER`(머신 사이에서 동기화 대상), `MACHINE`(이 머신 전용). 스코프와 독립적인 두 번째 축이다 |
| `store(key, value, scope, target)` | 쓰기 호출 시 스코프와 타깃을 필수 인자로 전달해야 한다. `undefined` 또는 `null`을 저장하면 해당 키를 삭제한다 |
| `AbstractStorageService` | 스토리지 백엔드에 독립적인 공통 추상 구현체. 키별 타깃 메타데이터 기록(`updateKeyTarget`, 스토리지 내부의 `TARGET_KEY`), 최초 실행 판별(`isNew`, `IS_NEW_KEY`), `flush`, 주기적 유휴 플러시(`flushWhenIdleScheduler`, 기본 `DEFAULT_FLUSH_INTERVAL`은 1분)를 처리하며, 구체 백엔드는 `getStorage(scope)`와 `doInitialize`를 구현한다 |
| `WillSaveStateReason` | 저장 사유 열거형: `NONE`(일반 상태 저장), `SHUTDOWN`(애플리케이션 종료 직전). `flush(SHUTDOWN)` 호출 시 지연 타이머 없이 즉시 영속화 플러시를 수행한다 |

- 타깃 정보는 값 자체와 분리되어 별도 내부 메타데이터 항목(`TARGET_KEY`)에 키 단위로 기록된다. `keys(scope, target)`가 타깃별 필터링을 지원할 수 있는 이유다. `TARGET_KEY`가 변경되면 `emitDidChangeValue`는 값 변경 대신 `onDidChangeTarget` 이벤트를 발행한다.
- `store`와 `remove`는 `withPausedEmitters` 컨텍스트 내부에서 타깃 메타데이터 갱신과 값 쓰기를 원자적으로 실행한 뒤 이벤트를 일괄 발행한다.

### 1.2 캐시와 데이터베이스: `Storage`

파일: `src/vs/base/parts/storage/common/storage.ts`.

| 심볼 | 무엇을 결정하는가 |
| --- | --- |
| `IStorageDatabase` | 스토리지 백엔드가 구현해야 하는 기본 계약: `getItems`, `updateItems`, `optimize`, `close`, 그리고 타 창의 외부 변경을 통지하는 `onDidChangeItemsExternal` 이벤트 |
| `Storage` | `IStorageDatabase` 하나를 감싸는 메모리 캐시. `init`에서 `database.getItems()`로 전체를 `cache`(`Map<string, string>`)에 한 번에 읽는다. 이후 `get*`은 캐시에서만 읽는다 |
| `Storage.set`, `Storage.delete` | 메모리 캐시를 즉시 업데이트하고, 변경 내역을 `pendingInserts` 및 `pendingDeletes` 큐에 적재하며, `onDidChangeStorage` 이벤트를 발생시킨 뒤 `doFlush`로 비동기 디스크 쓰기를 스케줄링한다. 동일한 값으로 덮어쓸 경우 작업을 생략한다 |
| `Storage.DEFAULT_FLUSH_DELAY` | 100ms. 짧은 시간 동안 발생하는 연속적인 쓰기 요청을 `ThrottledDelayer`를 통해 단일 `updateItems` 트랜잭션으로 묶어 처리한다 |
| `Storage.flush`, `whenFlushed`, `close` | `close` 호출 시 잔여 쓰기 큐를 처리하기 위해 `doFlush(0)`을 즉시 실행한 뒤 `database.close`를 호출한다. 플러시가 실패하더라도 연결은 정상 종료된다 |
| `StorageHint` | 스토리지 힌트 플래그. `STORAGE_DOES_NOT_EXIST`는 초기 DB 전체 조회를 생략하며, `STORAGE_IN_MEMORY`는 디바운스 지연 없이 즉시 동기 플러시한다 |
| `InMemoryStorageDatabase` | 인메모리 전용 데이터베이스 구현체. IndexedDB 연결이 실패했을 때의 폴백으로 동작한다(1.3절 참조) |

### 1.3 브라우저 백엔드: `BrowserStorageService`

파일: `src/vs/workbench/services/storage/browser/storageService.ts`.

**스코프별 독립된 IndexedDB 데이터베이스 구성**

| 스코프 | 생성 팩토리 메서드 | 데이터베이스 식별자 | 탭 간 브로드캐스트 여부 |
| --- | --- | --- | --- |
| `APPLICATION` | `IndexedDBStorageDatabase.createApplicationStorage` | `global` | 예(`broadcastChanges: true`) |
| `APPLICATION_SHARED` | `createApplicationSharedStorage` | `global-shared` | 예 |
| `PROFILE` | `createProfileStorage` | `global-<프로필 id>`. 기본 프로필(`isProfileUsingDefaultStorage`)은 상위 `global`과 동일한 `Storage` 인스턴스를 공유한다 | 예 |
| `WORKSPACE` | `createWorkspaceStorage` | `<워크스페이스 id>` | 아니오(브로드캐스트 옵션 비활성화) |

- 실제 브라우저 IndexedDB 이름은 접두사 `vscode-web-state-db-`(`STORAGE_DATABASE_PREFIX`)에 위 식별자를 결합한 형태이며, 단일 오브젝트 스토어인 `ItemTable`(`STORAGE_OBJECT_STORE`)을 갖는다. 키와 값은 모두 문자열로 저장된다.
- 이 상태 DB는 설정 파일 등을 저장하는 가상 파일 시스템 DB인 `vscode-web-db`(`web.main.ts`의 `registerIndexedDBFileSystemProviders`)와 물리적으로 분리된 별도의 데이터베이스다(2절 참조).
- `BrowserStorageService.doInitialize`는 위 네 가지 스코프 스토리지를 `Promises.settled`를 사용해 병렬로 초기화한다. `web.main.ts`의 `createStorageService`가 `initialize()` 완료를 `await`한 후에야 워크벤치 기동이 진행되므로, 런타임의 동기 읽기가 안전하게 보장된다.
- `IndexedDBStorageDatabase.create`는 IndexedDB 연결이 거부되거나 실패하면 에러 로그를 남기고 `InMemoryIndexedDBStorageDatabase`를 반환한다. IndexedDB 접근이 차단된 시크릿 모드 브라우저에서도 현재 탭 세션 동안은 정상 구동되지만 새로고침 시 상태는 초기화된다.

**스토리지 영속화(디스크 쓰기) 시점**

| 계층 | 실행 주기 / 조건 | 관련 심볼 |
| --- | --- | --- |
| 값 변경 후 지연 배치 쓰기 | 100ms 디바운스 | `Storage.DEFAULT_FLUSH_DELAY` |
| 주기적 유휴 상태 수집(`onWillSaveState`) | 5초 간격. 데스크톱 기본값(1분)보다 브라우저 환경에 맞춰 짧게 설정됨(브라우저 언로드 시 비동기 완료를 보장할 수 없기 때문) | `BrowserStorageService.BROWSER_DEFAULT_FLUSH_INTERVAL` |
| 유휴 플러시 조건부 스킵 | 창에 포커스가 없거나 이미 비동기 쓰기 트랜잭션이 진행 중(`hasPendingUpdate`)이면 플러시를 건너뛴다 | `BrowserStorageService.shouldFlushWhenIdle` |
| 애플리케이션 종료 | `beforeunload` 및 `shutdown` 라이프사이클 이벤트 수신 시 `flush(WillSaveStateReason.SHUTDOWN)` 호출. 브라우저가 종료 직전 비동기 I/O를 중단시킬 수 있으므로 낙관적 즉시 플러시를 시도 | `src/vs/workbench/services/lifecycle/browser/lifecycleService.ts`의 `doShutdown`, `shutdown`, `withExpectedShutdown` |

- `close()`는 Safari 브라우저에서만 데이터베이스 커넥션을 명시적으로 닫아 프리징 버그를 회피한다. 타 브라우저에서는 페이지 언로드 시점에도 쓰기 완료를 허용하기 위해 연결을 유지한다. 이후 공통으로 `dispose()`를 호출한다.
- `clear()`는 스토리지 내 모든 키를 삭제하고 데이터베이스를 초기화한다. `web.main.ts`의 `registerDeveloperActions`가 제공하는 `workbench.action.resetUserData` 커맨드가 `provider.reset()`과 함께 이를 호출한다.

**다중 탭 간 상태 동기화 메커니즘**

1. `IndexedDBStorageDatabase.updateItems`를 통해 쓰기가 성공하면, `broadcastChanges`가 활성화된 데이터베이스는 변경분 데이터(`{ changed, deleted }`)를 `BroadcastDataChannel`(`src/vs/base/browser/broadcast.ts`)의 `postData`로 전송한다. 채널 식별자는 데이터베이스 이름을 그대로 사용한다.
2. 동일 도메인의 다른 탭에서 동일 데이터베이스 인스턴스가 `onDidReceiveData` 이벤트를 수신하고, `isStorageItemsChangeEvent` 검증 후 `onDidChangeItemsExternal` 이벤트를 발생시킨다.
3. 해당 탭의 `Storage.onDidChangeItemsExternal`이 `acceptExternal`을 통해 수신된 키-값을 메모리 캐시에 동기화한다. 실제 값이 변경된 경우에 한해 `onDidChangeStorage({ key, external: true })`를 발행한다.
4. `AbstractStorageService.emitDidChangeValue`가 `scope`와 `external`을 붙여 `onDidChangeValue` 구독자에게 전달한다.

- 탭 간에 인메모리 캐시를 직접 공유하는 구조가 아니며, IndexedDB 쓰기 완료 후 브로드캐스트 채널을 거쳐 각 탭의 로컬 캐시를 갱신하는 비동기 이벤트 동기화 방식을 취한다.
- `WORKSPACE` 스코프 데이터베이스는 `broadcastChanges` 플래그가 비활성화되어 있다. 따라서 동일한 워크스페이스를 여러 탭에서 열더라도 워크스페이스 범위의 상태 쓰기는 탭 간에 실시간 동기화되지 않는다.
- 동시 쓰기 충돌 시에는 마지막으로 플러시된 트랜잭션이 이전 값을 덮어쓴다(Last-Write-Wins).
- `compareAndSwapApplicationStorage`와 `compareAndSwapApplicationSharedValue`는 IndexedDB 트랜잭션 안에서 기대값과 비교한 뒤 쓴다. 이 경로는 일반 `store`와 달리 캐시를 거치지 않고 데이터베이스를 직접 읽는다(`readApplicationSharedValue`, `getApplicationStorageValue`).

**프로필 전환 처리**: `BrowserStorageService.switchToProfile`은 이전 프로필 스토리지를 종료하고(기본 프로필인 경우 유지) 신규 프로필 스토리지를 초기화한 뒤, `switchData`를 통해 변경된 키 목록에 대한 변경 이벤트를 일괄 발행한다. 단, `switchToWorkspace`는 웹 환경에서 지원되지 않으며 호출 시 `Error`를 발생시킨다.

## 2. 누가 무엇을 언제 저장하는가

### 2.1 컴포넌트의 상태 저장 흐름: `Component`와 `Memento`

| 심볼 | 파일 | 역할 |
| --- | --- | --- |
| `Component` | `src/vs/workbench/common/component.ts` | 생성자에서 `storageService.onWillSaveState`를 구독한다. 저장 알림이 발생하면 (1) 하위 클래스의 `saveState()`를 호출하여 변경된 상태를 memento 객체에 직렬화하고, (2) `memento.saveMemento()`를 호출해 해당 객체를 스토리지 서비스에 쓴다. 하위 클래스에 `getMemento(scope, target)`, `reloadMemento`, `onDidChangeMementoValue` 편의 메서드를 제공한다 |
| `Memento` | `src/vs/workbench/common/memento.ts` | `id` 앞에 `memento/` 접두사(`COMMON_PREFIX`)를 부여한 단일 키에 전체 상태 객체를 JSON 문자열로 직렬화하여 저장한다. 스코프별 내부 맵(`workspaceMementos`, `profileMementos`, `applicationMementos`, `applicationSharedMementos`)에 `ScopedMemento`를 캐싱하여 동일 id에 대해 동일한 객체 참조를 공유하도록 보장한다 |
| `ScopedMemento` | 같은 파일 | `getMemento` 최초 호출 시 `getObject`를 통해 스토리지에서 역직렬화 로드한다(파싱 실패 시 에러 로그를 남기고 빈 객체로 초기화). `save()` 호출 시 객체 내 속성이 비어 있으면 키를 삭제하고, 내용이 있으면 `store`를 호출한다. `reload()`는 객체 참조를 유지한 채 속성 내용만 다시 채운다 |

- 동작 순서: 컴포넌트는 평상시 메모리 필드 값만 변경하며, 저장 시점에 `saveState()`가 호출되어 memento 객체로 상태를 동기화하고, `saveMemento()`가 스토리지 서비스에 기록하면, `Storage`가 100ms 디바운스 후 IndexedDB에 영속화한다.
- memento는 최초 요청 시 전달된 `(scope, target)` 튜플을 `ScopedMemento`에 영구 바인딩한다. 동일한 id를 추후 다른 타깃으로 재요청하더라도 최초 생성 시의 타깃 설정이 유지된다.
- 컴포넌트 베이스 클래스를 상속하지 않는 독립 모델(예: 상태 표시줄 뷰모델 등)은 `onWillSaveState` 이벤트 리스너 또는 값 변경 시점에 `storageService.store`를 직접 호출한다. 아래 표의 "저장 방식" 열에서 이를 구분한다.

### 2.2 저장 항목 목록

| 상태 종류 | 키 또는 심볼 | 스코프 / 타깃 | 저장 방식 | 관련 소스 파일 |
| --- | --- | --- | --- | --- |
| 레이아웃: 파트 표시 여부, 위치, 크기, 중앙 정렬 | `workbench.<name>` 키 집합(3절 참조) | 키별 상이 | `LayoutStateModel.save`가 `onWillSaveState`에서 일괄 저장 | `src/vs/workbench/browser/layout.ts` |
| 에디터 파트: 그리드 레이아웃, 활성 그룹, 그룹 최근 사용 순서 | memento `editorpart.state`(`IEditorPartUIState`: `serializedGrid`, `activeGroup`, `mostRecentActiveGroups`) | `WORKSPACE` / `USER` | `EditorPart.saveState`가 `createState()`를 생성해 memento에 기록 | `src/vs/workbench/browser/parts/editor/editorPart.ts` |
| 에디터 중앙 정렬 모드 | memento `editorpart.centeredview` | `PROFILE` / `MACHINE` | `EditorPart.saveState`에서 저장. 기본값이면 키 삭제 | 같은 파일 |
| 각 에디터 그룹 내 열린 에디터 목록 및 탭 순서 | `ISerializedEditorGroupModel`(`id`, `locked`, `editors`, `mru`, `preview`, `sticky`)이 `serializedGrid`의 리프 노드에 직렬화 포함 | `editorpart.state`에 포함 | `EditorGroupView.toJSON`이 `EditorGroupModel.serialize()` 호출 | `src/vs/workbench/browser/parts/editor/editorGroupView.ts`, `src/vs/workbench/common/editor/editorGroupModel.ts` |
| 에디터 최근 열림 순서(전역 MRU) | 키 `editors.mru` | `WORKSPACE` / `MACHINE` | `EditorsObserver.saveState`가 `onWillSaveState`에서 직접 저장 | `src/vs/workbench/browser/parts/editor/editorsObserver.ts` |
| 개별 에디터 뷰 상태(커서 위치, 스크롤 위치) | `EditorMemento`가 페인 memento 내부에 최대 10개(`limit`)까지 LRU 캐싱 | `WORKSPACE` / `MACHINE` | `EditorPane.saveState`, `AbstractEditorWithViewState.saveState` | `src/vs/workbench/browser/parts/editor/editorPane.ts`, `editorWithViewState.ts` |
| 뷰 컨테이너 및 뷰 사용자 재배치 위치 | 키 `views.customizations`(`IViewsCustomizations`: `viewContainerLocations`, `viewLocations`, `viewContainerBadgeEnablementStates`) | `PROFILE` / `USER` | UI 드래그 변경 즉시 `setStoredViewCustomizationsValue` 호출 | `src/vs/workbench/services/views/browser/viewDescriptorService.ts` |
| 사이드바 및 패널의 마지막 활성 뷰 컨테이너 id | 키 `workbench.sidebar.activeviewletid`(`SidebarPart.activeViewletSettingsKey`), `workbench.panelpart.activepanelid`(`PanelPart.activePanelSettingsKey`) | `WORKSPACE` / `MACHINE` | 컴포지트 전환 시 `CompositePart.showComposite`가 즉시 저장. 기본 컴포지트면 키 삭제 | `src/vs/workbench/browser/parts/compositePart.ts`, `sidebar/sidebarPart.ts`, `panel/panelPart.ts` |
| 액티비티 바 고정/숨김 상태 | `PaneCompositeBar`의 `pinnedViewContainersKey`, `placeholderViewContainersKey`, `viewContainersWorkspaceStateKey` 설정 키 | `PROFILE`(고정은 `USER`, 플레이스홀더는 `MACHINE`), 워크스페이스 상태는 `WORKSPACE` | 사용자 핀 변경 즉시 | `src/vs/workbench/browser/parts/paneCompositeBar.ts` |
| 상태 표시줄 숨김 항목 목록 | 키 `workbench.statusbar.hidden` | `PROFILE` / `USER` | `StatusbarViewModel.saveState`가 우클릭 숨김 토글 즉시 저장 | `src/vs/workbench/browser/parts/statusbar/statusbarModel.ts` |

- 에디터 직렬화 요건: 에디터 입력이 새로고침 후 복원되려면 각 `EditorInput` 클래스마다 `IEditorSerializer`(`canSerialize`, `serialize`, `deserialize`)를 `Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer`로 등록해야 한다. 인터페이스 정의는 `src/vs/workbench/common/editor.ts`에 있으며, 대표 등록 예시는 `src/vs/workbench/browser/parts/editor/editor.contribution.ts`(`UntitledTextEditorInputSerializer`, `SideBySideEditorInputSerializer`, `DiffEditorInputSerializer`)에 있다.
- `EditorGroupModel.serialize`는 직렬화기가 등록되어 있지 않거나, `canSerialize`가 거짓을 반환하거나, `serialize` 결과가 유효한 문자열이 아닌 에디터를 직렬화에서 제외하고, 이에 맞춰 `mru`, `preview`, `sticky` 인덱스를 재계산한다. 즉 복원할 수 없는 비영속 에디터는 재시작 시 MRU 순서에서도 자연스럽게 누락된다.
- 에디터 파트에 열린 에디터가 하나도 없으면(`isEmpty`) `editorpart.state` memento를 삭제한다. 복원 로직(`doCreateGridControlWithPreviousState`)은 `loadState()`로부터 유효한 `serializedGrid`가 읽힐 때만 그리드를 복원하며, 파싱 에러 발생 시 로그를 남기고 빈 그룹 상태로 초기화한다.
- 에디터 파트는 `onDidChangeMementoValue(StorageScope.WORKSPACE)` 이벤트를 구독한다. 외부 탭(`e.external`)에서 워크스페이스 상태 변경 이벤트가 수신되면 `reloadMemento` 후 `applyState`를 실행해 타 창의 레이아웃을 반영한다. 단, 1.3절에서 확인했듯 브라우저 환경에서는 `WORKSPACE` 데이터베이스의 브로드캐스트가 비활성화되어 있으므로 실제 웹 환경에서는 이 분기가 실행되지 않는다(데스크톱 다중 창 환경을 위한 코드).

### 2.3 레이아웃 상태: `LayoutStateModel`과 `LayoutStateKeys`

파일: `src/vs/workbench/browser/layout.ts`. 두 타입 모두 파일 내부 전용 심볼이다(`export`되지 않음). `Layout.initLayoutState`가 `new LayoutStateModel(...)`을 생성하고 `load({ mainContainerDimension, resetLayout })`를 호출한다.

**키 분류**

- `RuntimeStateKey`: 런타임에 수시로 변경되며 `getRuntimeValue`/`setRuntimeValue`로 접근한다.
- `InitializationStateKey`: 시작할 때만 값이 쓰이고(`getInitializationValue`), 저장 직전에 `onWillSaveState`에서 현재 그리드 크기를 읽어 `setInitializationValue`로 갱신한다. 파트 크기 세 개(`SIDEBAR_SIZE`, `PANEL_SIZE`, `AUXILIARYBAR_SIZE`)가 이 종류다.

**여섯 파트와 직접 연관된 레이아웃 키 목록**

실제 IndexedDB 저장 키는 `LayoutStateModel.STORAGE_PREFIX`(`workbench.`) 뒤에 `name` 문자열을 결합한 형태다.

| `LayoutStateKeys` | name | 스코프 / 타깃 | 기본값 규칙 |
| --- | --- | --- | --- |
| `ACTIVITYBAR_HIDDEN` | `activityBar.hidden` | `WORKSPACE` / `MACHINE` | `false`(설정 `workbench.activityBar.location`이 `default`가 아니면 로드 시 덮어씀. `zenModeIgnore` 속성 보유) |
| `SIDEBAR_HIDDEN` | `sideBar.hidden` | `WORKSPACE` / `MACHINE` | `false`. 로드 때 `defaultValue`를 `workbenchState === WorkbenchState.EMPTY`로 바꾼다. 즉 폴더가 없는 빈 워크스페이스에서는 숨김이 기본이다 |
| `PANEL_HIDDEN` | `panel.hidden` | `WORKSPACE` / `MACHINE` | **`true`. 신규 창에서 패널은 기본적으로 숨겨진 상태로 시작한다** |
| `EDITOR_HIDDEN` | `editor.hidden` | `WORKSPACE` / `MACHINE` | `false`. 패널과 에디터가 동시에 숨김으로 로드되면 `applyOverrides`가 에디터를 강제로 다시 표시함(보조 사이드바 최대화 예외 제외) |
| `STATUSBAR_HIDDEN` | `statusBar.hidden` | `WORKSPACE` / `MACHINE` | `false`(설정 `workbench.statusBar.visible` 값으로 덮어씀. `zenModeIgnore` 속성 보유) |
| `SIDEBAR_POSITON`(원문 철자 그대로) | `sideBar.position` | `WORKSPACE` / `MACHINE` | `Position.LEFT`(설정 `workbench.sideBar.location` 값으로 덮어씀) |
| `PANEL_POSITION` | `panel.position` | `WORKSPACE` / `MACHINE` | 설정 `workbench.panel.defaultLocation` 우선, 미설정 시 `Position.BOTTOM` |
| `PANEL_ALIGNMENT` | `panel.alignment` | `PROFILE` / `USER` | `'center'` |
| `SIDEBAR_SIZE` | `sideBar.size` | `PROFILE` / `MACHINE` | `Math.min(300, 창 너비 / 4)`(창 로드 시 동적 계산) |
| `PANEL_SIZE` | `panel.size` | `PROFILE` / `MACHINE` | 패널이 가로 모드면 `창 높이 / 3`, 세로 모드면 `창 너비 / 4` |
| `PANEL_LAST_NON_MAXIMIZED_HEIGHT`, `PANEL_LAST_NON_MAXIMIZED_WIDTH`, `PANEL_WAS_LAST_MAXIMIZED` | `panel.lastNonMaximizedHeight` 등 | 앞 둘 `PROFILE`, 마지막 `WORKSPACE` / `MACHINE` | 300, 300, `false` |
| `MAIN_EDITOR_CENTERED` | `editor.centered` | `WORKSPACE` / `MACHINE` | `false` |
| `ZEN_MODE_ACTIVE`, `ZEN_MODE_EXIT_INFO` | `zenMode.active`, `zenMode.exitInfo` | `WORKSPACE` / `MACHINE` | `false`, 젠 모드 이전 레이아웃 복원 정보 객체 |

보조 사이드바(`AUXILIARYBAR_*`) 및 채팅 관련 키(`EDITOR_HIDDEN_BY_CHAT`)는 범위 밖이다.

**초기화 및 저장 처리 파이프라인**

1. `load`는 `resetLayout` 옵션이 없는 한 모든 키를 `loadKeyFromStorage`로 스토리지에서 조회하며, 키의 기본 타입(`boolean`, `number`, `object`)에 맞춰 파싱 역직렬화한다.
2. 레거시 설정 세 개(활동 표시줄 위치, 상태 표시줄 표시, 사이드바 위치)를 설정 서비스에서 읽어 캐시를 덮어쓴다. 즉 이 세 값은 저장소 값보다 설정이 우선한다.
3. 동적 기본값(초기 파트 크기, 사이드바 숨김 여부, 패널 위치)을 계산하여 아직 저장값이 없는 키에 주입한다.
4. `applyOverrides`를 실행하여 시작 시 동시에 성립할 수 없는 유효하지 않은 레이아웃 조합(예: 에디터와 패널 동시 숨김)을 보정한다.
5. 런타임에 `setRuntimeValue`가 호출되면 내부 캐시를 갱신한다. 이때 스코프가 `PROFILE`인 키만 즉시 `saveKeyToStorage`로 영속화하며, `WORKSPACE` 키는 캐시에만 머무르다 일괄 저장 시점에 기록된다.
6. `Layout`이 `onWillSaveState` 이벤트를 수신하면, 그리드 엔진에서 파트별 실제 크기를 읽어 `setInitializationValue`를 갱신한 뒤 `stateModel.save(true, true)`를 호출한다(워크스페이스 키 및 프로필 키 일괄 디스크 쓰기). 젠 모드 활성화 중에는 `zenModeIgnore` 키들을 저장 대상에서 제외하여 임시 레이아웃 상태가 영구 보존되는 것을 방지한다.
7. 프로필 스코프이면서 `USER` 타깃인 `RuntimeStateKey`(현재는 `PANEL_ALIGNMENT`)는 `storageService.onDidChangeValue(StorageScope.PROFILE, ...)`를 구독해 다른 창이 바꾼 값을 받아 `onDidChangeState`를 내보낸다.
8. `LayoutStateModel`은 `isNew`를 스코프별로 기록한다(`storageService.isNew`와, 저장된 키가 하나라도 읽히면 `false`로). 첫 실행인지에 따라 보조 사이드바 기본값과 작은 창 크기 보정이 달라진다.

- 소스 내 `updateLegacySettingsFromState` 함수는 액티비티 바, 상태 표시줄, 사이드바 위치를 설정으로 역반영하는 로직이지만, `setRuntimeValue` 내부에서 `PROFILE` 스코프 분기 조건 하에서만 실행되도록 작성되어 있다. 해당 키들은 모두 `WORKSPACE` 스코프로 정의되어 있으므로 정적 코드 분석상 이 역반영 경로는 런타임에 진입하지 않는다.
- 기본값 "패널 숨김"은 신규 창 생성 시의 초기 상태일 뿐이다. 사용자가 패널을 한 번이라도 열면 `setPanelHidden`에 의해 `PANEL_HIDDEN`이 `false`로 갱신되고, 이후 저장 시점에 `workbench.panel.hidden = false`로 기록되므로 다음 세션에서는 열린 상태로 정상 복원된다.

### 2.4 이 섹션이 이 워크벤치에 주는 시사점

본 절은 사실 관계 요약이 아닌 아키텍처 관점의 제안 및 해석이다.

- 설계 단위 세 가지를 따로 만들 필요가 있다: (a) 스코프 x 타깃 키-값 저장소, (b) 저장 시점 알림(`onWillSaveState`)과 이를 받는 컴포넌트 기반 클래스, (c) 레이아웃 상태 모델.
- v0.1.0이 영속성을 포함하므로 최소한 에디터 파트 상태와 레이아웃 상태가 새로고침 후 복원되어야 한다. 그러려면 에디터 입력마다 직렬화기(`IEditorSerializer`에 해당)가 필요하다.
- 다중 탭 환경에서 동일한 키에 대한 동시 쓰기 정책(Last-Write-Wins 채택 여부, BroadcastChannel을 통한 타 탭 변경 전파 여부)을 명확히 정의해야 한다.

## 3. 설정

### 3.1 서비스 계약과 스코프

| 심볼 | 파일 | 무엇을 결정하는가 |
| --- | --- | --- |
| `IConfigurationService` | `src/vs/platform/configuration/common/configuration.ts` | `getValue`, `updateValue`, `inspect`, `reloadConfiguration`, `keys`, `onDidChangeConfiguration`을 정의하는 설정 서비스 인터페이스. 읽기 연산은 동기로 동작한다 |
| `ConfigurationTarget` | 같은 파일 | 설정 쓰기 및 `inspect` 조회 시의 계층 타깃: `APPLICATION`, `USER`, `USER_LOCAL`, `USER_REMOTE`, `WORKSPACE`, `WORKSPACE_FOLDER`, `DEFAULT`, `MEMORY` |
| `IConfigurationValue`, `isConfigured` | 같은 파일 | `inspect` 결과로 각 계층별 세부 값(`defaultValue`, `userValue` 등)을 반환하는 데이터 모델. `isConfigured`는 사용자가 기본값 외에 명시적으로 값을 지정했는지 판별한다 |
| `ConfigurationRegistry`(`IConfigurationRegistry`) | `src/vs/platform/configuration/common/configurationRegistry.ts` | 애플리케이션 전체 설정 스키마 레지스트리. `registerConfiguration`으로 `IConfigurationNode`(설정 속성명, 기본값, 타입, 유효 `scope`)를 등록한다. `registerDefaultConfigurations`는 언어별 기본값 재정의(`configurationDefaults`)를 등록한다. `getConfigurationProperties`가 전체 등록 속성 사전을 반환한다. 레지스트리 키는 `Extensions.Configuration`이다 |
| `ConfigurationScope` | 같은 파일 | 속성이 어느 층에서 설정될 수 있는가: `APPLICATION`, `MACHINE`, `APPLICATION_MACHINE`, `WINDOW`, `RESOURCE`, `LANGUAGE_OVERRIDABLE`, `MACHINE_OVERRIDABLE`. 스코프별 허용 속성 사전(`applicationSettings`, `machineSettings`, `windowSettings`, `resourceSettings` 등)이 등록 시 채워지고, 사용자 `settings.json`을 읽을 때 허용 범위를 거른다 |
| `DefaultConfiguration` | `src/vs/platform/configuration/common/configurations.ts` | 레지스트리에 선언된 기본값들을 모아 초기 `ConfigurationModel`을 구축하고 `onDidUpdateConfiguration`을 구독해 동적으로 갱신한다 |
| `Configuration`(`getValue`, `inspect`) | `src/vs/platform/configuration/common/configurationModels.ts` | 여러 계층의 `ConfigurationModel`을 우선순위에 따라 병합하여(`getConsolidatedConfigurationModel`) 최종 설정값을 산출한다 |

### 3.2 워크벤치 서비스: `WorkspaceService`

파일: `src/vs/workbench/services/configuration/browser/configurationService.ts`. `IConfigurationService`와 `IWorkspaceContextService` 인터페이스를 단일 클래스가 통합 구현한다(`IWorkbenchConfigurationService`).

| 구성 요소 | 하는 일 |
| --- | --- |
| `defaultConfiguration` | 브라우저 전용 `DefaultConfiguration`(`src/vs/workbench/services/configuration/browser/configuration.ts`). 웹 생성 옵션의 `configurationDefaults`를 반영하고 기본값 재정의를 캐싱한다 |
| `policyConfiguration` | 기업 보안 정책 등 외부 엔터프라이즈 정책으로 강제 고정된 설정 모델 |
| `applicationConfiguration` | 현재 프로필이 기본 프로필이 아닐 때 `APPLICATION` 스코프 설정을 기본 프로필의 `settingsResource`에서 읽어오는 모델(`ApplicationConfiguration`) |
| `localUserConfiguration` | `UserConfiguration` 인스턴스. 현재 활성 프로필의 `settingsResource`를 `IFileService`로 로드하고, `fileService.watch` 파일 감시 이벤트에 반응해 실시간으로 리로드한다 |
| `workspaceConfiguration`, `cachedFolderConfigs` | 멀티 루트 워크스페이스 설정 파일 및 개별 작업 폴더의 `.vscode/settings.json` 모델 |
| `configurationCache`(`ConfigurationCache`) | 원격 리소스 등의 설정을 캐시 디렉터리에 저장해 기동 속도를 단축하는 캐시 엔진. 웹 환경에서는 `Schemas.file`, `Schemas.vscodeUserData`, `Schemas.tmp`를 제외하도록 `web.main.ts`의 `createWorkspaceService`가 설정한다 |

- 설정 읽기: `getValue` 및 `inspect`는 인메모리에 병합된 `Configuration` 트리에서 동기로 값을 반환한다. 병합 우선순위는 기본값 -> 사용자 설정(애플리케이션 포함) -> 워크스페이스 설정 -> 폴더별 설정 순이며, 나중 계층이 앞선 계층을 오버라이드한다.
- 쓰기: `updateValue(key, value, target)`는 `MEMORY`이면 메모리 모델만 바꾸고 이벤트를 낸다. 그 밖의 타깃은 `toEditableConfigurationTarget`으로 편집 가능한 타깃으로 바꾼 뒤 `ConfigurationEditing.writeConfiguration`(`src/vs/workbench/services/configuration/common/configurationEditing.ts`)에 맡긴다. `ConfigurationEditing`은 `Queue`로 쓰기를 직렬화하고, JSON 편집(`setProperty`, `src/vs/base/common/jsonEdit.ts`)을 텍스트 모델에 적용해 파일을 저장한다. 끝나면 해당 층을 다시 읽어(`reloadLocalUserConfiguration` 등) `onDidChangeConfiguration`을 낸다. `DEFAULT` 타깃은 쓸 수 없다(`'Invalid configuration target'`).
- 변경 이벤트: `triggerConfigurationChange`가 `ConfigurationChangeEvent`를 만들고 `source`에 타깃을 담아 `_onDidChangeConfiguration`을 내보낸다. 구독자는 `affectsConfiguration(key)`로 관심 있는 키만 걸러 쓴다.
- 초기화 순서: `web.main.ts`의 `createWorkspaceService`가 `workspaceService.initialize(workspace)`를 `await`하여 완료한다. 스토리지 서비스와 설정 서비스는 `createWorkspaceConfigAndStorageServices`에서 병렬로 초기화된다.

### 3.3 웹 환경에서 `settings.json`의 물리적 저장 위치

- 현재 사용자 프로필의 `settingsResource`(`IUserDataProfile`) URI가 가리키는 파일이다. `src/vs/workbench/services/preferences/browser/preferencesService.ts`의 `userSettingsResource` 속성이 `userDataProfileService.currentProfile.settingsResource`를 반환한다.
- 이 URI는 가상 파일 시스템 스킴인 `Schemas.vscodeUserData`를 사용한다. `web.main.ts`의 `registerIndexedDBFileSystemProviders`가 이 스킴에 `IndexedDBFileSystemProvider`(`src/vs/platform/files/browser/indexedDBFileSystemProvider.ts`)를 바인딩하며, 실제 파일 콘텐츠는 IndexedDB `vscode-web-db`의 `vscode-userdata-store` 오브젝트 스토어에 보관된다. 로그(`vscode-logs-store`)와 파일 핸들(`vscode-filehandles-store`) 역시 동일 DB의 다른 오브젝트 스토어에 함께 저장된다.
- IndexedDB를 쓸 수 없으면 `InMemoryFileSystemProvider`로 대체한다(`'Using in-memory user data provider'`). 이때 설정은 새로고침하면 사라진다.
- 결과적으로 웹의 영속 저장소는 서로 다른 두 곳이다: 상태는 `vscode-web-state-db-*`(`Storage` 캐시와 쓰기 묶음), 사용자 설정은 `vscode-web-db`(파일 시스템). 두 쪽의 플러시 시점과 변경 감지 경로도 다르다. 설정은 `IFileService`의 변경 이벤트로, 상태는 `BroadcastDataChannel`로 알린다.

### 3.4 사용자의 `settings.json`을 여는 커맨드

파일: `src/vs/workbench/contrib/preferences/browser/preferences.contribution.ts`.

| 항목 | 내용 |
| --- | --- |
| 커맨드 id | `workbench.action.openSettingsJson`("Open User Settings (JSON)"), `f1: true`로 선언되어 커맨드 팔레트에 노출됨 |
| 실행 구현 | `registerAction2`로 등록된 `Action2` 구현체. `run` 실행 시 `IPreferencesService.openSettings({ jsonEditor: true, ...args })` 호출 |
| 서비스 | `src/vs/workbench/services/preferences/browser/preferencesService.ts`의 `PreferencesService`. `openUserSettings`가 `userSettingsResource`를 `open`한다 |
| 관련 커맨드 | 동일 파일의 `workbench.action.openApplicationSettingsJson`(기본 프로필이 아닐 때만 팔레트 노출), `workbench.action.openRawDefaultSettings`(기본 설정 JSON 파일 조회), `workbench.action.openSettings2`(GUI 설정 에디터. 범위 밖) |

- 파일은 일반 텍스트 에디터로 열린다. 사용자가 저장하면 파일 서비스 변경 이벤트가 `UserConfiguration`을 거쳐 `onDidChangeConfiguration`이 된다. 즉 코드가 `updateValue`로 쓰는 경로와 사용자가 직접 편집해 저장하는 경로가 같은 파일, 같은 리로드로 합쳐진다.

### 3.5 이 섹션이 이 워크벤치에 주는 시사점

(상단은 사실 관계 기술이며, 하단은 설계 해석이다.)

- VS Code의 아키텍처 원칙(UI 레이아웃 상태는 키-값 스토리지에, 사용자 설정은 JSON 파일에 저장)을 채택하면, 파트 숨김/크기 조절처럼 "UI 상호작용으로 변경되는 런타임 상태"와 사용자가 에디터로 직접 수정하는 `settings.json`의 저장 및 동기화 파이프라인을 명확히 분리할 수 있다.
- 일부 레이아웃 키(사이드바 위치, 액티비티 바 표시 등)가 설정과 상태 양쪽에 걸쳐 중복 관리되는 복잡성을 피하기 위해, writing-room에서는 각 속성의 단일 진실 공급원(Single Source of Truth)을 하나로 명확히 단일화하는 설계가 권장된다.
- 설정 스코프(`ConfigurationScope`)와 층(`ConfigurationTarget`)은 v0.1.0에서 어디까지 구현할지(예: 사용자와 기본값 두 층만) 정해 [architecture.md](architecture.md)의 `### Storage and settings` 아래에 차이로 적어야 한다.

## 4. 이 페이지가 다루지 않는 것

- GUI 설정 에디터 UI, 키바인딩 GUI 편집기, 확장 설치 상태 저장소(확장 관련 세부 내용은 [vscode-extensions.md](vscode-extensions.md) 참조), 원격 머신 설정(`USER_REMOTE`) 및 Settings Sync 클라우드 동기화, 프로필 전환 UI, 데스크톱 전용 SQLite 스토리지.
- 키바인딩 레지스트리 메커니즘과 사용자 `keybindings.json` 파일 로드는 [vscode-menus-commands.md](vscode-menus-commands.md)에서 다룬다.
- 웹 진입점 및 서비스 부트스트래핑 전체 흐름은 [vscode-web-build.md](vscode-web-build.md)에서, 파트별 크기 제약과 레이아웃 배치는 [vscode-workbench-layout.md](vscode-workbench-layout.md)에서, 에디터 그룹 모델 구조는 [vscode-editor-groups.md](vscode-editor-groups.md)에서 다룬다.

Decided in: wr-e8v6
