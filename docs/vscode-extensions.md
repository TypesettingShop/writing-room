# VS Code 확장: 매니페스트, 활성화, 호스트, 양면 API

기준: VS Code 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`(패키지 버전 1.148.0). 모든 기술 내용은 `src/vs/...` 경로의 파일과 내부 심볼을 기준으로 명시한다. 줄 번호는 변경될 수 있으므로 심볼명을 검색하여 참조한다. 본 문서의 경로는 VS Code 원본 경로이며, writing-room에서는 `src/vs/<path>`가 `src/<path>`에 대응한다([architecture.md](architecture.md)).

개요: [README.md](README.md). 관련 문서: [vscode-menus-commands.md](vscode-menus-commands.md)(기여가 등록되는 레지스트리), [vscode-web-build.md](vscode-web-build.md)(내장 확장이 브라우저로 로드되는 방식), [vscode-state-settings.md](vscode-state-settings.md)(상태 저장소).

v0.1.0 범위 밖이므로 이름만 표기: 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드. 확장 호스트 종류 중 `LocalProcess`와 `Remote`(`src/vs/workbench/services/extensions/common/extensionHostKind.ts`의 `ExtensionHostKind`)는 데스크톱 및 원격 빌드 전용이므로 다루지 않는다.

## 1. 한눈에 보는 파이프라인

| 단계 | 실행 위치 | 파일과 심볼 | 결정하는 것 |
|---|---|---|---|
| 매니페스트 | 데이터 | `src/vs/platform/extensions/common/extensions.ts`의 `IExtensionManifest` | `package.json` 명세: `main`, `browser`, `activationEvents`, `contributes`, `extensionDependencies`, `extensionPack`, `extensionKind`. |
| 기여 지점 | 메인 스레드(렌더러) | `src/vs/workbench/services/extensions/common/extensionsRegistry.ts`의 `ExtensionsRegistry`, `ExtensionPoint` | `contributes` 하위에 허용되는 키 정의 및 처리 로직 매핑. |
| 활성화 요청 | 메인 스레드 | `src/vs/workbench/services/extensions/common/abstractExtensionService.ts`의 `AbstractExtensionService.activateByEvent` | 발생한 이벤트에 관심 있는 확장의 존재 여부 및 대상 호스트 결정. |
| 활성화 실행 | 확장 호스트 | `src/vs/workbench/api/common/extHostExtensionActivator.ts`의 `ExtensionsActivator` | 확장의 의존성 순서 처리 및 중복 없는 활성화 실행. |
| 호스트 | iframe + Worker | `src/vs/workbench/services/extensions/browser/webWorkerExtensionHost.ts`의 `WebWorkerExtensionHost` | 브라우저 환경에서 확장 코드가 격리되어 실행되는 위치 정의. |
| API | 양쪽 | `src/vs/workbench/api/common/extHost.api.impl.ts`, `extHost.protocol.ts`, `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | `vscode.*` API 호출이 메인 스레드 동작으로 변환되는 RPC 구조. |
| 설치 | 메인 스레드 | `src/vs/workbench/services/extensionManagement/...` | 웹 확장의 추가, 목록 조회, 삭제 처리. |

## 2. 매니페스트와 기여 지점

### 2.1 매니페스트

- `src/vs/platform/extensions/common/extensions.ts`의 `IExtensionManifest`가 타입 정의된 `package.json` 명세다. 핵심 필드: `main`(Node 환경 진입점), `browser`(웹 환경 진입점), `activationEvents`, `contributes`(`IExtensionContributions`), `extensionDependencies`, `extensionPack`, `extensionKind`.
- 웹 워커 호스트는 `browser` 필드만 읽는다: `src/vs/workbench/api/worker/extHostExtensionService.ts`의 `ExtHostExtensionService._getEntryPoint`가 `extensionDescription.browser`를 반환한다. `main`만 명시된 확장은 웹 워커 호스트에서 진입점이 없는 것으로 간주된다.
- `src/vs/platform/extensionManagement/common/implicitActivationEvents.ts`의 `ImplicitActivationEventsImpl._readActivationEvents`는 `main`과 `browser`가 모두 없으면 빈 목록을 반환한다. 순수 선언형 확장은 확장 호스트에서 활성화되지 않지만, 선언된 기여 지점은 메인 스레드가 매니페스트에서 직접 파싱하므로 정상 동작한다.

### 2.2 `ExtensionsRegistry`와 `ExtensionPoint`

- `extensionsRegistry.ts`의 `ExtensionsRegistry`(`ExtensionsRegistryImpl` 인스턴스, `Registry.as(PRExtensions.ExtensionsRegistry)`)가 기여 지점 레지스트리다.
- `registerExtensionPoint({ extensionPoint, jsonSchema, deps, activationEventsGenerator, ... })`의 세 가지 핵심 역할:
  - 기여 지점명이 중복되면 `Duplicate extension point` 에러를 던진다.
  - `activationEventsGenerator`를 `ImplicitActivationEvents`에 등록한다(3.2절 참조).
  - `jsonSchema`를 같은 파일의 `schema`에서 `contributes` 아래에 추가한다. `package.json` 검증과 자동 완성이 여기서 나온다.
