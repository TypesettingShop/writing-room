# VS Code 확장: 매니페스트, 활성화, 호스트, 양면 API

기준: VS Code 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`(패키지 버전 1.148.0). 모든 주장은 `src/vs/...` 아래 파일과 그 안의 심볼을 명시한다. 줄 번호는 쓰지 않으므로 심볼을 검색한다. 이 페이지의 경로는 VS Code 경로이며, 이 워크벤치에서는 `src/vs/<path>`가 `src/<path>`에 대응한다([architecture.md](architecture.md)).

홈: [README.md](README.md). 관련: [vscode-menus-commands.md](vscode-menus-commands.md)(기여가 도착하는 레지스트리), [vscode-web-build.md](vscode-web-build.md)(내장 확장이 브라우저에 오는 방식), [vscode-state-settings.md](vscode-state-settings.md)(상태가 저장되는 곳).

v0.1.0 범위 밖이라 이름만 적는다: 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 확장 호스트 종류 중 `LocalProcess`와 `Remote`(`src/vs/workbench/services/extensions/common/extensionHostKind.ts`의 `ExtensionHostKind`)는 데스크톱과 원격 빌드의 것이므로 서술하지 않는다.

## 1. 한눈에 보는 파이프라인

| 단계 | 실행 위치 | 파일과 심볼 | 결정하는 것 |
|---|---|---|---|
| 매니페스트 | 데이터 | `src/vs/platform/extensions/common/extensions.ts`의 `IExtensionManifest` | `package.json`의 형태: `main`, `browser`, `activationEvents`, `contributes`, `extensionDependencies`, `extensionPack`, `extensionKind`. |
| 기여 지점 | 메인 스레드(렌더러) | `src/vs/workbench/services/extensions/common/extensionsRegistry.ts`의 `ExtensionsRegistry`, `ExtensionPoint` | `contributes` 아래 어떤 키가 있고 누가 처리하는가. |
| 활성화 요청 | 메인 스레드 | `src/vs/workbench/services/extensions/common/abstractExtensionService.ts`의 `AbstractExtensionService.activateByEvent` | 이벤트 문자열에 관심 있는 확장이 있는지, 어느 호스트에 물을지. |
| 활성화 실행 | 확장 호스트 | `src/vs/workbench/api/common/extHostExtensionActivator.ts`의 `ExtensionsActivator` | 어떤 확장이, 어떤 의존 순서로, 이벤트당 한 번 활성화되는가. |
| 호스트 | iframe + Worker | `src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts`의 `WebWorkerExtensionHost` | 브라우저에서 확장 코드가 어디서 실행되는가. |
| API | 양쪽 | `src/vs/workbench/api/common/extHost.api.impl.ts`, `extHost.protocol.ts`, `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | `vscode.*` 호출이 메인 스레드 작업이 되는 방식. |
| 설치 | 메인 스레드 | `src/vs/workbench/services/extensionManagement/...` | 웹 확장을 추가, 나열, 제거하는 방식. |

## 2. 매니페스트와 기여 지점

### 2.1 매니페스트

- `src/vs/platform/extensions/common/extensions.ts`의 `IExtensionManifest`가 타입이 있는 `package.json`이다. 이 페이지가 의존하는 필드: `main`(Node 진입점), `browser`(웹 진입점), `activationEvents`, `contributes`(`IExtensionContributions`), `extensionDependencies`, `extensionPack`, `extensionKind`.
- 웹 워커 호스트는 `browser`만 읽는다: `src/vs/workbench/api/worker/extHostExtensionService.ts`의 `ExtHostExtensionService._getEntryPoint`가 `extensionDescription.browser`를 돌려준다. `main`만 있는 확장은 거기서 진입점이 없다.
- `src/vs/platform/extensionManagement/common/implicitActivationEvents.ts`의 `ImplicitActivationEventsImpl._readActivationEvents`는 `main`과 `browser`가 둘 다 없으면 빈 목록을 돌려준다. 선언만 있는 확장은 활성화되지 않는다. 그 기여는 메인 스레드가 매니페스트에서 읽으므로 그래도 동작한다.

### 2.2 `ExtensionsRegistry`와 `ExtensionPoint`

- `extensionsRegistry.ts`의 `ExtensionsRegistry`(`ExtensionsRegistryImpl`의 인스턴스, `Registry.as(PRExtensions.ExtensionsRegistry)`)가 기여 지점의 표다.
- `registerExtensionPoint({ extensionPoint, jsonSchema, deps, activationEventsGenerator, ... })`가 하는 일 세 가지:
  - 이름이 중복이면 `Duplicate extension point`로 던진다.
  - `activationEventsGenerator`를 `ImplicitActivationEvents`에 등록한다(3.2절).
  - `jsonSchema`를 같은 파일의 `schema`에서 `contributes` 아래에 추가한다. `package.json` 검증과 자동 완성이 여기서 나온다.
