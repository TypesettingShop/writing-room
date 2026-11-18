# VS Code 웹 빌드: 브라우저가 로드하는 것, 서빙, 빌드, 내장 확장

이 문서는 고정 커밋(`41004e061e582855eb1e99b6a6e5d52994f661be`, 개요는 [README.md](README.md))을 바탕으로 웹 워크벤치가 (1) 브라우저에서 어떤 순서로 부팅하는지, (2) 웹 클라이언트를 어떻게 서빙하는지, (3) 어떤 단계로 빌드되는지, (4) 내장 확장이 웹 빌드에 어떻게 포함되는지 정리한다. 마지막에는 Vite 빌드가 이 단계들 중 무엇을 대체할 수 있는지 분석한다. 모든 경로는 VS Code 저장소 기준이다. writing-room의 대응 경로는 `src/vs/<path>` -> `src/<path>`이며 [architecture.md](architecture.md)에 기술되어 있다.

범위 제외(이름만 표기): 채팅, 세션(`vs/sessions/...` 진입점), 노트북, 터미널, 디버그, 설정 에디터 UI, 원격(`remoteAuthority`), 데스크톱 빌드. 본 문서는 해당 진입점이 빌드 스크립트 목록에 나타나더라도 설명하지 않는다.

## 1. 한눈에 보는 부팅 순서

| 단계 | 주체 | 심볼 / 파일 | 하는 일 |
| --- | --- | --- | --- |
| 1 | 서버 | `src/vs/server/node/webClientServer.ts`의 `WebClientServer._handleRoot` | HTML 템플릿을 읽어 `{{...}}` 플레이스홀더를 치환한 뒤 응답한다 |
| 2 | 브라우저 | `src/vs/code/browser/workbench/workbench.html` | 설정을 `<meta>` 태그에 주입하고, NLS 모듈과 `workbench.js`를 `type="module"`로 로드한다 |
| 3 | 브라우저 | `src/vs/code/browser/workbench/workbench.ts` 끝부분의 즉시 실행 함수 | `<meta id="vscode-workbench-web-configuration">`의 JSON을 파싱하고 `create(...)`를 호출한다 |
| 4 | 워크벤치 | `src/vs/workbench/browser/web.factory.ts`의 `create` | 임베더 커맨드를 등록하고 `new BrowserMain(domElement, options).open()`을 호출한다 |
| 5 | 워크벤치 | `src/vs/workbench/browser/web.main.ts`의 `BrowserMain.open` | `initServices`와 `domContentLoaded`를 병렬로 대기한 뒤 `createWorkbench` -> `workbench.startup()` 실행 |
| 6 | 워크벤치 | `src/vs/workbench/browser/workbench.ts`의 `Workbench.startup` | 파트 렌더링 및 레이아웃 배치 수행(세부 내용은 [vscode-workbench-layout.md](vscode-workbench-layout.md) 참조) |

## 2. 브라우저가 처음 로드하는 것

### 2.1 `workbench.html`

파일: `src/vs/code/browser/workbench/workbench.html`. 로컬 개발 환경용 파일은 동일 디렉터리의 `workbench-dev.html`이다.

| 요소 | 내용 | 결정하는 것 |
| --- | --- | --- |
| `<meta id="vscode-workbench-web-configuration" data-settings="{{WORKBENCH_WEB_CONFIGURATION}}">` | 서버가 생성한 JSON 설정 문자열 | `workbench.ts`가 읽어들이는 `IWorkbenchConstructionOptions`의 출처 |
| `<meta id="vscode-workbench-web-base-url" ...>` | 정적 리소스 루트 경로(`WORKBENCH_WEB_BASE_URL`) | 인라인 스크립트가 `globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/'`를 설정한다. 이후 모든 리소스 로딩(`FileAccess`)의 기준점이 된다 |
| `<meta id="vscode-workbench-auth-session" ...>` | 개발용 인증 세션 정보 | 배포용 빌드에서는 비어 있다 |
| `<link rel="stylesheet" href=".../out/vs/code/browser/workbench/workbench.css">` | 번들링된 CSS 스타일시트 | 프로덕션 빌드는 CSS를 링크 태그로 로드한다 |
| `<script type="module" src="{{WORKBENCH_NLS_FALLBACK_URL}}">` | 항상 기본 영어 메시지 번들 로드(`out/nls.messages.js`) | NLS 폴백 언어 리소스 |
| `<script type="module" src="{{WORKBENCH_NLS_URL}}">` | 영어가 아닐 때만 동적으로 채워짐 | 요청 로케일 메시지 번들 로드 시도 |
| `<script type="module" src=".../out/vs/code/browser/workbench/workbench.js">` | 핵심 진입 모듈 | 스크립트 로드 순서는 소스 코드 내 "do not modify order of script tags" 주석에 따라 엄격히 고정된다 |
| `#vscode-startup-fallback` | 10초 경과 후 표시되는 "The editor failed to load" 경고 UI | `workbench.ts`의 즉시 실행 함수가 스크립트 첫 머리에서 이 DOM 요소를 제거한다 |
| `performance.mark('code/didStartRenderer')`, `code/willLoadWorkbenchMain` | 성능 측정 마크 | 브라우저 부팅 구간별 성능 프로파일링 측정 |