- `ExtensionPoint<T>`는 단일 핸들러와 현재 사용자 목록을 관리한다. `setHandler`는 정확히 한 번만 등록할 수 있다(재등록 시 `Handler already set!` 예외 발생). `acceptUsers`는 `ExtensionPointUserDelta`(`added`, `removed`)를 계산한 뒤 전체 사용자 목록과 변경분을 핸들러에 전달한다.
- 사용자 등록 흐름: `abstractExtensionService.ts`의 `AbstractExtensionService._handleExtensionPoint`가 사용 가능한 확장을 순회하며 `contributes[extensionPoint.name]`이 존재하는 확장마다 `IExtensionPointUser`(`description`, `value`, 로그용 `collector`)를 생성해 `acceptUsers`를 호출한다. 상위 호출자인 `_doHandleExtensionPoints`는 초기화 시점과 확장 추가/제거 시점에 실행된다.
- 따라서 각 핸들러는 선언적이고 재실행 가능(idempotent)하게 구현된다: `menus` 및 `commands` 핸들러는 기존 등록을 먼저 초기화(`_menuRegistrations.clear()`, `_commandRegistrations.clear()`)한 뒤 전체 목록을 처음부터 다시 등록한다.
- `deps` 배열로 핸들러 실행 순서를 정의한다: `menusExtensionPoint`는 `deps: [submenusExtensionPoint]`, `viewsExtensionPoint`는 `deps: [viewsContainersExtensionPoint]`를 선언한다.

### 2.3 여섯 파트와 관련된 지점

| 지점 | 파일 | 심볼 | 핸들러가 하는 일 |
|---|---|---|---|
| `commands` | `src/vs/workbench/services/actions/common/menusExtensionPoint.ts` | `commandsExtensionPoint` | `id`, `title`, `category`, `icon`, `precondition`(`enablement`에서 추출), `source`로 `MenuRegistry.addCommand`를 호출한다. 메뉴 및 팔레트 노출을 위한 커맨드 선언 등록일 뿐이며, 실행 핸들러 콜백은 확장이 추후 API로 등록한다(5.3절). |
| `submenus` | 같은 파일 | `submenusExtensionPoint` | 다른 `menus` 항목이 상위 메뉴로 참조할 수 있는 서브메뉴 id를 등록한다. |
| `menus` | 같은 파일 | `menusExtensionPoint` | 각 메뉴 위치 키를 `_apiMenusByKey`(`apiMenus` 기반) 또는 등록된 서브메뉴에서 조회하여 `MenuRegistry.appendMenuItem`으로 항목을 추가한다. 알 수 없는 키는 예외 없이 건너뛴다(`if (!menu) { continue; }`). |
| `viewsContainers` | `src/vs/workbench/api/browser/viewsExtensionPoint.ts` | `viewsContainersExtensionPoint`, `ViewsExtensionHandler` | `activitybar`, `panel`, `secondarySidebar` 위치에 뷰 컨테이너를 생성한다. `registerCustomViewContainers`가 이를 `ViewContainerLocation.Sidebar`, `Panel`, `AuxiliaryBar`로 매핑한다. |
| `views` | 같은 파일 | `viewsExtensionPoint` | `IViewDescriptor`를 컨테이너에 등록한다. 내장 식별자(`explorer`, `debug`, `scm`, `test`, `remote`) 또는 기여된 컨테이너 id를 사용한다. |

이 요소들이 배치되는 구조는 [vscode-workbench-layout.md](vscode-workbench-layout.md)(뷰 컨테이너와 `ViewDescriptorService`)를 참조한다.

### 2.4 확장은 최상위 메뉴를 기여할 수 없다

이는 상위 에픽 설계의 기반이 되는 핵심 제약이다.

- 확장이 `contributes.menus` 하위에 지정할 수 있는 키 목록은 `menusExtensionPoint.ts`의 `apiMenus` 배열(`IAPIMenu[]`)로 엄격히 제한된다. 이 커밋 기준으로 총 98개이며, 각각 `{ key, id: MenuId, description, proposed?, supportsSubmenus? }` 구조를 갖는다.
- 메뉴 바의 최상위 메뉴(파일, 편집, 선택, 보기, 이동, 실행, 터미널, 도움말 등)에 직접 대응하는 키는 존재하지 않는다. 지원되는 키는 모두 기존 UI 내부나 인접한 영역이다(예: `commandPalette`, `editor/title`, `editor/context`, `explorer/context`, `view/title`, `view/item/context`, `viewContainer/title`, `statusBar/remoteIndicator`, `file/newFile`, `file/share`).
- `menuBar/` 접두사로 시작하는 키들 역시 최상위 메뉴를 추가하지 않는다. `menuBar/edit/copy`는 `MenuId.MenubarCopy`(최상위 Edit 메뉴 내부의 "Copy as" 서브메뉴)이며, `menuBar/home`(`MenuId.MenubarHomeMenu`)은 제안 API `contribMenuBarHome` 뒤에 숨겨진 웹 전용 홈 표시기 메뉴다.
- `menus` 핸들러는 `apiMenus`나 등록된 서브메뉴 목록에 없는 키를 무시하며, `proposed` 키는 `isProposedApiEnabled(extension.description, menu.proposed)`가 참이 아닐 경우 `collector.error`로 에러를 보고한다.
- 최상위 메뉴 자체는 확장이 아니라 워크벤치 코어(`src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts`의 `MenuId.MenubarFileMenu` 등과 `menubarControl.ts`)가 등록한다([vscode-menus-commands.md](vscode-menus-commands.md) 참조).
- 설계 규칙: 확장은 기여 지점을 통해 정해진 하위 메뉴나 서브메뉴 항목을 추가할 수 있지만, 새로운 최상위 메뉴를 임의로 생성할 수는 없다.

## 3. 활성화

### 3.1 메인 스레드: `AbstractExtensionService.activateByEvent`