- `ExtensionPoint<T>`는 핸들러 하나와 현재 사용자 목록을 가진다. `setHandler`는 정확히 하나만 받는다(두 번째는 `Handler already set!`). `acceptUsers`는 `ExtensionPointUserDelta`(`added`, `removed`)를 계산하고 전체 사용자 목록과 델타로 핸들러를 호출한다.
- 사용자를 넣는 쪽: `abstractExtensionService.ts`의 `AbstractExtensionService._handleExtensionPoint`가 사용 가능한 확장을 돌며 `contributes[extensionPoint.name]`이 있는 것마다 `IExtensionPointUser`(`description`, `value`, 메시지용 `collector`)를 만들어 `acceptUsers`를 부른다. 호출자 `_doHandleExtensionPoints`는 시작할 때와 확장이 추가, 제거될 때 돈다.
- 그래서 핸들러는 선언적이고 다시 실행될 수 있다: `menus`와 `commands` 핸들러는 먼저 이전 등록을 모두 지우고(`_menuRegistrations.clear()`, `_commandRegistrations.clear()`) 전체 목록에서 다시 추가한다.
- `deps`가 핸들러 순서를 정한다: `menusExtensionPoint`는 `deps: [submenusExtensionPoint]`, `viewsExtensionPoint`는 `deps: [viewsContainersExtensionPoint]`를 선언한다.

### 2.3 여섯 파트와 관련된 지점

| 지점 | 파일 | 심볼 | 핸들러가 하는 일 |
|---|---|---|---|
| `commands` | `src/vs/workbench/services/actions/common/menusExtensionPoint.ts` | `commandsExtensionPoint` | `id`, `title`, `category`, `icon`, `precondition`(`enablement`에서), `source`로 `MenuRegistry.addCommand`를 호출한다. 메뉴와 팔레트를 위해 커맨드를 선언할 뿐이다. 실행 콜백은 확장이 나중에 API로 넣는다(5.3절). |
| `submenus` | 같은 파일 | `submenusExtensionPoint` | 다른 `menus` 항목이 대상으로 삼을 수 있는 서브메뉴 id를 등록한다. |
| `menus` | 같은 파일 | `menusExtensionPoint` | 각 키를 `_apiMenusByKey`(`apiMenus`에서 만든다)나 등록된 서브메뉴에서 찾고, `MenuRegistry.appendMenuItem`으로 항목을 더한다. 모르는 키는 조용히 건너뛴다(`if (!menu) { continue; }`). |
| `viewsContainers` | `src/vs/workbench/api/browser/viewsExtensionPoint.ts` | `viewsContainersExtensionPoint`, `ViewsExtensionHandler` | `activitybar`, `panel`, `secondarySidebar`에 뷰 컨테이너를 만든다. `registerCustomViewContainers`가 이를 `ViewContainerLocation.Sidebar`, `Panel`, `AuxiliaryBar`로 옮긴다. |
| `views` | 같은 파일 | `viewsExtensionPoint` | `IViewDescriptor`를 컨테이너에 등록한다. 내장 키(`explorer`, `debug`, `scm`, `test`, `remote`)나 기여된 컨테이너 id를 쓴다. |

이것들이 놓이는 자리는 [vscode-workbench-layout.md](vscode-workbench-layout.md)(뷰 컨테이너와 `ViewDescriptorService`)에 있다.

### 2.4 확장은 최상위 메뉴를 기여할 수 없다

에픽이 기대고 있는 결정이다.

- 확장이 `contributes.menus` 아래 쓸 수 있는 키의 전체 목록은 `menusExtensionPoint.ts`의 `apiMenus` 배열(`IAPIMenu[]`)이다. 이 커밋에서 98개 항목이고, 각각 `{ key, id: MenuId, description, proposed?, supportsSubmenus? }`다.
- 메뉴 바 최상위 메뉴(파일, 편집, 선택, 보기, 이동, 실행, 터미널, 도움말)에 해당하는 키는 없다. 표의 키는 기존 UI의 안쪽이나 곁의 위치다. 예: `commandPalette`, `editor/title`, `editor/context`, `explorer/context`, `view/title`, `view/item/context`, `viewContainer/title`, `statusBar/remoteIndicator`, `file/newFile`, `file/share`.
- 이름이 `menuBar/`로 시작하는 두 키도 최상위 메뉴를 더하지 않는다. `menuBar/edit/copy`는 `MenuId.MenubarCopy`(최상위 Edit 메뉴 안의 "Copy as" 서브메뉴)이고, `menuBar/home`(`MenuId.MenubarHomeMenu`)은 웹 전용 홈 표시기 메뉴이며 `contribMenuBarHome` 제안 API 뒤에 있다.
- `menus` 핸들러는 `apiMenus`에도 등록된 서브메뉴에도 없는 키를 건너뛰고, `proposed` 키는 `isProposedApiEnabled(extension.description, menu.proposed)`가 아니면 `collector.error`로 알린다.
- 최상위 메뉴 자체는 확장이 아니라 워크벤치가 등록한다: `src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts`(예: `MenuId.MenubarFileMenu`)와 `menubarControl.ts`([vscode-menus-commands.md](vscode-menus-commands.md) 참고).
- 실무 규칙: 확장은 고정된 위치에 항목과 서브메뉴를 더할 수 있지만 새 최상위 메뉴는 만들 수 없다.