### 2.2 `workbench-dev.html`과 `workbench.html`의 차이

- `workbench-dev.html`에는 `vscode-workbench-builtin-extensions`와 `vscode-workbench-css-modules`라는 두 개의 `<meta>` 태그가 추가로 정의되어 있다.
- 개발 환경에서는 CSS를 `<link>` 대신 import map 방식으로 로드한다. `globalThis._VSCODE_CSS_LOAD`가 내부적으로 `sheet.insertRule('@import url(...)')`를 호출하며, `WORKBENCH_DEV_CSS_MODULES` 목록을 바탕으로 브라우저 import map을 구성한다. 서버가 CSS 모듈 목록을 별도로 내려주는 이유다(`webClientServer.ts`의 `_cssDevService`).
- 서버는 `this._environmentService.isBuilt` 값이 참이면 `workbench.html`을, 거짓이면 `workbench-dev.html`을 선택해 응답한다.

### 2.3 `workbench.ts` (브라우저 셸)

파일: `src/vs/code/browser/workbench/workbench.ts`. 이 파일은 워크벤치 코어 본체가 아니라 호스트 애플리케이션의 셸(shell) 역할을 수행한다.

| 심볼 | 하는 일 |
| --- | --- |
| 파일 하단의 즉시 실행 함수 | 폴백 DOM 요소를 제거하고, `<meta>` 태그의 JSON 설정을 파싱하며, 비밀 저장소 암호화 방식을 선택한 뒤 `create(mainWindow.document.body, {...})`를 호출한다 |
| `WorkspaceProvider`(`WorkspaceProvider.create`) | `IWorkspaceProvider` 구현체. URL의 `folder`/`workspace` 쿼리 파라미터와 서버가 제공한 `folderUri`/`workspaceUri`를 열 작업공간으로 해석하며, `open`을 통해 페이지 이동 및 새 창 열기를 처리한다 |
| `LocalStorageSecretStorageProvider`, `ServerKeyedAESCrypto`, `TransparentCrypto` | `ISecretStorageProvider` 및 암호화 구현체. 쿠키 `vscode-secret-key-path`가 존재하고 `ServerKeyedAESCrypto.supported()`가 참이면 서버 키 기반 AES 암호화를 적용하며, 그렇지 않으면 평문 저장 방식인 `TransparentCrypto`를 사용한다 |
| `LocalStorageURLCallbackProvider` | `IURLCallbackProvider` 구현체. `config.callbackRoute`(서버 측 `/callback`) 경로를 통해 OAuth 인증 등의 콜백 요청을 수신한다 |
| `windowIndicator` 기본값 | `config.windowIndicator ?? { label: '$(remote)', tooltip: ... Web }`로 기본 표시기를 구성한다 |

- 이 파일이 임포트하는 `create` 함수는 `src/vs/workbench/workbench.web.main.internal.ts`에서 가져온다(2.5절 참조).
- writing-room 설계 시사점: 애플리케이션 진입점(`main.ts`)이 DOM 메타 태그나 정적 설정에서 옵션을 읽어 `create`를 호출하는 방식은 직관적이고 재사용하기 쉬운 얇은 진입 계층이다. 백엔드 서버가 없는 완전 정적 환경이라면 설정 JSON을 빌드 시점의 정적 상수로 주입하면 된다.

### 2.4 `web.factory.ts`의 `create`와 `web.main.ts`의 `BrowserMain`

`src/vs/workbench/browser/web.factory.ts`:

| 항목 | 내용 |
| --- | --- |
| `create(domElement, options)` | 모듈 전역 변수 `created`를 검사하여 중복 호출을 방지한다("Unable to create the VSCode workbench more than once."). |
| `options.commands` | 각 항목을 `CommandsRegistry.registerCommand`로 등록하고, `label`이 있으면 `MenuRegistry.appendMenuItem`으로 `MenuId.CommandPalette`(또는 `Menu` 열거형이 가리키는 메뉴, `asMenuId`)에 추가한다 |
| 반환값 | `toDisposable` — 워크벤치 초기화가 완료되기 전 취소되면 `workbenchPromise` 완료를 기다린 뒤 안전하게 `shutdown()`을 호출한다. |
| 네임스페이스 `commands`, `logger`, `env`, `window`, `workspace` | `create` 뒤에 임베더가 쓰는 API 면(`executeCommand`, `openUri`, `withProgress` 등) |