- 시그니처: `abstractExtensionService.ts`의 `activateByEvent(activationEvent: string, activationKind = ActivationKind.Normal): Promise<void>`.
- 동작 흐름:
  - 발생한 이벤트를 `_allRequestedActivateEvents`에 항상 보관한다. 호스트 재시작 시 이벤트를 재실행하고, 이벤트 이후 추가된 확장을 `_activateAddedExtensionIfNeeded`가 활성화할 수 있도록 보장한다.
  - 확장이 이미 스캔 완료되었고(`_installedExtensionsReady.isOpen()`), `this._registry.containsActivationEvent(activationEvent)`가 거짓이면 불필요한 RPC 호출 없이 즉시 no-op Promise를 반환한다.
  - 아직 스캔 중인 경우: `ActivationKind.Immediate`는 호스트 초기화(`_initializeIfNeeded`)를 트리거하고 대기 없이 즉시 활성화를 진행한다. 일반 활성화는 `_installedExtensionsReady` 완료를 기다린다.
  - `_activateByEvent`가 관리 중인 모든 `IExtensionHostManager` 인스턴스에 `extHostManager.activateByEvent`로 요청을 브로드캐스트한다. `Immediate` 모드인 경우 로컬 호스트와 준비된 원격 호스트로 제한하며 이벤트를 `_pendingRemoteActivationEvents`에 큐잉한다.
  - UI 레이어가 활성화 진행 상태를 감지할 수 있도록 `_onWillActivateByEvent` 이벤트를 발생시킨다.
- `_activateAddedExtensionIfNeeded`는 와일드카드 이벤트인 `*`와 `onStartupFinished`(즉시 활성화 대상), 그리고 `workspaceContains...`(작업 공간 파일 탐색 필요)를 별도로 처리한다.

### 3.2 암묵적 활성화 이벤트

- 개발자가 명시적으로 `activationEvents`를 작성하지 않더라도, 기여 지점이 `contributes` 선언으로부터 활성화 이벤트를 자동 생성한다. `implicitActivationEvents.ts`의 `ImplicitActivationEventsImpl.readActivationEvents`는 매니페스트의 `activationEvents`를 기반으로 기본 `onUri`를 `onUri:<확장 키>`로 정규화하고, `contributes`의 각 키마다 해당 기여 지점에 등록된 생성기를 호출한다.
- 생성기는 `registerExtensionPoint` 호출 시 `activationEventsGenerator` 옵션으로 등록된다. 주요 항목:

| 기여 | 파일 | 만들어지는 이벤트 |
|---|---|---|
| `commands` | `menusExtensionPoint.ts` | 기여된 각 커맨드별 `onCommand:<command id>` |
| `views` | `viewsExtensionPoint.ts` | 각 뷰별 `onView:<view id>` |
| `languages` | `src/vs/workbench/services/language/common/languageService.ts` | 언어 지원 이벤트 |
| `authentication` | `src/vs/workbench/services/authentication/browser/authenticationService.ts` | 인증 제공자 이벤트 |

- 결과: 기여된 커맨드나 뷰는 매니페스트의 `activationEvents`에 명시하지 않아도 호출 시 확장을 자동으로 활성화한다. 단, `contributes.commands`에 선언하지 않고 런타임 코드에서 동적으로 등록한 커맨드에는 이러한 암묵적 이벤트가 생성되지 않는다.
- 커맨드 실행 파이프라인: `src/vs/workbench/services/commands/common/commandService.ts`의 `CommandService.executeCommand`는 항상 `onCommand:<id>`를 활성화 이벤트로 발행한다.
  - 이미 등록되어 있고 해당 이벤트 처리가 끝났다면(`activationEventIsDone`) 즉시 핸들러를 실행한다.
  - 등록되어 있으나 호스트가 아직 시작 전인 경우, 활성화 이벤트를 비동기로 보내면서 즉시 핸들러를 실행한다.
  - 등록되어 있고 호스트가 준비된 상태라면 활성화 이벤트 완료를 대기한 뒤 실행한다.
  - 등록되어 있지 않은 경우, 활성화 이벤트 처리와 함께 와일드카드 `*` 활성화(`_activateStar`, 최대 30초 대기)와 커맨드 등록 이벤트(`CommandsRegistry.onDidRegisterCommand`) 중 먼저 끝나는 쪽을 `Promise.all`로 기다린 뒤 실행을 시도한다. 그때도 등록되지 않았으면 `command '<id>' not found`로 거부된다.

### 3.3 호스트 쪽: `ExtensionsActivator`

- `src/vs/workbench/api/common/extHostExtensionActivator.ts`의 `ExtensionsActivator`:
  - `activateByEvent(activationEvent, startup)`: `_alreadyActivatedEvents[activationEvent]`에 이미 기록되어 있다면 즉시 반환한다. 그렇지 않으면 레지스트리에서 해당 이벤트와 매칭되는 확장 목록을 가져와 활성화하고 처리 완료 상태로 표시한다. 이벤트 문자열은 중복 처리되지 않는다.
  - `activateById(extensionId, reason)`: 의존성 해결이나 명시적 호출에 사용되는 직접 활성화 경로이며, 등록되지 않은 확장이면 예외를 던진다.
  - `_handleActivationRequest`는 확장마다 `ActivationOperation` 인스턴스를 생성하고(`_operations` 맵으로 재사용), 먼저 `extensionDependencies`를 해결한다: 알 수 없는 의존성은 `FailedExtension` 및 `MissingExtensionDependency` 상태가 되고, 순수 선언형 의존성(`main`과 `browser`가 모두 없음)은 건너뛰며, 그 외 유효한 의존성은 동일한 이유로 먼저 활성화한다.
  - `ActivationOperation`은 선행 의존성의 활성화를 기다리며, 그중 하나라도 실패하면 자신 역시 실패 상태가 된다("because its dependency ... failed to activate"). 이후 `_activate`가 `IExtensionsActivatorHost.actualActivateExtension`을 호출하며, 실행 중 발생한 오류는 호출자에게 예외를 던지는 대신 실패한 확장 상태로 처리된다.