## 3. 활성화

### 3.1 메인 스레드: `AbstractExtensionService.activateByEvent`

- 시그니처: `abstractExtensionService.ts`의 `activateByEvent(activationEvent: string, activationKind = ActivationKind.Normal): Promise<void>`.
- 동작 순서:
  - 이벤트를 항상 `_allRequestedActivateEvents`에 기억한다. 호스트가 재시작될 때 재생하고, 이벤트 이후에 추가된 확장을 `_activateAddedExtensionIfNeeded`가 활성화할 수 있게 한다.
  - 확장이 이미 스캔됐고(`_installedExtensionsReady.isOpen()`) `this._registry.containsActivationEvent(activationEvent)`가 거짓이면 no-op 프라미스를 돌려준다. 관심 있는 확장이 없으니 RPC도 없다.
  - 아직 스캔 전이면: `ActivationKind.Immediate`는 호스트 생성(`_initializeIfNeeded`)을 시작하고 기다리지 않고 활성화한다. 아니면 `_installedExtensionsReady`를 기다린다.
  - `_activateByEvent`가 모든 `IExtensionHostManager`에 `extHostManager.activateByEvent`로 퍼뜨린다. `Immediate`면 로컬 호스트와 준비된 원격 호스트로 제한하고 이벤트를 `_pendingRemoteActivationEvents`에 넣는다.
  - UI가 대기 상태를 보여 줄 수 있게 `_onWillActivateByEvent`를 발생시킨다.
- `_activateAddedExtensionIfNeeded`는 리터럴 이벤트 `*`와 `onStartupFinished`(즉시 활성화), `workspaceContains...`(작업 공간 검색 필요)도 따로 다룬다.

### 3.2 암묵적 활성화 이벤트

- 작성자가 `activationEvents`를 나열하지만 기여 지점도 `contributes`에서 이벤트를 만든다. `implicitActivationEvents.ts`의 `ImplicitActivationEventsImpl.readActivationEvents`는 매니페스트의 `activationEvents`에서 시작해 맨 `onUri`를 `onUri:<확장 키>`로 바꾸고, `contributes`의 각 키마다 그 지점에 등록된 생성기를 호출한다.
- 생성기는 `registerExtensionPoint`의 `activationEventsGenerator`로 전달된다. 관련된 것:

| 기여 | 파일 | 만들어지는 이벤트 |
|---|---|---|
| `commands` | `menusExtensionPoint.ts` | 기여된 각 커맨드의 `onCommand:<command id>` |
| `views` | `viewsExtensionPoint.ts` | 각 뷰의 `onView:<view id>` |
| `languages` | `src/vs/workbench/services/language/common/languageService.ts` | 언어 이벤트 |
| `authentication` | `src/vs/workbench/services/authentication/browser/authenticationService.ts` | 인증 이벤트 |

- 결과: 기여된 커맨드나 뷰는 `activationEvents` 항목이 없어도 확장을 깨운다. `contributes.commands`가 아니라 코드에서만 등록된 커맨드에는 암묵적 이벤트가 없다.
- 커맨드 실행 쪽: `src/vs/workbench/services/commands/common/commandService.ts`의 `CommandService.executeCommand`는 항상 `onCommand:<id>`를 활성화 이벤트로 보낸다.
  - 이미 등록돼 있고 그 이벤트가 끝났으면(`activationEventIsDone`) 바로 실행한다.
  - 등록돼 있는데 호스트가 아직 시작 전이면 기다리지 않고 이벤트를 보내면서 바로 실행한다.
  - 등록돼 있고 호스트가 준비됐으면 이벤트를 기다린 뒤 실행한다.
  - 등록되어 있지 않으면 이벤트와 함께 `*` 활성화(`_activateStar`, 최대 30초)와 커맨드 등록(`CommandsRegistry.onDidRegisterCommand`)을 경주시킨다.