`src/vs/workbench/browser/web.main.ts`:

| 심볼 | 하는 일 |
| --- | --- |
| `BrowserMain.open` | `Promise.all([this.initServices(), domContentLoaded(...)])` 완료 대기 -> `createWorkbench` -> `registerListeners` -> `workbench.startup()` -> `BrowserWindow` 생성 -> `IWorkbench` 인터페이스 반환 |
| `BrowserMain.initServices` | 비동기 초기화가 필수적인 핵심 서비스 컬렉션을 수동 생성: 제품 서비스(`IProductService`), 환경 서비스(`BrowserWorkbenchEnvironmentService`), 파일 서비스(`FileService`), 로깅, 사용자 프로필, 원격 에이전트 등 |
| `BrowserMain.registerIndexedDBFileSystemProviders` | IndexedDB `vscode-web-db`(버전 3)에 `vscode-userdata-store`, `vscode-logs-store`, `vscode-filehandles-store` 오브젝트 스토어를 생성한다. 사용자 데이터 스킴(`Schemas.vscodeUserData`)에는 `IndexedDBFileSystemProvider`를, 로그 스킴에는 동일 DB의 로그 스토어를 연결하며, IndexedDB를 사용할 수 없는 경우 `InMemoryFileSystemProvider`로 대체한다. 브라우저가 File System Access API를 지원하면(`WebFileSystemAccess.supported`) `Schemas.file` 스킴에 `HTMLFileSystemProvider`를 바인딩한다. `Schemas.tmp`는 인메모리로 처리한다. |
| `createWorkspaceAndDependentServices` | `BrowserStorageService`, 설정 서비스(`WorkspaceService`), 비밀 저장소 등 작업공간 컨텍스트에 종속된 서비스를 생성한다(세부 내용은 [vscode-state-settings.md](vscode-state-settings.md) 참조). |

`initServices`의 설계 원칙: 일반 서비스는 여기서 직접 등록하지 않는다. 공통 서비스는 `workbench.common.main.ts`에서, 웹 전용 서비스는 `workbench.web.main.ts`에서 `registerSingleton()`을 통해 선언적으로 등록한다. `BrowserMain.initServices`는 비동기 부트스트래핑이 반드시 선행되어야 하는 기반 서비스(파일 시스템, 환경, 스토리지 등)만을 집중 관리한다.

### 2.5 임포트 구조: `workbench.common.main.ts`, `workbench.web.main.ts`, `workbench.web.main.internal.ts`

| 파일 | 역할 |
| --- | --- |
| `src/vs/workbench/workbench.common.main.ts` | 웹과 데스크톱 공통 모듈. 모듈 로드 시의 사이드 이펙트(side-effect import)를 통해 파트(`browser/parts/editor/editor.contribution.js`, `browser/parts/statusbar/statusbarPart.js`, `browser/parts/titlebar/menubar.contribution.js`), 액션(`browser/actions/layoutActions.js`), 기여 지점(`services/actions/common/menusExtensionPoint.js`, `api/browser/viewsExtensionPoint.js`), 코어 서비스(`services/editor/browser/editorService.js`, `services/keybinding/browser/keybindingService.js` 등)를 레지스트리에 자동 등록한다. |
| `src/vs/workbench/workbench.web.main.ts` | `./workbench.common.main.js`를 먼저 임포트한 뒤 웹 환경 전용 구현체를 순차 임포트한다: `./browser/web.main.js`, 브라우저 제목 표시줄 구현체 `BrowserTitleService`(`./browser/parts/titlebar/titlebarPart.js`), 웹 확장 호스트(`src/vs/workbench/services/extensions/browser/extensionService.ts`), 웹 확장 스캐너(`services/extensionManagement/browser/webExtensionsScannerService.js`), 웹 텍스트 파일 서비스(`services/textfile/browser/browserTextFileService.js`), 라이프사이클(`services/lifecycle/browser/lifecycleService.js`), 호스트 연동(`services/host/browser/browserHostService.js`), 작업 사본 백업(`services/workingCopy/browser/workingCopyBackupService.js`) 등. |
| `src/vs/workbench/workbench.web.main.internal.ts` | `./workbench.web.main.js`를 임포트하고 외부 임베더를 위한 공개 심볼들을 re-export한다: `create`(`web.factory.js`), `URI`, `Event`, `Emitter`, `Disposable`, `GroupOrientation`, `LogLevel`, `commands`, `env`, `window`, `workspace`, `logger`, `Menu`. |