- `src/vs/workbench/api/common/extHostExtensionService.ts`의 `AbstractExtHostExtensionService._activateExtension`이 `_getEntryPoint`와 `_loadCommonJSModule`로 진입점 코드를 로드해 `ExtensionContext`를 생성하고, `_callActivate`가 모듈의 `activate` 함수를 실행한다.
- 호스트 시작 시퀀스: 초기화 완료 후 `this._activateByEvent('*', true)`로 와일드카드 `*` 이벤트를 활성화한다. `$activateByEvent`는 메인 스레드가 기타 이벤트를 전달할 때 호출하는 RPC 메서드다.

## 4. 브라우저에서의 호스트와 격리

### 4.1 호스트 선택

- `src/vs/workbench/services/extensions/browser/extensionService.ts`의 `BrowserExtensionHostFactory.createExtensionHost`가 `ExtensionHostKind.LocalWebWorker`에 대해서는 `WebWorkerExtensionHost`를 생성하고, 원격 실행 권한이 있는 경우 `RemoteExtensionHost`(범위 밖)를 인스턴스화한다.
- 브라우저 환경의 `ExtensionService`는 `{ hasLocalProcess: false, allowRemoteExtensionsInLocalWebWorker: true }` 옵션을 전달한다. 즉 Node 프로세스는 존재하지 않는다. `BrowserExtensionHostKindPicker.pickRunningLocation`은 `extensionKind`가 `web`으로 선언된 설치 확장에 대해 실행 위치로 `ExtensionHostKind.LocalWebWorker`를 선택한다(실행 선호도가 `None` 또는 `Local`일 때).

### 4.2 iframe: `WebWorkerExtensionHost`

`webWorkerExtensionHost.ts`의 `WebWorkerExtensionHost._startInsideIframe`은 Worker를 메인 창에서 직접 생성하지 않는다. 구동 순서:

1. `_getWebWorkerExtensionHostIframeSrc`를 통해 iframe URL을 결정한다(4.3절 참조).
2. `sandbox="allow-scripts allow-same-origin"`, `display: none`, `aria-hidden` 속성을 갖는 `iframe` 요소를 생성하여 `ILayoutService.mainContainer`에 추가한다.
3. iframe 페이지(`src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html`)가 부모 창에 `vscode.bootstrap.nls` 메시지를 전송한다. 부모 창은 워커 스크립트 URL(`_webWorkerService.getWorkerUrl(extensionHostWorkerMainDescriptor)`), `_VSCODE_FILE_ROOT`, NLS 번역 메시지 및 언어 설정으로 응답한다.
4. iframe 내부에서 `_VSCODE_NLS_MESSAGES`, `_VSCODE_NLS_LANGUAGE`, `_VSCODE_FILE_ROOT` 전역 변수를 설정하고 `await import(workerUrl)`을 수행하는 Blob 스크립트를 생성하여 `new Worker(blobUrl, { name, type: 'module' })`로 워커를 구동한다. 워커 이름은 `ExtensionHostWorker`(또는 디버그 시 `DebugExtensionHostWorker`)로 고정되어 있으며 js-debug 연동을 위해 임의로 변경하지 않도록 주석에 명시되어 있다.
5. 워커가 `MessageChannel`을 만들어 `port2`를 내보내고 iframe이 이를 부모에 넘긴다. 부모는 `MessagePort`를 받아 이후 워커와 직접 통신한다.
6. `_performHandshake`: `Ready` 신호를 대기하고, 초기화 데이터를 전송한 뒤, `Initialized` 응답을 확인한다.
7. `environmentService.options.messagePorts`에 정의된 확장 API 전용 메시지 포트들은 `vscode.init` 메시지를 통해 워커에 전달된다.

### 4.3 iframe이 일반 Worker에 더하는 것과 사용 시점

| 성질 | 메커니즘 | 심볼이나 파일 |
|---|---|---|
| 확장 코드의 별도 오리진 분리 | iframe 로드 시 `productService.webEndpointUrlTemplate`의 `{{uuid}}`, `{{commit}}`, `{{quality}}` 템플릿을 치환하므로, 확장의 JS 코드가 워크벤치 메인 창의 웹 스토리지(쿠키, IndexedDB, localStorage)에 직접 접근하지 못하도록 격리한다. | `_getWebWorkerExtensionHostIframeSrc` |
| 세션 간 일관된 오리진 유지 | 워크스페이스 스토리지에 보관된 UUID(`webWorkerExtensionHostIframeStableOriginUUID`, `StorageScope.WORKSPACE`)를 사용해 페이지가 새로고침되어도 동일한 격리 오리진을 유지한다. | 같은 함수 |
| 부모 창과의 상호 검증 결속 | 서브도메인이 `v--<hash>` 형식을 따르며, 해시값은 `parentOriginHash(mainWindow.origin, uuid)`(`src/vs/base/browser/iframe.ts`)로 계산된다. iframe 내부 페이지가 `crypto.subtle`로 이를 재계산하여 불일치 시 기동을 차단한다. | `webWorkerExtensionHostIframe.html` |
| 동일 오리진 보안 가드 | 호스트명에 `v--` 프리픽스가 없으면 `window.origin`과 일치하지 않는 `parentOrigin`의 연결을 거부한다(상세 공격 방어 시나리오는 소스 주석 참조). | 같은 파일 |
| 콘텐츠 보안 정책(CSP) | `default-src 'none'`과 명시적인 `script-src`, `connect-src`, `child-src` 지시문이 적용된 `<meta http-equiv="Content-Security-Policy">` 태그를 적용한다. | 같은 파일 |
| 중첩 Worker 지원 | 확장 호스트 내부에서 요청한 웹 워커 생성을 iframe이 대행한다(`_newWorker`, `_terminateWorker` 메시지 수신). 워커 측 구현체는 `src/vs/workbench/services/extensions/worker/polyfillNestedWorker.ts`의 `NestedWorker`다. | HTML 및 `extensionHostWorker.ts` |
| 교차 출처 격리(COI) | `COI.addSearchParam` 및 COEP 헤더 구성을 위한 `?vscode-coi=2` 쿼리 파라미터를 추가한다. | `webWorkerExtensionHost.ts`, HTML |