### 3.3 호스트 쪽: `ExtensionsActivator`

- `src/vs/workbench/api/common/extHostExtensionActivator.ts`의 `ExtensionsActivator`:
  - `activateByEvent(activationEvent, startup)`: `_alreadyActivatedEvents[activationEvent]`가 있으면 바로 돌아온다. 아니면 레지스트리에서 이벤트에 맞는 설명을 받아 활성화하고 이벤트를 끝난 것으로 표시한다. 이벤트 문자열은 한 번만 처리된다.
  - `activateById(extensionId, reason)`: 의존성과 명시적 요청에 쓰이는 직접 경로이며, 모르는 확장이면 던진다.
  - `_handleActivationRequest`는 확장마다 `ActivationOperation` 하나를 만들고(`_operations`로 재사용), 먼저 `extensionDependencies`를 푼다: 모르는 의존성은 `FailedExtension`과 `MissingExtensionDependency`가 되고, 서술용 의존성(`main`도 `browser`도 없음)은 건너뛰며, 그 밖에는 같은 이유로 먼저 활성화한다.
  - `ActivationOperation`은 의존성을 기다리고, 하나가 실패했으면 스스로 실패한다("because its dependency ... failed to activate"). 이후 `_activate`가 `IExtensionsActivatorHost.actualActivateExtension`을 부르고, 오류는 호출자에게 예외가 아니라 실패한 확장으로 처리된다.
- `src/vs/workbench/api/common/extHostExtensionService.ts`의 `AbstractExtHostExtensionService._activateExtension`이 `_getEntryPoint`와 `_loadCommonJSModule`로 진입점을 불러 `ExtensionContext`를 만들고, `_callActivate`가 모듈의 `activate`를 호출한다.
- 호스트 시작: 초기화 후 `this._activateByEvent('*', true)`로 `*`를 활성화한다. `$activateByEvent`는 메인 스레드가 다른 이벤트에 쓰는 RPC 메서드다.

## 4. 브라우저에서의 호스트와 격리

### 4.1 호스트 고르기

- `src/vs/workbench/services/extensions/browser/extensionService.ts`의 `BrowserExtensionHostFactory.createExtensionHost`가 `ExtensionHostKind.LocalWebWorker`에는 `WebWorkerExtensionHost`를, 원격 권한이 있으면 `RemoteExtensionHost`(범위 밖)를 만든다.
- 브라우저 `ExtensionService`는 `{ hasLocalProcess: false, allowRemoteExtensionsInLocalWebWorker: true }`를 넘긴다. Node 프로세스가 없다. `BrowserExtensionHostKindPicker.pickRunningLocation`은 `extensionKind`가 `web`인 설치된 확장에 `ExtensionHostKind.LocalWebWorker`를 고른다(실행 선호가 `None` 또는 `Local`일 때).

### 4.2 iframe: `WebWorkerExtensionHost`

`webWorkerExtensionHost.ts`의 `WebWorkerExtensionHost._startInsideIframe`은 Worker를 직접 만들지 않는다. 순서:

1. `_getWebWorkerExtensionHostIframeSrc`가 iframe URL을 정한다(4.3절).
2. `sandbox="allow-scripts allow-same-origin"`, `display: none`, `aria-hidden`인 `iframe`을 만들어 `ILayoutService.mainContainer`에 붙인다.
3. iframe 페이지 `src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html`이 부모에 `vscode.bootstrap.nls`를 보낸다. 부모는 워커 URL(`_webWorkerService.getWorkerUrl(extensionHostWorkerMainDescriptor)`), `_VSCODE_FILE_ROOT`, NLS 메시지와 언어로 답한다.
4. iframe이 `_VSCODE_NLS_MESSAGES`, `_VSCODE_NLS_LANGUAGE`, `_VSCODE_FILE_ROOT`를 설정하고 `await import(workerUrl)`을 하는 Blob 스크립트를 만들어 `new Worker(blobUrl, { name, type: 'module' })`로 시작한다. 워커 이름은 `ExtensionHostWorker`(또는 `DebugExtensionHostWorker`)이고, js-debug도 갱신하지 않고는 바꾸지 말라는 주석이 있다.
5. 워커가 `MessageChannel`을 만들어 `port2`를 내보내고 iframe이 이를 부모에 넘긴다. 부모는 `MessagePort`를 받아 이후 워커와 직접 통신한다.
6. `_performHandshake`: `Ready`를 기다리고, 초기화 데이터를 보내고, `Initialized`를 기다린다.
7. `environmentService.options.messagePorts`의 확장 API 메시지 포트는 `vscode.init`으로 전달된다.