핵심 설계 사실:

- 서비스 등록은 모듈 import 시 발생하는 부수 효과에 의존한다(`registerSingleton`, `MenuRegistry`, `Registry.as(...)`). 따라서 최상위 임포트 목록이 최종 번들에 포함될 기능 범위를 직접 결정하며, 임포트를 제거하면 해당 기능 자체가 빌드에서 완전히 누락된다.
- VS Code의 최상위 임포트 목록에는 writing-room의 범위를 벗어나는 수많은 기능(터미널, 디버그, 채팅, 원격 접속 등)이 결합되어 있다. writing-room에서는 이를 모방하지 않고 필요한 항목만 선별한다.
- writing-room 시사점: v0.1.0에서는 `workbench.common.main`에 해당하는 단일 엔트리 파일에 여섯 파트와 커맨드, 메뉴, 키바인딩, 확장 호스트만을 명시적으로 임포트하는 "경량 진입점"을 구성하면 충분하다. 데스크톱 빌드를 고려하지 않는다면 `common`과 `web`으로 엔트리를 분리할 필요가 없다.

## 3. 어떻게 서빙되는가

### 3.1 개발 서버: `scripts/code-web.js`

| 항목 | 내용 |
| --- | --- |
| 동작 방식 | 자체 웹 서버를 직접 구동하지 않는다. `require.resolve('@vscode/test-web')`로 패키지 경로를 찾은 뒤, `child_process.spawn(process.execPath, [testWebLocation, ...args])`(`startServer` 함수)를 호출해 별도 자식 프로세스로 서버를 실행한다. |
| 전달 인자 | `--host`(기본값 `localhost`), `--port`(기본값 `8080`), `--sourcesPath`(저장소 루트 `APP_ROOT`), `--browserType none`(`--browser`/`--browserType` 옵션이 없을 때 지정하며, `open` 명령어로 시스템 기본 브라우저를 실행한다). 기타 인자는 그대로 포워딩된다. |
| `--playground` | `vscode-web-playground` 확장을 `.build/builtInWebDevExtensions` 아래로 다운로드하여(`ensureWebDevExtensions`) `--extensionPath`로 전달하고 `--folder-uri memfs:///sample-folder`를 지정한다. |
| 첫 번째 인자 `folderMountPath` | 로컬 디렉터리를 작업공간으로 마운트하여 연다. |
| 의존성 | `package.json`의 devDependency인 `@vscode/test-web`. |

- `package.json`의 `web` 스크립트는 본 스크립트가 `./scripts/code-server` 또는 `./scripts/code-web`으로 대체되었다는 안내만 출력한다(직접 서버를 실행하지 않음).
- 서버 측 상세 코드(`@vscode/test-web` 내부)는 본 저장소 외부에 별도 관리된다. 본 문서는 `code-web.js`가 전달하는 인자 인터페이스까지만 확인하였다. `@vscode/test-web`이 정확히 어떤 HTML 구조를 렌더링하는지는 확인되지 않았으므로 서술하지 않는다.

### 3.2 `WebClientServer`

파일: `src/vs/server/node/webClientServer.ts`. `scripts/code-server.js`가 기동하는 서버(진입점 `out/server-main.js`)가 웹 번들이 포함되어 있을 때 사용하는 클래스다. 클래스 주석: "This method is only invoked when the server has web bits", 연결 토큰 검증이 완료된 이후에만 진입한다.

`WebClientServer.handle`의 HTTP 라우팅 테이블:

| 상수 | 경로 | 핸들러 | 하는 일 |
| --- | --- | --- | --- |
| `STATIC_PATH` | `/static/...` | `_handleStatic` | `APP_ROOT` 하위 정적 파일을 `serveFile`로 서빙. `isEqualOrParent`로 루트 디렉터리를 벗어난 접근은 HTTP 400 처리. 프로덕션 빌드는 `CacheControl.NO_EXPIRY`, 개발 환경은 `CacheControl.ETAG` 적용 |
| `STATIC_PATH` + `MANIFEST_PATH` | `/static/resources/server/manifest.json` | `_handleManifest` | PWA 웹 매니페스트 서빙 |
| (루트) | `/` | `_handleRoot` | 워크벤치 메인 HTML 렌더링 |
| `CALLBACK_PATH` | `/callback` | `_handleCallback` | OAuth 인증 콜백 응답 페이지 |
| `WEB_EXTENSION_PATH` | `/web-extension-resource/...` | `_handleWebExtensionResource` | 마켓플레이스 확장 리소스 프록시(`extensionsGallery.resourceUrlTemplate`을 이 경로로 재작성) |
| 기타 경로 | | | `serveError(..., 404, 'Not found.')` 반환 |