VS Code가 각 실행 방식을 선택하는 기준:

- 웹 워커 호스트는 항상 iframe + Worker다. `WebWorkerExtensionHost`에 Worker 직접 경로는 없다.
- 크로스 오리진 iframe 격리는 `platform.isWeb` 환경이면서 `IProductService`에 `webEndpointUrlTemplate`, `commit`, `quality` 설정이 모두 온전히 제공될 때만 동작한다.
- 위 설정이 충족되지 않으면 `IWebWorkerService.getWorkerUrl`을 통한 동일 오리진(same-origin) iframe으로 대체(fallback)되며, 콘솔에 `The web worker extension host is started in a same-origin iframe!` 경고가 출력된다. 상용 도메인 설정이 없는 로컬 개발 환경이나 자체 호스팅 빌드가 이 경로를 탄다.

### 4.4 워커가 확장 코드로부터 제한하는 전역 API

`src/vs/workbench/api/worker/extensionHostWorker.ts`는 확장 스크립트가 실행되기 전에 먼저 로드되어 워커의 전역 스코프를 변조 및 제한한다:

| 전역 객체/함수 | 변경 사항 |
|---|---|
| `self.close` | `console.trace` 스텁 함수로 대체(`'close' has been blocked`). 내부 정상 종료를 위해 원본 함수는 `nativeClose`에 보관 |
| `self.postMessage` | 스텁 함수로 대체. 원본은 `nativePostMessage`에 보관 |
| `self.addEventListener` | 스텁 함수로 대체 |
| `self.importScripts` | 실행 시 `'importScripts' has been blocked` 예외 발생 |
| `AMDLoader`, `NLSLoaderPlugin`, `define`, `require` | `undefined`로 초기화 |
| `webkitRequestFileSystem`, `webkitRequestFileSystemSync`, `webkitResolveLocalFileSystemSyncURL`, `webkitResolveLocalFileSystemURL` | `undefined`로 초기화 |
| `Worker` | 래핑 처리: `file:` URL은 브라우저 URI로 변환, `vscode-remote:`는 차단(`Creating workers from remote extensions is currently not supported.`), 현재 오리진을 유지하기 위해 blob URL 형태로 생성. 브라우저 `Worker`가 없으면 `NestedWorker`로 폴백 |
| `fetch`, `XMLHttpRequest` | 호스트 초기화 후 `patchFetching`이 패치: `file:` 및 `vscode-remote:` URL을 `extHostMain.asBrowserUri`로 자동 변환 |

본 커밋에서 제한하지 않는 항목: 해당 파일은 타입 선언(`namespace self`)에 `indexedDB`와 `caches`를 명시하고 있으나 런타임에서 이를 제거하거나 덮어쓰지 않는다. 따라서 워커 환경에서 실제로 삭제되었다고 가정하고 구현해서는 안 된다.

### 4.5 모듈 로딩: `_loadCommonJSModule`

`src/vs/workbench/api/worker/extHostExtensionService.ts`의 `ExtHostExtensionService._loadCommonJSModule`:

- 진입점 경로에 파일 확장자가 생략된 경우 `.js`를 자동으로 추가한다(`ensureSuffix`).
- 메인 스레드에 RPC(`$asBrowserUri`)를 호출하여 유효한 브라우저 리소스 URL로 변환한다(`resourceUriProvider`는 메인 스레드에만 존재). 이후 `fetch`를 수행해 HTTP 200 응답을 확인한다.
- 원본 코드 하단에 `//# sourceURL=...#vscode-extension` 주석을 추가하고 `new Function('module', 'exports', 'require', fullSource)` 형태로 함수를 생성한 뒤, 로컬 격리된 `module`, `exports`와 `WorkerRequireInterceptor.getModule` 기반의 가상 `require` 함수를 주입하여 실행한다. `require('vscode')` 호출에는 해당 확장에 맞춤 생성된 API 인스턴스를 반환하며, 지원하지 않는 모듈 요청에 `undefined`가 반환되면 `Cannot load module '<request>'` 예외를 발생시킨다.
- `_loadESMModule`은 실행 시 무조건 `ESM modules are not supported in the web worker extension host` 에러를 발생시킨다. 따라서 웹 확장은 반드시 `browser` 진입점이 `activate`를 export하는 단일 파일 번들 형태의 CommonJS 포맷이어야 한다.
- `_beforeAlmostReadyToRunExtensions` 단계에서 확장을 로드하기 전에 `createApiFactoryAndRegisterActors`를 실행하고 가상 require 인터셉터를 초기화한다.