### 4.3 iframe이 일반 Worker에 더하는 것과 사용 시점

| 성질 | 메커니즘 | 심볼이나 파일 |
|---|---|---|
| 확장 코드의 별도 오리진 | iframe을 `productService.webEndpointUrlTemplate`의 `{{uuid}}`, `{{commit}}`, `{{quality}}`를 치환해 로드하므로 확장 JS가 워크벤치 오리진(쿠키, IndexedDB, localStorage)을 공유하지 않는다. | `_getWebWorkerExtensionHostIframeSrc` |
| 안정된 오리진 | 작업 공간 스토리지의 UUID(`webWorkerExtensionHostIframeStableOriginUUID`, `StorageScope.WORKSPACE`)가 다시 로드해도 오리진을 유지한다. | 같은 함수 |
| 부모와의 결속 | 서브도메인이 `v--<hash>`이고 해시는 `parentOriginHash(mainWindow.origin, uuid)`(`src/vs/base/browser/iframe.ts`)다. iframe 페이지가 `crypto.subtle`로 다시 계산하고 불일치면 시작을 거부한다. | `webWorkerExtensionHostIframe.html` |
| 동일 오리진 가드 | 호스트 이름에 `v--` 표지가 없으면 `window.origin`과 다른 `parentOrigin`을 거부한다(공격 시나리오는 페이지 주석에 있다). | 같은 파일 |
| CSP | `default-src 'none'`과 명시적 `script-src`, `connect-src`, `child-src`를 가진 `<meta http-equiv="Content-Security-Policy">`. | 같은 파일 |
| 중첩 Worker | 확장 호스트가 요청한 Worker를 iframe이 만든다(`_newWorker`, `_terminateWorker` 메시지). 워커 쪽은 `src/vs/workbench/services/extensions/worker/polyfillNestedWorker.ts`의 `NestedWorker`다. | HTML과 `extensionHostWorker.ts` |
| 교차 출처 격리 | `COI.addSearchParam`과 COEP용 `?vscode-coi=2`. | `webWorkerExtensionHost.ts`, HTML |

VS Code가 언제 어느 변형을 쓰는가:

- 웹 워커 호스트는 항상 iframe + Worker다. `WebWorkerExtensionHost`에 Worker 직접 경로는 없다.
- 교차 오리진 iframe은 `platform.isWeb`이고 `IProductService`에 `webEndpointUrlTemplate`, `commit`, `quality`가 모두 있을 때만 쓴다.
- 그렇지 않으면 `IWebWorkerService.getWorkerUrl`로 해석한 동일 오리진 iframe으로 후퇴하고 `The web worker extension host is started in a same-origin iframe!`를 경고로 남긴다. 그 제품 설정이 없는 로컬 개발이나 자체 호스팅 빌드가 이 경우다.

### 4.4 워커가 확장 코드에서 빼앗는 것

`src/vs/workbench/api/worker/extensionHostWorker.ts`는 확장 코드보다 먼저 실행되어 전역 범위를 바꾼다:

| 전역 | 변경 |
|---|---|
| `self.close` | `console.trace` 스텁으로 교체(`'close' has been blocked`). 내부 종료용으로 원본은 `nativeClose`에 보관 |
| `self.postMessage` | 스텁으로 교체. 원본은 `nativePostMessage`에 보관 |
| `self.addEventListener` | 스텁으로 교체 |
| `self.importScripts` | `'importScripts' has been blocked`를 던진다 |
| `AMDLoader`, `NLSLoaderPlugin`, `define`, `require` | `undefined` |
| `webkitRequestFileSystem`, `webkitRequestFileSystemSync`, `webkitResolveLocalFileSystemSyncURL`, `webkitResolveLocalFileSystemURL` | `undefined` |
| `Worker` | 감쌈: `file:` URL은 브라우저 URI로 바꾸고, `vscode-remote:`는 던지며(`Creating workers from remote extensions is currently not supported.`), 현재 오리진을 유지하도록 blob으로 만든다. `Worker`가 없으면 `NestedWorker`를 쓴다 |
| `fetch`, `XMLHttpRequest` | 호스트 시작 후 `patchFetching`이 고친다: `file:`과 `vscode-remote:` URL을 `extHostMain.asBrowserUri`로 변환 |

이 커밋에서 막지 않는 것: 이 파일은 타입 전용 `namespace self`에 `indexedDB`와 `caches`를 선언하지만 덮어쓰지 않는다. 제거된다고 쓰면 안 된다.

### 4.5 모듈 로딩: `_loadCommonJSModule`

`src/vs/workbench/api/worker/extHostExtensionService.ts`의 `ExtHostExtensionService._loadCommonJSModule`:

- 진입점에 확장자가 없으면 `.js`를 붙인다(`ensureSuffix`).
- 메인 스레드에서 `$asBrowserUri`로 URL을 해석한다(`resourceUriProvider`는 거기에만 있다). 그 뒤 `fetch`하고 상태 200을 요구한다.
- `//# sourceURL=...#vscode-extension` 표지를 붙인 `new Function('module', 'exports', 'require', fullSource)`를 만들고, 로컬 `module`, `exports`와 `WorkerRequireInterceptor.getModule`에 기댄 `require`로 실행한다. `require('vscode')`는 확장별 API를 돌려주고, 그 밖의 요청이 `undefined`를 돌려주면 `Cannot load module '<request>'`를 던진다.
- `_loadESMModule`은 `ESM modules are not supported in the web worker extension host`를 던진다. 따라서 웹 확장은 `browser` 진입점이 `activate`를 내보내는, 번들된 CommonJS 형태의 단일 스크립트여야 한다.
- `_beforeAlmostReadyToRunExtensions`가 확장을 불러오기 전에 `createApiFactoryAndRegisterActors`를 실행하고 인터셉터를 설치한다.

## 5. 양면 API

### 5.1 구성 요소

| 구성 요소 | 파일 | 역할 |
|---|---|---|
| `createApiFactoryAndRegisterActors` | `src/vs/workbench/api/common/extHost.api.impl.ts` | 호스트에서 실행된다. 모든 `ExtHost*` 구현을 `rpcProtocol.set(ExtHostContext.X, impl)`로 등록하고, 확장 하나의 `vscode` 객체를 만드는 팩토리 `(extension, extensionInfo, configProvider) => typeof vscode`를 돌려준다. |
| `MainContext`, `ExtHostContext` | `src/vs/workbench/api/common/extHost.protocol.ts` | `createProxyIdentifier<Shape>('Name')`의 두 표. `MainContext.X`는 메인 스레드로의 프록시, `ExtHostContext.X`는 호스트로의 프록시다. 각각 `$메서드` 시그니처의 `...Shape` 인터페이스가 있다. |
| `RPCProtocol` | `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | 같은 `IMessagePassingProtocol` 위의 양쪽 인스턴스 하나씩. |
| `extHostNamedCustomer` | `src/vs/workbench/services/extensions/common/extHostCustomers.ts` | 메인 스레드 클래스를 `MainContext` id에 등록하는 데코레이터. |

### 5.2 `RPCProtocol`의 동작

- `getProxy(identifier)`는 `Proxy`를 돌려준다. `_createProxy`는 이름이 `$`로 시작하는(`CharCode.DollarSign`) 속성에만 처음 접근할 때 함수를 만들어 `_remoteCall(rpcId, name, args)`를 호출한다. 즉 Shape의 `$` 접두 메서드만 원격이다.
- `set(identifier, value)`는 로컬 구현을 `_locals[identifier.nid]`에 둔다.
- 받는 쪽에서 `_receiveRequest`가 `_invokeHandler`, `_doInvokeHandler`를 호출한다: `_locals[rpcId]`와 이름으로 메서드를 찾고, 오류는 `Unknown actor ...`, `Unknown method ... on actor ...`다. 마지막 인자가 취소 토큰이면 `CancellationTokenSource`로 다시 만든다.
- 메인 스레드 설정: `src/vs/workbench/services/extensions/common/extensionHostManager.ts`의 `ExtensionHostManager`가 `new RPCProtocol(protocol, logger)`를 만들고, `ExtHostCustomersRegistry.getNamedCustomers()`의 모든 named customer를 만들어 `this._rpcProtocol.set(id, instance)`로 등록한 뒤, `assertRegistered(mainProxyIdentifiers)`가 빠진 것이 있으면 `Missing proxy instance`를 던진다.
- 호스트 쪽 설정: `src/vs/workbench/api/common/extensionHostMain.ts`의 `ExtensionHostMain`이 `new RPCProtocol(protocol, null, uriTransformer)`를 만든다.

### 5.3 끝에서 끝까지: `commands`

확장이 커맨드를 등록할 때:

1. `vscode.commands.registerCommand`(`extHost.api.impl.ts`에서 만든 `commands` 객체)가 `extHostCommands.registerCommand(true, id, callback, thisArgs, undefined, extension)`를 부른다.
2. `src/vs/workbench/api/common/extHostCommands.ts`의 `ExtHostCommands.registerCommand`는 빈 id와 중복(`command '<id>' already exists`)에 던지고, 콜백을 `_commands`에 저장하며, `global`이면 `MainContext.MainThreadCommands`의 `#proxy.$registerCommand(id)`를 부른다.
3. `src/vs/workbench/api/browser/mainThreadCommands.ts`의 `MainThreadCommands.$registerCommand`(`@extHostNamedCustomer(MainContext.MainThreadCommands)`가 붙어 있다)가 `CommandsRegistry.registerCommand(id, ...)`에 얇은 핸들러를 등록한다. 이 핸들러는 `this._proxy.$executeContributedCommand(id, ...args)`를 부르고 결과를 `revive`한다. 프록시는 `ExtHostContext.ExtHostCommands`다.