`_handleRoot`의 템플릿 처리 로직:

| 파라미터 / 분기 | 처리 결과 |
| --- | --- |
| `this._environmentService.isBuilt` | `workbench.html` 또는 `workbench-dev.html` 파일 선택(`FileAccess.asFileUri`) |
| `workbenchWebConfiguration` 객체 | `remoteAuthority`, `serverBasePath`, `_wrapWebWorkerExtHostInIframe`, `developmentOptions`, `enableWorkspaceTrust`, `folderUri`, `workspaceUri`, `productConfiguration`, `callbackRoute` 등의 설정을 JSON으로 직렬화하여 `WORKBENCH_WEB_CONFIGURATION`에 삽입 |
| `_wrapWebWorkerExtHostInIframe` | 기본값은 `undefined`(기본 iframe 격리 유지), 스모크 테스트 드라이버 활성화(`enable-smoke-test-driver`) 시에만 `false` 설정. 이 플래그가 클라이언트 측 `webWorkerExtensionHost.ts`로 전달된다([vscode-extensions.md](vscode-extensions.md)) |
| 로케일 | 쿠키 `vscode.nls.locale` 또는 `accept-language`. 영어가 아니고 `nlsCoreBaseUrl`이 있으면 `createNlsUrl`로 `WORKBENCH_NLS_URL`을 채우고, 아니면 빈 문자열(폴백만 사용) |
| `renderWorkbenchTemplate(template, values)` | HTML 내 `{{KEY}}` 토큰 치환: `WORKBENCH_WEB_CONFIGURATION`, `WORKBENCH_AUTH_SESSION`, `WORKBENCH_WEB_BASE_URL`, `WORKBENCH_NLS_URL`, `WORKBENCH_NLS_FALLBACK_URL`, `WORKBENCH_SCRIPT_NONCE`, 개발 시 `WORKBENCH_DEV_CSS_MODULES`, 테스트 리졸버 사용 시 `WORKBENCH_BUILTIN_EXTENSIONS` |
| `createWorkbenchContentSecurityPolicy` | 요청마다 고유 스크립트 nonce를 포함하는 응답 헤더 `Content-Security-Policy` 생성 |
| 세션 연결 토큰 | 토큰이 확인되면 쿠키(`connectionTokenCookieName`)의 유효기간(`maxAge`)을 1주일로 연장 갱신 |

- `WORKBENCH_WEB_BASE_URL`은 `posix.join(basePath, this._productPath, STATIC_PATH)`로 계산된다. 정적 루트가 `/static`이므로 HTML 내의 `{{WORKBENCH_WEB_BASE_URL}}/out/...` 경로는 런타임에 `/static/out/...`로 치환된다.
- writing-room 시사점: 동적 템플릿 치환과 요청별 CSP nonce는 서버 프로세스가 상주할 때 유효하다. Vite 기반 정적 호스팅에서는 `index.html`이 정적 빌드 시점에 설정 JSON, 정적 애셋 경로, NLS 설정을 상수로 주입한다. 보안 헤더는 호스팅 인프라의 응답 헤더나 `<meta http-equiv>` 태그로 처리한다.

## 4. 어떻게 빌드되는가

### 4.1 빌드 대상과 진입점

`build/lib/esbuild.ts`에 정의된 `BuildTarget` 열거형은 `'desktop' | 'server' | 'server-web' | 'web' | 'mobile'`이다. `runEsbuildBundle(outDir, minify, nls, target, sourceMapBaseUrl)`은 `build/next/index.ts bundle ...`을 자식 프로세스로 호출하는 래퍼 함수다. 실제 esbuild 세부 설정은 `build/next/index.ts`의 `bundle`, `bundleToOutput`, `getEntryPointsForTarget`, `getCssBundleEntryPointsForTarget`에 정의되어 있다.

| 빌드 대상 | 진입점(`getEntryPointsForTarget`) | 비고 |
| --- | --- | --- |
| `web` | `workerEntryPoints` + `webOnlyEntryPoints` + `vs/workbench/workbench.web.main.internal` + `keyboardMapEntryPoints` | 브라우저 셸(`workbench.ts`) 미포함. CDN에 배포되어 외부 임베더가 `create` API로 호출하는 라이브러리 형태 |
| `server-web` | `serverEntryPoints` + `workerEntryPoints` + `vs/code/browser/workbench/workbench` + `keyboardMapEntryPoints` | 브라우저 셸 포함. `WebClientServer`가 웹 IDE로 서빙하는 엔드포인트 |