## 5. 양면 API

### 5.1 구성 요소

| 구성 요소 | 파일 | 역할 |
|---|---|---|
| `createApiFactoryAndRegisterActors` | `src/vs/workbench/api/common/extHost.api.impl.ts` | 확장 호스트 프로세스/워커에서 실행된다. 모든 `ExtHost*` 구현체를 `rpcProtocol.set(ExtHostContext.X, impl)`로 등록하고, 특정 확장에 바인딩된 `vscode` API 객체를 생성하는 팩토리 함수 `(extension, extensionInfo, configProvider) => typeof vscode`를 반환한다. |
| `MainContext`, `ExtHostContext` | `src/vs/workbench/api/common/extHost.protocol.ts` | `createProxyIdentifier<Shape>('Name')`의 두 표. `MainContext.X`는 메인 스레드로의 프록시, `ExtHostContext.X`는 호스트로의 프록시다. 각각 `$메서드` 시그니처의 `...Shape` 인터페이스가 있다. |
| `RPCProtocol` | `src/vs/workbench/services/extensions/common/rpcProtocol.ts` | 동일한 `IMessagePassingProtocol` 채널 양단에 각각 하나씩 인스턴스화되는 양방향 RPC 통신 엔진. |
| `extHostNamedCustomer` | `src/vs/workbench/services/extensions/common/extHostCustomers.ts` | 메인 스레드 서비스 클래스를 특정 `MainContext` 식별자에 매핑 등록하는 데코레이터. |

### 5.2 `RPCProtocol`의 동작

- `getProxy(identifier)`는 동적 JavaScript `Proxy` 객체를 반환한다. `_createProxy`는 속성명이 `$` 문자로 시작하는(`CharCode.DollarSign`) 멤버에 최초 접근할 때 비동기 함수를 생성하여 `_remoteCall(rpcId, name, args)`를 호출하도록 연결한다. 즉 Shape 인터페이스에서 `$` 접두사가 붙은 메서드만 원격 호출 대상이다. 단, 이 제한은 보내는 쪽 프록시에만 있다. 받는 쪽 `_doInvokeHandler`는 메서드 이름의 `$` 여부를 검사하지 않고, 액터에 그 이름의 함수가 있으면 호출한다.
- `set(identifier, value)`는 로컬 구현체 인스턴스를 내부 맵인 `_locals[identifier.nid]`에 등록한다.
- 수신 측에서는 `_receiveRequest`가 `_invokeHandler` 및 `_doInvokeHandler`를 거쳐 처리한다: `_locals[rpcId]`에서 구현체를 찾고 전달받은 메서드명을 호출하며, 누락 시 `Unknown actor ...` 또는 `Unknown method ... on actor ...` 에러를 반환한다. 요청의 마지막 인자가 취소 토큰인 경우 수신 측에서 `CancellationTokenSource` 객체로 역직렬화한다.
- 메인 스레드 초기화: `src/vs/workbench/services/extensions/common/extensionHostManager.ts`의 `ExtensionHostManager`가 `new RPCProtocol(protocol, logger)`를 생성하고, `ExtHostCustomersRegistry.getNamedCustomers()`에 등록된 모든 customer 클래스를 인스턴스화하여 `this._rpcProtocol.set(id, instance)`로 등록한다. 이후 `assertRegistered(mainProxyIdentifiers)`를 호출하여 누락된 프록시가 있으면 `Missing proxy instance` 예외를 던진다.
- 호스트 측 초기화: `src/vs/workbench/api/common/extensionHostMain.ts`의 `ExtensionHostMain`이 `new RPCProtocol(protocol, null, uriTransformer)`를 생성하여 동일한 방식으로 바인딩한다.

### 5.3 종단 간 동작 예시: `commands`

확장이 커맨드를 등록하는 과정:

1. 확장에서 `vscode.commands.registerCommand`를 호출하면(`extHost.api.impl.ts`에서 생성된 `commands` 네임스페이스), 내부에서 `extHostCommands.registerCommand(true, id, callback, thisArgs, undefined, extension)`를 호출한다.
2. `src/vs/workbench/api/common/extHostCommands.ts`의 `ExtHostCommands.registerCommand`는 빈 id나 중복(`command '<id>' already exists`)을 검사해 에러를 던지고, 콜백 함수를 내부 `_commands` 맵에 등록한 뒤, `global`이 참이면 `MainContext.MainThreadCommands` 프록시를 통해 `#proxy.$registerCommand(id)`를 호출한다.
3. `src/vs/workbench/api/browser/mainThreadCommands.ts`의 `MainThreadCommands.$registerCommand`(`@extHostNamedCustomer(MainContext.MainThreadCommands)` 데코레이터 적용)가 `CommandsRegistry.registerCommand(id, ...)`에 얇은 포워딩 핸들러를 등록한다. 이 포워딩 핸들러는 실행 시 `this._proxy.$executeContributedCommand(id, ...args)`를 호출하고 결과값을 `revive`하여 반환한다. 이때 프록시 대상은 `ExtHostContext.ExtHostCommands`다.

사용자가 워크벤치 UI(팔레트, 키바인딩, 메뉴 등)에서 커맨드를 실행할 때:
`CommandService.executeCommand`가 `CommandsRegistry`에서 메인 스레드 포워딩 핸들러를 찾아 호출하고, 이 핸들러가 RPC를 통해 확장 호스트의 `$executeContributedCommand`를 호출한다. `ExtHostCommands._executeContributedCommand`가 `metadata.args` 제약 조건을 검증한 뒤 실제 확장 콜백인 `callback.apply(thisArg, args)`를 실행한다.