워크벤치(팔레트, 키바인딩, 메뉴)에서 실행할 때: `CommandService.executeCommand`가 `CommandsRegistry`에서 얇은 핸들러를 찾고, 이 핸들러가 호스트로 `$executeContributedCommand`를 보낸다. `ExtHostCommands._executeContributedCommand`가 `metadata.args` 제약을 검증하고 `callback.apply(thisArg, args)`를 실행한다.

확장이 실행할 때(`vscode.commands.executeCommand`):

- `ExtHostCommands._doExecuteCommand`: `_commands.has(id)`면 호스트 안에 머물고 어떤 인자 타입도 통과시키며, 기다리지 않고 `$fireCommandActivationEvent(id)`를 보낸다. 아니면 `Position`, `Range`, `Location`, `NotebookRange`, `ArrayBuffer`, `Uint8Array`를 DTO로 바꾸어 `MainThreadCommands.$executeCommand(id, args, retry)`를 부른다.
- `MainThreadCommands.$executeCommand`는 인자를 `revive`하고, `retry`가 있고 인자가 있으며 `CommandsRegistry.getCommand(id)`가 없으면 `activateByEvent('onCommand:<id>')`를 기다린 뒤 `$executeCommand:retry`를 던진다. 호스트가 `retry`를 거짓으로 한 번 다시 실행한다. 그 밖에는 `ICommandService.executeCommand`를 부른다.

두 방향을 한 표로:

| 방향 | 프록시 | 여기서 쓰는 메서드 |
|---|---|---|
| 호스트에서 메인으로 | `MainContext.MainThreadCommands` / `MainThreadCommandsShape` | `$registerCommand`, `$unregisterCommand`, `$fireCommandActivationEvent`, `$executeCommand`, `$getCommands` |
| 메인에서 호스트로 | `ExtHostContext.ExtHostCommands` / `ExtHostCommandsShape` | `$executeContributedCommand`, `$getContributedCommandMetadata` |

새 API 쌍의 규칙: `extHost.protocol.ts`에 `$` 메서드의 `...Shape`를 추가하고, `MainContext.X` 또는 `ExtHostContext.X` id를 만들고, 받는 쪽 구현을 둔다(메인 스레드는 `@extHostNamedCustomer`, 호스트는 `createApiFactoryAndRegisterActors`의 `rpcProtocol.set`). 그리고 팩토리가 돌려주는 객체에 노출한다.

## 6. 웹 확장 설치

### 6.1 커맨드

- "Install Extension from Location..."은 `src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts`의 `workbench.extensions.action.installExtensionFromLocation`이다(카테고리 `Categories.Developer`). `CONTEXT_HAS_WEB_SERVER` 또는 `CONTEXT_HAS_LOCAL_SERVER`일 때만 `MenuId.CommandPalette`에 나온다.
- `isWeb`이면 퀵 픽("Location of the web extension")을 열고 `extensionManagementService.installFromLocation(URI.parse(quickPick.value))`를 부른다. 데스크톱에서는 대신 폴더 대화 상자를 보인다(범위 밖).

### 6.2 서비스 체인

| 단계 | 파일 | 심볼 | 비고 |
|---|---|---|---|
| 경로 선택 | `src/vs/workbench/services/extensionManagement/common/extensionManagementService.ts` | `installFromLocation` | 스킴별: `file`은 로컬 서버, `vscode-remote`는 원격 서버, 그 밖은 `webExtensionManagementServer`(없으면 `Web extension management server is not found`). `userDataProfileService.currentProfile.extensionsResource`를 넘긴다. |
| 설치 | `src/vs/workbench/services/extensionManagement/common/webExtensionManagementService.ts` | `WebExtensionManagementService.install`, `installFromLocation` | `scanExtensionManifest`로 매니페스트를 읽고, `name`이나 `version`이 없으면 거부한다(`Cannot find a valid extension from the location`). 그 뒤 `installExtensions`. |
| 작업 | 같은 파일 | `InstallExtensionTask` | URI 소스에는 `webExtensionsScannerService.addExtension`(갤러리는 `addExtensionFromGallery`)을 부른다. |
| 저장 | `src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts` | `WebExtensionsScannerService.addExtension` | `toWebExtension`이 `package.json`을 가져오고(`getExtensionManifest`가 위치에 `package.json`을 붙여 `IExtensionResourceLoaderService.readExtensionResource`로 읽는다), `addToInstalledExtensions`가 목록을 쓴다. |
| 제거 | `webExtensionManagementService.ts`와 스캐너 | `UninstallExtensionTask`, `removeExtension` | 저장된 목록에서 항목을 걸러 낸다. `deleteExtension`은 no-op이다(복사하지 않고 URL에서 로드한다). |
| 목록 | 스캐너 | `scanUserExtensions(profileLocation)` | 커스텀 내장 확장(워크벤치 옵션 `additionalBuiltinExtensions`)과 설치 목록을 합치고, id가 같으면 설치된 것이 이긴다. `scanSystemExtensions`는 내장 쪽이다([vscode-web-build.md](vscode-web-build.md)). |