- `workerEntryPoints`(웹 워커 번들로 별도 청크 분리): `vs/editor/common/services/editorWebWorkerMain`, `vs/workbench/api/worker/extensionHostWorkerMain`(확장 호스트 워커), `vs/workbench/services/search/worker/localFileSearchMain`, `vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain` 등. (노트북 등 범위 밖 워커도 포함)
- `keyboardMapEntryPoints`: `vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux|darwin|win` 세 개.
- 즉, 결과물은 단일 JS 파일이 아니라 메인 번들, 확장 호스트 워커, 에디터 워커, 텍스트메이트 토큰화 워커, 키보드 레이아웃 청크가 독립된 엔트리로 분리되어 번들된다.

### 4.2 Gulp 빌드 파이프라인 (`build/gulpfile.vscode.web.ts`)

| 태스크명 | 구성 단계 | 세부 작업 내용 |
| --- | --- | --- |
| `vscode-web`, `vscode-web-min` | `compileApiProposalNamesTask` -> `writeISODate('out-build')` -> CI 태스크 | 제안 API 명칭 파일 생성, 빌드 일자 기록 |
| `vscode-web-ci`, `vscode-web-min-ci` | `copyCodiconsTask` -> `compileWebExtensionsBuildTask` -> `esbuild-vscode-web`(또는 `-min`) -> 대상 디렉터리 `rimraf` -> `packageTask` | Codicon 폰트 복사, 내장 확장 번들링, esbuild 번들 실행, 최종 패키징 |
| `esbuild-vscode-web` | `runEsbuildBundle('out-vscode-web', false, true, 'web')` | 개발용 번들 생성(NLS 플러그인 활성화) |
| `esbuild-vscode-web-min` | `runEsbuildBundle('out-vscode-web-min', true, true, 'web', ...)` | 코드 난독화/최소화, 소스맵 기준 URL로 `sourceMappingURLBase`(`main.vscode-cdn.net/sourcemaps/<commit>`) 지정 |
| `compile-web-extensions-build` | `clean-web-extensions-build` -> `bundle-web-extensions-build` -> `bundle-marketplace-web-extensions-build` -> `bundle-web-extension-media-build` | 내장 확장 산출물 디렉터리(`.build/web/extensions`) 생성 |
| `packageTask(source, dest)` | `out-vscode-web*`를 `out`으로 이름을 바꿔 복사 + `.build/web/extensions` + `remote/web/package.json`(이름/버전/`type: 'module'` 주입) + 프로덕션 의존성(`getFlatProductionDependencies`) + `favicon.ico`, `manifest.json`, PWA 아이콘 | 결과는 `vscode-web` 폴더. `*.map`은 제외한다 |

- 본 커밋의 웹 번들러 엔진은 esbuild다(`build/next/index.ts`). 과거 문서의 Webpack이나 AMD `loader.js` 기반 설명은 현 커밋과 일치하지 않는다. 최종 빌드 결과물은 표준 ESM 포맷(`<script type="module">`)으로 출력된다.
- NLS: 서버는 `WORKBENCH_NLS_FALLBACK_URL`을 `<정적 루트>/out/nls.messages.js`로 지정하고 HTML이 이를 로드한다. `build/next/nls-plugin.ts`가 `nls.messages.js` 및 `nls.messages.json`을 생성한다. 번들러의 `--nls` 플래그가 이 플러그인을 활성화하는 것으로 보이나 구체적인 연결 지점은 7절에 기술된 대로 추가 검증이 필요하다.

### 4.3 `package.json`의 `compile-web`, `watch-web`: 워크벤치 번들이 아님에 유의

| npm 스크립트 | 실행 명령어 | 실제 실행 작업 |
| --- | --- | --- |
| `compile-web` | `pnpm run gulp compile-web` | `build/gulpfile.extensions.ts`의 `compileWebExtensionsTask` -> `buildWebExtensions(false)` 실행 |
| `watch-web` | `pnpm run gulp watch-web` | 동일 파일의 `watchWebExtensionsTask` -> `buildWebExtensions(true)` 실행 |
| `watch-webd` | `deemon pnpm run watch-web` | `watch-web`을 백그라운드 데몬으로 실행 |

- `buildWebExtensions`는 `extensions` 디렉터리 하위의 모든 `esbuild.browser.mts`를 탐색해 `ext.esbuildExtensions(...)`로 번들하고 `ext.typeCheckExtension`으로 타입을 검사한다. 즉, 내장 확장들을 웹용으로 번들하는 작업이며 워크벤치 코어 자체의 번들이 아니다.
- 워크벤치 소스는 개발 중 `watch-client-transpile`/`watch-client`(스크립트 `watch`가 묶는다)로 변환되고, `code-web.js`가 `--sourcesPath`로 저장소 루트를 서버에 알려 준다. 워크벤치의 웹 프로덕션 번들은 위 4.2의 `vscode-web*` 태스크가 만든다.
- 요약: 웹 빌드의 "로컬 개발 감시 루프"와 "최종 프로덕션 배포 번들링"은 완전히 분리된 별개의 빌드 파이프라인이다.