확장 내부에서 커맨드를 직접 실행할 때(`vscode.commands.executeCommand`):

- `ExtHostCommands._doExecuteCommand`: `_commands.has(id)`면 호스트 안에 머물고 어떤 인자 타입도 통과시키며, 기다리지 않고 `$fireCommandActivationEvent(id)`를 보낸다. 아니면 `Position`, `Range`, `Location`, `NotebookRange`, `ArrayBuffer`, `Uint8Array`를 DTO로 바꾸어 `MainThreadCommands.$executeCommand(id, args, retry)`를 부른다.
- `MainThreadCommands.$executeCommand`는 인자를 `revive`하고, `retry`가 있고 인자가 있으며 `CommandsRegistry.getCommand(id)`가 없으면 `activateByEvent('onCommand:<id>')`를 기다린 뒤 `$executeCommand:retry`를 던진다. 호스트가 `retry`를 거짓으로 한 번 다시 실행한다. 그 밖에는 `ICommandService.executeCommand`를 부른다.

양방향 인터페이스 요약:

| 방향 | 프록시 인터페이스 | 주요 원격 메서드 |
|---|---|---|
| 호스트 -> 메인 스레드 | `MainContext.MainThreadCommands` / `MainThreadCommandsShape` | `$registerCommand`, `$unregisterCommand`, `$fireCommandActivationEvent`, `$executeCommand`, `$getCommands` |
| 메인 스레드 -> 호스트 | `ExtHostContext.ExtHostCommands` / `ExtHostCommandsShape` | `$executeContributedCommand`, `$getContributedCommandMetadata` |

새 API 쌍의 규칙: `extHost.protocol.ts`에 `$` 메서드의 `...Shape`를 추가하고, `MainContext.X` 또는 `ExtHostContext.X` id를 만들고, 받는 쪽 구현을 둔다(메인 스레드는 `@extHostNamedCustomer`, 호스트는 `createApiFactoryAndRegisterActors`의 `rpcProtocol.set`). 그리고 팩토리가 돌려주는 객체에 노출한다.

## 6. 웹 확장 설치

### 6.1 커맨드

- "Install Extension from Location..." 메뉴는 `src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts`의 `workbench.extensions.action.installExtensionFromLocation` 커맨드로 정의된다(카테고리 `Categories.Developer`). 컨텍스트 키 `CONTEXT_HAS_WEB_SERVER` 또는 `CONTEXT_HAS_LOCAL_SERVER`가 참일 때만 `MenuId.CommandPalette`에 노출된다.
- 웹 환경(`isWeb`)에서는 "Location of the web extension" 입력 상자를 띄우는 퀵 픽을 열고, 사용자가 입력한 URL을 바탕으로 `extensionManagementService.installFromLocation(URI.parse(quickPick.value))`를 호출한다. 데스크톱 환경에서는 로컬 디렉터리 선택 대화상자를 띄운다(범위 밖).

### 6.2 서비스 체인

| 단계 | 파일 | 심볼 | 비고 |
|---|---|---|---|
| 설치 경로 분기 | `src/vs/workbench/services/extensionManagement/common/extensionManagementService.ts` | `installFromLocation` | URI 스킴에 따른 라우팅: `file`은 로컬 서버, `vscode-remote`는 원격 서버, 그 외(HTTP/HTTPS 등)는 `webExtensionManagementServer`로 위임한다(서버 미등록 시 `Web extension management server is not found` 에러 발생). 대상 위치로 `userDataProfileService.currentProfile.extensionsResource`를 전달한다. |
| 설치 유효성 검사 | `src/vs/workbench/services/extensionManagement/common/webExtensionManagementService.ts` | `WebExtensionManagementService.install`, `installFromLocation` | `scanExtensionManifest`를 호출해 매니페스트를 먼저 파싱하며, `name`이나 `version` 필드가 누락되어 있으면 `Cannot find a valid extension from the location` 에러로 설치를 거부한다. 검증 통과 시 `installExtensions`를 실행한다. |
| 설치 태스크 실행 | 같은 파일 | `InstallExtensionTask` | 원격 URI 소스인 경우 `webExtensionsScannerService.addExtension`을 호출한다(마켓플레이스 갤러리 소스는 `addExtensionFromGallery` 호출). |
| 매니페스트 저장 | `src/vs/workbench/services/extensionManagement/browser/webExtensionsScannerService.ts` | `WebExtensionsScannerService.addExtension` | `toWebExtension`이 `package.json` 리소스를 인출하고(`getExtensionManifest`가 대상 경로 하위에 `package.json`을 요청하여 `IExtensionResourceLoaderService.readExtensionResource`로 로드), `addToInstalledExtensions`가 설치 목록 파일에 기록한다. |
| 확장 제거 | `webExtensionManagementService.ts` 및 스캐너 | `UninstallExtensionTask`, `removeExtension` | 저장된 확장 목록 파일에서 해당 항목을 필터링하여 제외한다. 웹 확장은 파일을 로컬에 다운로드하여 복사하지 않고 원격 URL에서 직접 참조하므로 `deleteExtension` 파일 삭제 로직은 no-op으로 처리된다. |
| 확장 목록 스캔 | 스캐너 서비스 | `scanUserExtensions(profileLocation)` | 내장 커스텀 확장(워크벤치 옵션의 `additionalBuiltinExtensions`)과 사용자 설치 목록을 병합하며, 동일한 id가 존재하면 사용자가 설치한 확장이 우선한다. 시스템 확장은 `scanSystemExtensions`에서 스캔한다([vscode-web-build.md](vscode-web-build.md)). |