- 설치 목록은 `IStoredWebExtension` JSON 배열이며 `withWebExtensions(file, updateFn)`이 `IFileService`로 읽고 쓴다. 파일별 `Queue`(`getResourceAccessQueue`)가 동시 갱신을 직렬화하고, `location`, `identifier`, `version`이 없는 항목은 무시한다(`Ignoring invalid extension while scanning`). 파일은 `profileLocation`, 곧 프로필의 `extensionsResource`다. 브라우저에서 `IFileService`가 그 파일을 어디에 두는지는 [vscode-state-settings.md](vscode-state-settings.md)에 있다.
- 설치는 코드가 아니라 URL을 기록한다. 확장은 시작할 때마다 그 위치에서 가져온다. 위치가 응답을 멈추거나 CORS를 잃으면 확장이 깨진다.

### 6.3 매니페스트 검증

- `src/vs/platform/extensions/common/extensionValidator.ts`의 `validateExtensionManifest(productVersion, productDate, extensionLocation, extensionManifest, extensionIsBuiltin)`는 `[Severity, message][]`를 돌려준다. `publisher`가 문자열이 아니거나, `name`이나 `version`이 문자열이 아니거나, `engines`가 없거나, `engines.vscode`가 문자열이 아니면 `Error`로 일찍 돌아온다. `isValidExtensionVersion`과 `isEngineValid`로 엔진 범위도 검사한다.
- 호출처: `WebExtensionsScannerService.toScannedExtension`(브라우저 경로)과 `src/vs/platform/extensionManagement/common/extensionsScannerService.ts`(브라우저에서는 쓰지 않음).
- `toScannedExtension`에서 `Severity.Error`가 하나라도 있으면 메시지를 로그하고 `isValid`를 거짓으로 둔다. 확장은 나열되지만 실행되지 않는다. 내장 확장은 이를 거치지 않는다(`BuiltinExtensionsScannerService`에서 `validations: []`, `isValid: true`).
- 알아 둘 간극: `install` 자체는 `name`과 `version`만 요구하고 `engines.vscode`는 스캔할 때 강제한다. `engines`가 없는 확장은 설치된 뒤 무효로 보인다.

## 7. 이 워크벤치에 주는 시사점

위의 사실과 구분되는 제안이다.

- 기여 지점: `setHandler`와 전체 목록 재실행 의미를 가진 작은 `ExtensionPoint` 레지스트리면 충분하다. "모두 지우고 다시 추가" 핸들러 형태를 재사용하면 설치와 제거에 증분 로직이 필요 없다.
- 메뉴: 확장이 가리킬 수 있는 메뉴 위치를 `apiMenus` 같은 표 하나로 고정하고 모르는 키는 무시한다. 확장에 최상위 메뉴를 열어 주지 않는다.
- 활성화: 이벤트 문자열 모델을 유지하고, 암묵적 `onCommand:`와 `onView:` 생성기를 두며, 이벤트를 한 번만 처리한다(`_alreadyActivatedEvents`).
- 호스트: VS Code가 격리에 치르는 비용은 iframe, Blob 부트스트랩, 핸드셰이크, 오리진 검증 체계다. 확장이 신뢰되거나 번들돼 있다면 같은 전역 차단(4.4절)을 한 일반 모듈 Worker가 더 작은 한 걸음이다. 별도 오리진과 CSP를 주는 것이 iframe이다.
- 로딩: `browser` 진입점만, `fetch` 후 `new Function`과 `require('vscode')` 가로채기, ESM 없음이 워커 호스트와 같다.
- API: `$` 접두 프록시 규칙과 두 식별자 표를 가져오면 계약이 파일 하나가 된다.
- 설치: 코드가 아니라 `{ location, identifier, version, manifest }`를 저장하고, `engines` 검증은 스캔이 아니라 설치 시점에 한다.

Decided in: wr-e8v6