### 4.4 템플릿 마커 인라인 치환

`build/next/index.ts`의 `fileContentMapperPlugin(outDir, target)`은 esbuild 플러그인으로, 소스 코드를 읽는 과정에서 특정 주석 마커를 인라인 데이터로 치환한다.

| 소스 코드 마커 | 치환되는 내용 |
| --- | --- |
| `/*BUILD->INSERT_PRODUCT_CONFIGURATION*/` | `product.json`에 `version`, `commit`, `date`를 병합한 JSON 객체 인라인 삽입 |
| `/*BUILD->INSERT_BUILTIN_EXTENSIONS*/` | `scanBuiltinExtensions(extensionsRoot)` 스캔 결과 배열 인라인 삽입. 루트 경로는 `web` 빌드면 `.build/web/extensions`, `server-web`이면 `.build/extensions`, `mobile`이면 `<mobileDirectory>/extensions` |

- `productService.commit`이 채워지면 `isBuilt`가 참이 된다(`src/vs/workbench/services/environment/browser/environmentService.ts`의 `isBuilt`). 즉 제품 설정 인라인이 "빌드판" 판정 자체를 결정한다.

## 5. 내장 확장이 웹 빌드에 도달하는 방식

파일: `src/vs/workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts`의 `BuiltinExtensionsScannerService`(`IBuiltinExtensionsScannerService` 구현체, `registerSingleton(..., InstantiationType.Delayed)`).

| 환경 | 확장 메타데이터 목록 출처 | 확장 정적 리소스 URL 경로 |
| --- | --- | --- |
| 프로덕션 빌드(`environmentService.isBuilt`) | 생성자 내 `bundledExtensions = [/*BUILD->INSERT_BUILTIN_EXTENSIONS*/]` — 4.4절의 빌드 플러그인이 인라인 주입한 배열 | `FileAccess.asBrowserUri(builtinExtensionsPath)` 하위의 `extensionPath`(`builtinExtensionsPath`는 `src/vs/base/common/network.ts`에 `'vs/../../extensions'`로 정의) |
| 개발판 | HTML의 `<meta id="vscode-workbench-builtin-extensions" data-settings=...>`를 `JSON.parse`. 이 `<meta>`는 `workbench-dev.html`에만 있고, 서버가 `useTestResolver`일 때 `vscode-test-resolver`, `github-authentication` 두 확장만 채운다 | 같음 |

초기화 처리 과정:

1. 각 번들 항목(`IBundledExtension`: `extensionPath`, `packageJSON`, `packageNLS?`, `readmePath?`, `changelogPath?`)을 `IExtension` 모델로 변환한다.
2. 속성을 `type: ExtensionType.System`, `isBuiltin: true`, `targetPlatform: TargetPlatform.WEB`, `isValid: true`로 고정한다.
3. `packageNLS`가 있으면 `localizeManifest`로 매니페스트를 번역한다. 영어가 아니고 `extensionsGallery.nlsBaseUrl`, `productService.commit`이 있으면 `<nlsBaseUrl>/<commit>/<version>/<language>/<extensionId>/package`에서 번역을 읽고, 실패하면 `logService.error` 후 번들된 번역으로 대체한다.
4. `scanBuiltinExtensions()`가 모든 확장의 비동기 처리를 모아 프로미스 배열로 반환한다.

- 본 서비스는 `isWeb`이 참일 때만 내장 확장 목록을 수집한다.
- 내장 확장의 실제 스크립트 코드는 번들 JSON에 포함되지 않고 `extensionPath` URL을 통해 비동기 fetch로 로드된다. 웹 워커 확장 호스트의 스크립트 로드 방식은 [vscode-extensions.md](vscode-extensions.md)를 참조한다.
- 사용자가 동적으로 설치한 확장(`WebExtensionsScannerService`)은 이와 별개의 서비스로 분리되어 관리된다.

내장 확장 빌드 파이프라인(4.2절의 `compile-web-extensions-build`):