- 설치 목록은 `IStoredWebExtension` JSON 배열이며 `withWebExtensions(file, updateFn)`이 `IFileService`로 읽고 쓴다. 파일별 `Queue`(`getResourceAccessQueue`)가 동시 갱신을 직렬화하고, `location`, `identifier`, `version`이 없는 항목은 무시한다(`Ignoring invalid extension while scanning`). 파일은 `profileLocation`, 곧 프로필의 `extensionsResource`다. 브라우저에서 `IFileService`가 그 파일을 어디에 두는지는 [vscode-state-settings.md](vscode-state-settings.md)에 있다.
- 웹 확장의 설치는 스크립트 본체를 영구 저장하는 것이 아니라 원격 URL과 메타데이터를 등록하는 방식이다. 매니페스트는 설치 목록 항목(`IStoredWebExtension.manifest`)에 함께 저장되므로(없으면 `migrateWebExtensions`가 채운다) 시작할 때 다시 받지 않는다. 확장 코드는 활성화할 때마다 `_loadCommonJSModule`이 그 URL에서 `fetch`하므로, 해당 호스트가 다운되거나 CORS 정책이 바뀌면 확장 코드가 동작하지 않는다.

### 6.3 매니페스트 유효성 검증

- `src/vs/platform/extensions/common/extensionValidator.ts`의 `validateExtensionManifest(productVersion, productDate, extensionLocation, extensionManifest, extensionIsBuiltin)`는 `[Severity, message][]`를 돌려준다. `publisher`가 있는데 문자열이 아니거나(없으면 통과), `name`이나 `version`이 문자열이 아니거나, `engines`가 없거나, `engines.vscode`가 문자열이 아니면 `Error`로 일찍 돌아온다. `isValidExtensionVersion`과 `isEngineValid`로 엔진 범위도 검사한다.
- 호출 지점: `WebExtensionsScannerService.toScannedExtension`(브라우저 환경 스캐너) 및 `src/vs/platform/extensionManagement/common/extensionsScannerService.ts`(데스크톱 환경 스캐너).
- `toScannedExtension`에서 `Severity.Error`가 하나라도 있으면 메시지를 로그하고 `isValid`를 거짓으로 둔다. 확장은 나열되지만 실행되지 않는다. 내장 확장은 이를 거치지 않는다(`BuiltinExtensionsScannerService`에서 `validations: []`, `isValid: true`).
- 주의할 동작 간극: `install` 시점에는 `name`과 `version` 필드만 검증하지만, 이후 확장을 로드하는 스캔 시점에는 `engines.vscode` 유효성을 추가로 강제한다. 따라서 `engines` 필드가 누락된 확장은 설치는 성공하지만 이후 유효하지 않은 확장으로 분류되어 실행되지 못한다.

## 7. 이 워크벤치에 주는 시사점

본 절은 사실 관계 요약이 아닌 writing-room 구현을 위한 설계 제안이다.

- 기여 지점 관리: `setHandler` 등록 및 전체 사용자 목록 기반의 일괄 재실행 메커니즘을 갖춘 경량 `ExtensionPoint` 레지스트리를 구축한다. "전체 등록 해제 후 일괄 재등록" 패턴을 사용하면 확장 추가/제거 시 복잡한 증분 동기화 로직을 생략할 수 있다.
- 메뉴 제약: 확장이 기여할 수 있는 메뉴 영역을 `apiMenus` 형태의 고정 화이트리스트 테이블로 엄격히 제한하고 정의되지 않은 임의의 키는 무시한다. 확장에 의한 임의의 최상위 메뉴 바 확장은 허용하지 않는다.
- 활성화 라이프사이클: 이벤트 기반 활성화 모델을 채택하고, `onCommand:`, `onView:` 등의 암묵적 이벤트 자동 생성기를 연동하며, 동일 이벤트에 대해 중복 실행되지 않도록 캐싱(`_alreadyActivatedEvents`)을 적용한다.
- 실행 호스트 격리: VS Code의 완벽한 샌드박스는 별도 오리진 iframe, Blob 스크립트 부트스트래핑, 포트 핸드셰이크 등 상당한 구현 비용을 요구한다. writing-room이 신뢰된 확장이나 사전 번들된 확장 위주로 구동된다면, 4.4절에서 다룬 전역 객체 제한 스텁을 적용한 표준 Web Worker(모듈 워커)로 시작하는 것이 효율적인 대안이다. 완전한 오리진 분리와 독립 CSP가 필수적인 시점에 iframe 샌드박스를 도입할 수 있다.
- 스크립트 로딩: 웹 워커 호스트와 동일하게 `browser` 진입점만 지원하고, 원격 `fetch` 후 `new Function`을 통한 코드 실행 및 가상 `require('vscode')` 주입 방식을 채택하며, 번들되지 않은 순수 ESM 모듈 로딩은 제한한다.
- API: `$` 접두 프록시 규칙과 두 식별자 표를 가져오면 계약이 파일 하나가 된다.
- 설치 관리: 원격 코드 바이너리를 직접 보관하지 않고 `{ location, identifier, version, manifest }` 메타데이터만 프로필 스토리지에 유지하며, 호환성 검증(`engines` 체크)은 스캔 지연 시점이 아닌 설치 시점에 즉시 수행하여 사용자 혼선을 방지한다.

Decided in: wr-e8v6