| 하위 태스크 | 호출 함수 | 작업 내용 |
| --- | --- | --- |
| `bundle-web-extensions-build` | `build/lib/extensions.ts`의 `packageAllLocalExtensionsStream(true)` | 로컬 확장을 웹용으로 패키징(`forWeb` 참). 확장에 `esbuild.browser.mts`가 있으면 그것을 사용한다 |
| `bundle-marketplace-web-extensions-build` | `packageMarketplaceExtensionsStream(true)` | 마켓플레이스로부터 웹용 내장 확장을 다운로드 및 패키징 |
| 산출물 디렉터리 | `.build/web/extensions` | `fileContentMapperPlugin`이 이 디렉터리를 스캔하여 4.4절의 인라인 목록을 생성 |

## 6. 이것이 Vite 빌드에 의미하는 바

writing-room은 프레임워크 없는 TypeScript와 Vite를 기반으로 빌드된다. VS Code의 웹 빌드 단계와 Vite의 대응 관계는 다음과 같다:

| VS Code 빌드 단계 | 심볼 / 소스 파일 | Vite 환경에서의 대응 방식 |
| --- | --- | --- |
| 진입점 선언 | `build/next/index.ts`의 `getEntryPointsForTarget` | `index.html` 내 `<script type="module">` 선언 및 `build.rollupOptions.input` 옵션으로 대체 |
| 번들링, 코드 최소화, 소스맵 | `runEsbuildBundle`, `bundle` | Vite 빌드 파이프라인이 자동 처리(개발 환경은 esbuild 의존성 사전 번들링 + 네이티브 ESM HMR 사용) |
| HTML 템플릿 치환 | `webClientServer.ts`의 `renderWorkbenchTemplate` | 대체: Vite `index.html` 변환(`transformIndexHtml`)이나 `define`/`import.meta.env`로 빌드 시점 값 주입. 서버가 없으면 요청별 nonce는 불가능 |
| 제품 설정, 내장 확장 목록 인라인 | `fileContentMapperPlugin`의 두 마커 | 대체: `define`이나 `import.meta.glob`/가상 모듈 플러그인으로 인라인 |
| 워커 번들 | `workerEntryPoints` | `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`를 Vite가 별도 청크로 번들한다. 확장 호스트 워커도 이 방식 |
| CSS | `getCssBundleEntryPointsForTarget`, 개발판 import map(`_VSCODE_CSS_LOAD`) | Vite가 CSS 임포트를 처리. 개발용 import map 우회는 필요 없다 |
| NLS(다국어화) 파이프라인 | `--nls`, `nls.messages.js`, `WORKBENCH_NLS_URL` | v0.1.0 범위 밖이므로 단일 언어(기본 문자열)로 단순화 |
| 정적 서빙, 캐시 | `_handleStatic`의 `CacheControl` | 호스팅/`vite preview`가 대신한다. 해시된 파일명이 `NO_EXPIRY` 역할 |
| 최종 정적 배포 패키징 | `packageTask` | `public/` 정적 자산과 `dist/` 빌드 결과물 디렉터리로 구성 |
| 내장 확장 번들 | `compile-web-extensions-build`, `packageAllLocalExtensionsStream` | 대체하지 않는다. 확장은 워크벤치 번들과 따로 만들어 매니페스트와 함께 정적 파일로 두는 구조를 따로 설계해야 한다 |
| 로케일 협상, 동적 CSP, 연결 토큰 | `_handleRoot`, `createWorkbenchContentSecurityPolicy` | Node 서버 전용 기능이므로 순수 정적 SPA 빌드 환경에는 직접적인 대응 요소가 없음 |
| OAuth 콜백, 갤러리 프록시 | `_handleCallback`, `_handleWebExtensionResource` | 범위 밖 |

설계 권고사항:

- `create(domElement, options)`와 같은 "단일 실행 팩토리 + 경량 부트 셸" 아키텍처는 Vite 환경에서도 동일하게 유효한 구조다.
- 임포트 부수 효과를 통한 서비스 등록 패턴은 번들러의 트리 셰이킹(tree-shaking) 과정에서 제거될 위험이 있으므로, 등록 모듈은 `package.json`의 `sideEffects` 필드에 명시하거나 최상위 엔트리에서 직접 임포트하여 보존해야 한다.
- 워크벤치 데이터 저장은 IndexedDB(`vscode-web-db`)를 기반으로 한다. 본 사실은 2.4절에 기술되어 있으며 세부 아키텍처는 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다. v0.1.0의 스토리지 구현 결정 시 본 문서의 `registerIndexedDBFileSystemProviders` 구조를 근거로 삼는다.

## 7. 확인하지 못해 서술하지 않은 것

- `@vscode/test-web` 내부 패키지의 자체 서빙 구현 방식.
- `vs/sessions/*` 및 모바일(`mobile`) 빌드 타깃(범위 밖).
- `build/next/index.ts`의 `--nls` 플래그가 `build/next/nls-plugin.ts`를 호출하는 내부 연결 지점.

Decided in: wr-e8v6
