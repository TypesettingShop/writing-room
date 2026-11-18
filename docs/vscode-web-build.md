# VS Code 웹 빌드: 브라우저가 로드하는 것, 서빙, 빌드, 내장 확장

이 페이지는 고정 커밋(`41004e061e582855eb1e99b6a6e5d52994f661be`, 홈은 [README.md](README.md))의 웹 워크벤치가 (1) 브라우저에서 어떤 순서로 부팅하는지, (2) 누가 어떻게 서빙하는지, (3) 어떤 단계로 빌드되는지, (4) 내장 확장이 웹 빌드에 어떻게 들어가는지를 정리한다. 마지막에 Vite 빌드가 이 단계들 중 무엇을 대체하는지 적는다. 경로는 모두 VS Code 저장소 기준이다. 이 워크벤치의 대응 경로는 `src/vs/<path>` -> `src/<path>`이며 [architecture.md](architecture.md)에 있다.

범위 밖(이름만): 채팅, 세션(`vs/sessions/...` 진입점), 노트북, 터미널, 디버그, 설정 에디터 UI, 원격(`remoteAuthority`), 데스크톱 빌드. 이 페이지는 해당 진입점이 빌드 목록에 보이더라도 설명하지 않는다.

## 1. 한눈에 보는 부팅 순서

| 단계 | 누가 | 심볼 / 파일 | 하는 일 |
| --- | --- | --- | --- |
| 1 | 서버 | `src/vs/server/node/webClientServer.ts`의 `WebClientServer._handleRoot` | HTML 템플릿을 읽어 `{{...}}` 자리표시자를 채워 응답한다 |
| 2 | 브라우저 | `src/vs/code/browser/workbench/workbench.html` | 설정을 `<meta>`에 담고, NLS 모듈과 `workbench.js`를 `type="module"`로 로드한다 |
| 3 | 브라우저 | `src/vs/code/browser/workbench/workbench.ts`의 끝 즉시 실행 함수 | `<meta id="vscode-workbench-web-configuration">`의 JSON을 읽고 `create(...)`를 호출한다 |
| 4 | 워크벤치 | `src/vs/workbench/browser/web.factory.ts`의 `create` | 임베더 커맨드를 등록하고 `new BrowserMain(domElement, options).open()`을 호출한다 |
| 5 | 워크벤치 | `src/vs/workbench/browser/web.main.ts`의 `BrowserMain.open` | `initServices`와 `domContentLoaded`를 병렬로 기다린 뒤 `createWorkbench` -> `workbench.startup()` |
| 6 | 워크벤치 | `src/vs/workbench/browser/workbench.ts`의 `Workbench.startup` | 파트 렌더링과 레이아웃(상세는 [vscode-workbench-layout.md](vscode-workbench-layout.md)) |

## 2. 브라우저가 처음 로드하는 것

### 2.1 `workbench.html`

파일: `src/vs/code/browser/workbench/workbench.html`. 개발용 변형은 같은 디렉터리의 `workbench-dev.html`이다.

| 요소 | 내용 | 결정하는 것 |
| --- | --- | --- |
| `<meta id="vscode-workbench-web-configuration" data-settings="{{WORKBENCH_WEB_CONFIGURATION}}">` | 서버가 만든 JSON 설정 | `workbench.ts`가 읽는 `IWorkbenchConstructionOptions`의 출처 |
| `<meta id="vscode-workbench-web-base-url" ...>` | 정적 리소스 루트(`WORKBENCH_WEB_BASE_URL`) | 인라인 스크립트가 `globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/'`를 설정한다. 이후 모든 리소스 로딩(`FileAccess`)의 기준 |
| `<meta id="vscode-workbench-auth-session" ...>` | 개발용 인증 세션 | 빌드된 배포에서는 비어 있다 |
| `<link rel="stylesheet" href=".../out/vs/code/browser/workbench/workbench.css">` | 번들된 CSS | 빌드판은 CSS를 링크로 로드한다 |
| `<script type="module" src="{{WORKBENCH_NLS_FALLBACK_URL}}">` | 항상 영어 기본 메시지(`out/nls.messages.js`) | NLS 폴백 |
| `<script type="module" src="{{WORKBENCH_NLS_URL}}">` | 영어가 아닐 때만 채워진다 | 로케일 메시지 시도 |
| `<script type="module" src=".../out/vs/code/browser/workbench/workbench.js">` | 진입 모듈 | 스크립트 순서는 "do not modify order of script tags" 주석이 고정한다 |
| `#vscode-startup-fallback` | 10초 후 나타나는 "The editor failed to load" 안내 | `workbench.ts` 즉시 실행 함수가 스크립트 실행 첫 줄에서 이 요소를 제거한다 |
| `performance.mark('code/didStartRenderer')`, `code/willLoadWorkbenchMain` | 성능 마크 | 부팅 구간 측정 |

### 2.2 `workbench-dev.html`과 `workbench.html`의 차이

- `workbench-dev.html`에는 `vscode-workbench-builtin-extensions`와 `vscode-workbench-css-modules` 두 `<meta>`가 더 있다.
- 개발판은 CSS를 `<link>` 대신 import map으로 푼다. `globalThis._VSCODE_CSS_LOAD`가 `sheet.insertRule('@import url(...)')`를 호출하고, `WORKBENCH_DEV_CSS_MODULES` 목록으로 import map을 만든다. 서버가 CSS 모듈 목록을 내려 주는 이유다(`webClientServer.ts`의 `_cssDevService`).
- 서버는 `this._environmentService.isBuilt`가 참이면 `workbench.html`, 아니면 `workbench-dev.html`을 고른다.

### 2.3 `workbench.ts` (브라우저 셸)

파일: `src/vs/code/browser/workbench/workbench.ts`. 이 파일은 "워크벤치 자체"가 아니라 임베더 역할을 하는 셸이다.

| 심볼 | 하는 일 |
| --- | --- |
| 파일 끝의 즉시 실행 함수 | 폴백 제거, `<meta>`의 JSON 파싱, 비밀 저장소 암호화 선택, `create(mainWindow.document.body, {...})` 호출 |
| `WorkspaceProvider`(`WorkspaceProvider.create`) | `IWorkspaceProvider` 구현. URL의 `folder`/`workspace` 쿼리와 서버가 준 `folderUri`/`workspaceUri`를 열 작업공간으로 해석하고, `open`으로 창 이동/새 창을 처리한다 |
| `LocalStorageSecretStorageProvider`, `ServerKeyedAESCrypto`, `TransparentCrypto` | `ISecretStorageProvider`와 암호화. 쿠키 `vscode-secret-key-path`가 있고 `ServerKeyedAESCrypto.supported()`면 서버 키로 암호화하고, 아니면 `TransparentCrypto`(평문) |
| `LocalStorageURLCallbackProvider` | `IURLCallbackProvider`. `config.callbackRoute`(서버의 `/callback`)로 OAuth류 콜백을 받는다 |
| `windowIndicator` 기본값 | `config.windowIndicator ?? { label: '$(remote)', tooltip: ... Web }` |

- 이 파일이 임포트하는 `create`는 `src/vs/workbench/workbench.web.main.internal.ts`에서 온다(2.5 참고).
- 이 워크벤치에 주는 시사점: 소비자 코드(`main.ts`)가 설정 JSON을 DOM에서 읽고 `create`를 부르는 구조는 그대로 따라 할 수 있는 얇은 층이다. 서버가 필요 없다면 설정 JSON을 빌드 시 상수로 대체하면 된다.

### 2.4 `web.factory.ts`의 `create`와 `web.main.ts`의 `BrowserMain`

`src/vs/workbench/browser/web.factory.ts`:

| 항목 | 내용 |
| --- | --- |
| `create(domElement, options)` | 모듈 변수 `created`로 두 번째 호출을 막는다("Unable to create the VSCode workbench more than once.") |
| `options.commands` | 각 항목을 `CommandsRegistry.registerCommand`로 등록하고, `label`이 있으면 `MenuRegistry.appendMenuItem`으로 `MenuId.CommandPalette`(또는 `Menu` 열거형이 가리키는 메뉴, `asMenuId`)에 추가한다 |
| 반환 | `toDisposable` — 워크벤치가 준비되기 전이면 `workbenchPromise`를 기다렸다가 `shutdown()` |
| 네임스페이스 `commands`, `logger`, `env`, `window`, `workspace` | `create` 뒤에 임베더가 쓰는 API 면(`executeCommand`, `openUri`, `withProgress` 등) |

`src/vs/workbench/browser/web.main.ts`:

| 심볼 | 하는 일 |
| --- | --- |
| `BrowserMain.open` | `Promise.all([this.initServices(), domContentLoaded(...)])` -> `createWorkbench` -> `registerListeners` -> `workbench.startup()` -> `BrowserWindow` 생성 -> `IWorkbench` 파사드 반환 |
| `BrowserMain.initServices` | 서비스 컬렉션을 손으로 만든다: 제품(`IProductService`), 환경(`BrowserWorkbenchEnvironmentService`), 파일(`FileService`), 로그, 사용자 데이터 프로필, 원격 에이전트 등 |
| `BrowserMain.registerIndexedDBFileSystemProviders` | IndexedDB `vscode-web-db`(버전 3)에 스토어 `vscode-userdata-store`, `vscode-logs-store`, `vscode-filehandles-store`를 만든다. 사용자 데이터 스킴(`Schemas.vscodeUserData`)은 `IndexedDBFileSystemProvider`, 로그 스킴은 같은 DB의 로그 스토어, IndexedDB가 실패하면 `InMemoryFileSystemProvider`로 대체한다. `WebFileSystemAccess.supported`면 `Schemas.file`에 `HTMLFileSystemProvider`를 등록한다. `Schemas.tmp`는 메모리 |
| `createWorkspaceAndDependentServices` | `BrowserStorageService`, 설정 서비스(`WorkspaceService`), 비밀 저장소 등 작업공간에 의존하는 서비스를 만든다(상세는 [vscode-state-settings.md](vscode-state-settings.md)) |

`initServices`의 주석이 고정한 규칙: 서비스는 여기서 등록하지 않는다. 공용 서비스는 `workbench.common.main.ts`, 웹 전용은 `workbench.web.main.ts`에서 `registerSingleton()`으로 등록한다. `BrowserMain.initServices`에는 "먼저 만들어야 하는" 서비스(파일, 환경, 설정, 스토리지처럼 비동기 초기화가 필요한 것)만 남는다.

### 2.5 임포트 목록: `workbench.common.main.ts`, `workbench.web.main.ts`, `workbench.web.main.internal.ts`

| 파일 | 역할 |
| --- | --- |
| `src/vs/workbench/workbench.common.main.ts` | 웹/데스크톱 공용. 부수효과 임포트로 파트(`browser/parts/editor/editor.contribution.js`, `browser/parts/statusbar/statusbarPart.js`, `browser/parts/titlebar/menubar.contribution.js`), 액션(`browser/actions/layoutActions.js`), 기여 지점(`services/actions/common/menusExtensionPoint.js`, `api/browser/viewsExtensionPoint.js`), 서비스(`services/editor/browser/editorService.js`, `services/keybinding/browser/keybindingService.js` 등)를 등록한다 |
| `src/vs/workbench/workbench.web.main.ts` | `./workbench.common.main.js`를 먼저 임포트하고, 이어서 웹 전용 구현을 임포트한다: `./browser/web.main.js`, 제목 표시줄 구현 `BrowserTitleService`(`./browser/parts/titlebar/titlebarPart.js`), `src/vs/workbench/services/extensions/browser/extensionService.ts`, `services/extensionManagement/browser/webExtensionsScannerService.js`, `services/textfile/browser/browserTextFileService.js`, `services/lifecycle/browser/lifecycleService.js`, `services/host/browser/browserHostService.js`, `services/workingCopy/browser/workingCopyBackupService.js` 등 |
| `src/vs/workbench/workbench.web.main.internal.ts` | `./workbench.web.main.js`를 임포트하고 `create`(`web.factory.js`), `URI`, `Event`, `Emitter`, `Disposable`, `GroupOrientation`, `LogLevel`, `commands`, `env`, `window`, `workspace`, `logger`, `Menu`를 다시 내보낸다. 임베더가 쓰는 공개 면 |

핵심 사실:

- 서비스 등록은 임포트의 부수효과다(`registerSingleton`, `MenuRegistry`, `Registry.as(...)`). 그래서 임포트 목록이 곧 "어떤 기능이 번들에 들어가는가"를 결정한다. 임포트를 빼면 기능이 사라진다.
- 같은 임포트 목록에는 이 워크벤치가 따르지 않는 기능(터미널, 디버그, 채팅, 원격 등)이 훨씬 많이 들어 있다. 이름만 알아 두고 따르지 않는다.
- 이 워크벤치에 주는 시사점: v0.1.0은 `workbench.common.main` 등가 파일 하나에 여섯 파트와 커맨드/메뉴/키바인딩/확장 호스트만 임포트하는 "작은 임포트 목록"을 만들면 된다. 웹 전용 구현을 별도 파일로 나누는 VS Code의 분리(`common` 대 `web`)는 데스크톱 빌드가 없으면 불필요하다.

## 3. 어떻게 서빙되는가

### 3.1 개발 서버: `scripts/code-web.js`

| 항목 | 내용 |
| --- | --- |
| 하는 일 | 직접 서빙하지 않는다. `require.resolve('@vscode/test-web')`로 찾은 패키지를 `child_process.spawn(process.execPath, [testWebLocation, ...args])`(함수 `startServer`)로 자식 프로세스로 실행한다 |
| 인자 | `--host`(기본 `localhost`), `--port`(기본 `8080`), `--sourcesPath`(저장소 루트 `APP_ROOT`), `--browserType none`(`--browser`/`--browserType`가 없을 때, 그리고 `open`으로 시스템 브라우저를 연다), 나머지는 그대로 전달 |
| `--playground` | `vscode-web-playground` 확장을 `.build/builtInWebDevExtensions` 아래로 내려받아(`ensureWebDevExtensions`) `--extensionPath`로 넘기고 `--folder-uri memfs:///sample-folder`를 준다 |
| 첫 인자 `folderMountPath` | 로컬 폴더를 연다 |
| 의존성 | `package.json`의 devDependency `@vscode/test-web` |

- `package.json`의 `web` 스크립트는 `./scripts/code-server`나 `./scripts/code-web`로 대체되었다고 에코만 한다(직접 실행하지 않음).
- 서버 쪽 코드(`@vscode/test-web` 내부)는 이 커밋에 없다. 이 페이지는 `code-web.js`가 넘기는 인자까지만 확인했다. `@vscode/test-web`이 정확히 어떤 HTML을 서빙하는지는 확인하지 못해 서술하지 않는다.

### 3.2 `WebClientServer`

파일: `src/vs/server/node/webClientServer.ts`. `scripts/code-server.js`가 띄우는 서버(진입 `out/server-main.js`)가 웹 번들이 있을 때 사용한다. 클래스 주석: "This method is only invoked when the server has web bits", 연결 토큰 검증 이후에만 호출된다.

`WebClientServer.handle`의 라우트 표:

| 상수 | 경로 | 핸들러 | 하는 일 |
| --- | --- | --- | --- |
| `STATIC_PATH` | `/static/...` | `_handleStatic` | `APP_ROOT` 아래 파일을 `serveFile`로 서빙. `isEqualOrParent`로 루트 밖 경로를 400 처리. 빌드판은 `CacheControl.NO_EXPIRY`, 개발판은 `CacheControl.ETAG` |
| `STATIC_PATH` + `MANIFEST_PATH` | `/static/resources/server/manifest.json` | `_handleManifest` | PWA 매니페스트 |
| (루트) | `/` | `_handleRoot` | 워크벤치 HTML 렌더링 |
| `CALLBACK_PATH` | `/callback` | `_handleCallback` | OAuth 콜백 페이지 |
| `WEB_EXTENSION_PATH` | `/web-extension-resource/...` | `_handleWebExtensionResource` | 갤러리 확장 리소스 프록시(`extensionsGallery.resourceUrlTemplate`를 이 경로로 다시 쓴다) |
| 그 외 | | | `serveError(..., 404, 'Not found.')` |

`_handleRoot`가 결정하는 것:

| 입력 | 결과 |
| --- | --- |
| `this._environmentService.isBuilt` | `workbench.html` 또는 `workbench-dev.html` 선택(`FileAccess.asFileUri`) |
| `workbenchWebConfiguration` 객체 | `remoteAuthority`, `serverBasePath`, `_wrapWebWorkerExtHostInIframe`, `developmentOptions`, `enableWorkspaceTrust`, `folderUri`, `workspaceUri`, `productConfiguration`, `callbackRoute` — JSON으로 `WORKBENCH_WEB_CONFIGURATION`에 들어간다 |
| `_wrapWebWorkerExtHostInIframe` | 기본은 `undefined`(기본 동작 유지), 스모크 테스트 드라이버(`enable-smoke-test-driver`)일 때만 `false`. 값이 클라이언트 `webWorkerExtensionHost.ts`로 전달된다([vscode-extensions.md](vscode-extensions.md)) |
| 로케일 | 쿠키 `vscode.nls.locale` 또는 `accept-language`. 영어가 아니고 `nlsCoreBaseUrl`이 있으면 `createNlsUrl`로 `WORKBENCH_NLS_URL`을 채우고, 아니면 빈 문자열(폴백만 사용) |
| `renderWorkbenchTemplate(template, values)` | `{{KEY}}` 치환. 값: `WORKBENCH_WEB_CONFIGURATION`, `WORKBENCH_AUTH_SESSION`, `WORKBENCH_WEB_BASE_URL`, `WORKBENCH_NLS_URL`, `WORKBENCH_NLS_FALLBACK_URL`, `WORKBENCH_SCRIPT_NONCE`, 개발 시 `WORKBENCH_DEV_CSS_MODULES`, 테스트 리졸버 시 `WORKBENCH_BUILTIN_EXTENSIONS` |
| `createWorkbenchContentSecurityPolicy` | 응답 헤더 `Content-Security-Policy`를 만든다(스크립트 nonce 포함) |
| 연결 토큰 | 토큰이 있으면 쿠키(`connectionTokenCookieName`)를 1주일(`maxAge`)로 갱신한다 |

- `WORKBENCH_WEB_BASE_URL`은 `posix.join(basePath, this._productPath, STATIC_PATH)`다. 정적 루트가 `/static`이므로 HTML의 `{{WORKBENCH_WEB_BASE_URL}}/out/...`는 실제로 `/static/out/...`가 된다.
- 이 워크벤치에 주는 시사점: 템플릿 치환과 CSP/nonce는 서버가 있어야 의미가 있다. 정적 호스팅(Vite)이면 `index.html`이 설정 JSON, 정적 루트, NLS를 빌드 시점 상수로 대체한다. CSP는 `<meta http-equiv>`로 줄이거나 호스팅 헤더로 옮긴다.

## 4. 어떻게 빌드되는가

### 4.1 빌드 대상과 진입점

`build/lib/esbuild.ts`의 `BuildTarget`은 `'desktop' | 'server' | 'server-web' | 'web' | 'mobile'`이다. `runEsbuildBundle(outDir, minify, nls, target, sourceMapBaseUrl)`은 `build/next/index.ts bundle ...`을 자식 프로세스로 실행하는 래퍼다. 실제 esbuild 설정은 `build/next/index.ts`의 `bundle`, `bundleToOutput`, `getEntryPointsForTarget`, `getCssBundleEntryPointsForTarget`에 있다.

| 대상 | 진입점(`getEntryPointsForTarget`) | 비고 |
| --- | --- | --- |
| `web` | `workerEntryPoints` + `webOnlyEntryPoints` + `vs/workbench/workbench.web.main.internal` + `keyboardMapEntryPoints` | 브라우저 셸(`workbench.ts`) 없음. CDN에 올려 임베더가 `create`를 부르는 형태 |
| `server-web` | `serverEntryPoints` + `workerEntryPoints` + `vs/code/browser/workbench/workbench` + `keyboardMapEntryPoints` | 셸 포함. `WebClientServer`가 서빙하는 쪽 |

- `workerEntryPoints`(웹 워커 번들, 별도 파일로 나옴): `vs/editor/common/services/editorWebWorkerMain`, `vs/workbench/api/worker/extensionHostWorkerMain`(확장 호스트 워커), `vs/workbench/services/search/worker/localFileSearchMain`, `vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain` 등. 목록에는 노트북 등 범위 밖 워커도 있다.
- `keyboardMapEntryPoints`: `vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux|darwin|win` 세 개.
- 따라서 "한 개의 JS 번들"이 아니다. 메인 번들 + 확장 호스트 워커 + 에디터 워커 + 텍스트메이트 워커 + 키보드 레이아웃 번들이 각각의 진입점이다.

### 4.2 gulp 태스크(`build/gulpfile.vscode.web.ts`)

| 태스크 | 정의 | 단계 |
| --- | --- | --- |
| `vscode-web`, `vscode-web-min` | `compileApiProposalNamesTask` -> `writeISODate('out-build')` -> CI 태스크 | 제안 API 이름 생성, 날짜 기록 |
| `vscode-web-ci`, `vscode-web-min-ci` | `copyCodiconsTask` -> `compileWebExtensionsBuildTask` -> `esbuild-vscode-web`(또는 `-min`) -> 대상 폴더 `rimraf` -> `packageTask` | 아이콘 폰트 복사, 내장 확장 패키징, esbuild 번들, 패키징 |
| `esbuild-vscode-web` | `runEsbuildBundle('out-vscode-web', false, true, 'web')` | 번들(NLS 켬) |
| `esbuild-vscode-web-min` | `runEsbuildBundle('out-vscode-web-min', true, true, 'web', ...)` | 최소화, 소스맵 기준 URL은 `sourceMappingURLBase`(`main.vscode-cdn.net/sourcemaps/<commit>`) |
| `compile-web-extensions-build` | `clean-web-extensions-build` -> `bundle-web-extensions-build` -> `bundle-marketplace-web-extensions-build` -> `bundle-web-extension-media-build` | `.build/web/extensions` 생성 |
| `packageTask(source, dest)` | `out-vscode-web*`를 `out`으로 이름을 바꿔 복사 + `.build/web/extensions` + `remote/web/package.json`(이름/버전/`type: 'module'` 주입) + 프로덕션 의존성(`getFlatProductionDependencies`) + `favicon.ico`, `manifest.json`, PWA 아이콘 | 결과는 `vscode-web` 폴더. `*.map`은 제외한다 |

- 이 커밋의 웹 번들러는 esbuild다(`build/next/index.ts`). 과거 글에서 보이는 webpack이나 AMD/`loader.js` 기반 설명은 이 커밋에 해당하지 않는다. 산출물은 ESM(`<script type="module">`)이다.
- NLS: 서버는 `WORKBENCH_NLS_FALLBACK_URL`을 `<정적 루트>/out/nls.messages.js`로 채우고 HTML이 이것을 로드한다. `build/next/nls-plugin.ts`가 `nls.messages.js`(와 `nls.messages.json`)를 쓴다. 번들러의 `--nls` 옵션이 이 플러그인을 켠다고 추정하지만 연결 지점은 확인하지 못했다(7절).

### 4.3 `package.json`의 `compile-web`, `watch-web`: 이름과 달리 워크벤치가 아니다

| 스크립트 | 값 | 실제 하는 일 |
| --- | --- | --- |
| `compile-web` | `pnpm run gulp compile-web` | `build/gulpfile.extensions.ts`의 `compileWebExtensionsTask` -> `buildWebExtensions(false)` |
| `watch-web` | `pnpm run gulp watch-web` | 같은 파일의 `watchWebExtensionsTask` -> `buildWebExtensions(true)` |
| `watch-webd` | `deemon pnpm run watch-web` | `watch-web`을 데몬으로 |

- `buildWebExtensions`는 `extensions` 폴더 아래의 `esbuild.browser.mts`를 전부 찾아 `ext.esbuildExtensions(...)`로 번들하고 `ext.typeCheckExtension`으로 타입 검사한다. 즉 웹용 내장 확장의 번들이지, 워크벤치 번들이 아니다.
- 워크벤치 소스는 개발 중 `watch-client-transpile`/`watch-client`(스크립트 `watch`가 묶는다)로 변환되고, `code-web.js`가 `--sourcesPath`로 저장소 루트를 서버에 알려 준다. 워크벤치의 웹 프로덕션 번들은 위 4.2의 `vscode-web*` 태스크가 만든다.
- 정리: 웹 빌드의 "개발 루프"와 "배포 번들"은 서로 다른 태스크 묶음이다.

### 4.4 템플릿 마커 치환

`build/next/index.ts`의 `fileContentMapperPlugin(outDir, target)`는 esbuild 플러그인으로 소스를 읽는 중에 마커를 바꾼다.

| 마커 | 치환 내용 |
| --- | --- |
| `/*BUILD->INSERT_PRODUCT_CONFIGURATION*/` | `product.json` + `version`, `commit`, `date`를 JSON으로 인라인 |
| `/*BUILD->INSERT_BUILTIN_EXTENSIONS*/` | `scanBuiltinExtensions(extensionsRoot)` 결과. 루트는 `web`이면 `.build/web/extensions`, `server-web`이면 `.build/extensions`, `mobile`이면 `<mobileDirectory>/extensions` |

- `productService.commit`이 채워지면 `isBuilt`가 참이 된다(`src/vs/workbench/services/environment/browser/environmentService.ts`의 `isBuilt`). 즉 제품 설정 인라인이 "빌드판" 판정 자체를 결정한다.

## 5. 내장 확장이 웹 빌드에 도달하는 방식

파일: `src/vs/workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts`의 `BuiltinExtensionsScannerService`(`IBuiltinExtensionsScannerService` 구현, `registerSingleton(..., InstantiationType.Delayed)`).

| 상황 | 목록의 출처 | 확장 리소스 위치 |
| --- | --- | --- |
| 빌드판(`environmentService.isBuilt`) | 생성자 안의 `bundledExtensions = [/*BUILD->INSERT_BUILTIN_EXTENSIONS*/]` — 빌드가 4.4처럼 채운다 | `FileAccess.asBrowserUri(builtinExtensionsPath)` 아래 `extensionPath`(`builtinExtensionsPath`는 `src/vs/base/common/network.ts`에 `'vs/../../extensions'`로 정의) |
| 개발판 | HTML의 `<meta id="vscode-workbench-builtin-extensions" data-settings=...>`를 `JSON.parse`. 이 `<meta>`는 `workbench-dev.html`에만 있고, 서버가 `useTestResolver`일 때 `vscode-test-resolver`, `github-authentication` 두 확장만 채운다 | 같음 |

처리 과정:

1. 각 번들 항목(`IBundledExtension`: `extensionPath`, `packageJSON`, `packageNLS?`, `readmePath?`, `changelogPath?`)을 `IExtension`으로 바꾼다.
2. `type: ExtensionType.System`, `isBuiltin: true`, `targetPlatform: TargetPlatform.WEB`, `isValid: true`로 고정한다.
3. `packageNLS`가 있으면 `localizeManifest`로 매니페스트를 번역한다. 영어가 아니고 `extensionsGallery.nlsBaseUrl`, `productService.commit`이 있으면 `<nlsBaseUrl>/<commit>/<version>/<language>/<extensionId>/package`에서 번역을 읽고, 실패하면 `logService.error` 후 번들된 번역으로 대체한다.
4. `scanBuiltinExtensions()`가 모든 프로미스를 모아 돌려준다.

- 서비스는 `isWeb`일 때만 목록을 채운다.
- 내장 확장의 코드는 별도 요청으로 `extensionPath` 위치에서 로드된다. 확장 호스트 워커가 이를 어떻게 로드하는지는 [vscode-extensions.md](vscode-extensions.md).
- 사용자 설치 확장(`WebExtensionsScannerService`)은 이와 별개이며 같은 페이지에 있다.

빌드 쪽 파이프라인(4.2의 `compile-web-extensions-build`):

| 태스크 | 함수 | 하는 일 |
| --- | --- | --- |
| `bundle-web-extensions-build` | `build/lib/extensions.ts`의 `packageAllLocalExtensionsStream(true)` | 로컬 확장을 웹용으로 패키징(`forWeb` 참). 확장에 `esbuild.browser.mts`가 있으면 그것을 사용한다 |
| `bundle-marketplace-web-extensions-build` | `packageMarketplaceExtensionsStream(true)` | 마켓플레이스에서 가져오는 내장 확장 |
| 결과 | `.build/web/extensions` | `fileContentMapperPlugin`이 이 폴더를 스캔해 4.4의 목록을 만든다 |

## 6. 이것이 Vite 빌드에 의미하는 바

이 워크벤치(writing-room)는 Vite로 빌드한다(홈 페이지). VS Code의 웹 빌드 단계 중 Vite가 대체하는 것과 대체하지 않는 것:

| VS Code 단계 | 심볼 / 파일 | Vite에서 |
| --- | --- | --- |
| 진입점 선언 | `build/next/index.ts`의 `getEntryPointsForTarget` | `index.html`의 `<script type="module">`와 `build.rollupOptions.input`으로 대체 |
| 번들, 최소화, 소스맵 | `runEsbuildBundle`, `bundle` | Vite 빌드가 대체(개발은 esbuild 사전 번들 + 네이티브 ESM) |
| HTML 템플릿 치환 | `webClientServer.ts`의 `renderWorkbenchTemplate` | 대체: Vite `index.html` 변환(`transformIndexHtml`)이나 `define`/`import.meta.env`로 빌드 시점 값 주입. 서버가 없으면 요청별 nonce는 불가능 |
| 제품 설정, 내장 확장 목록 인라인 | `fileContentMapperPlugin`의 두 마커 | 대체: `define`이나 `import.meta.glob`/가상 모듈 플러그인으로 인라인 |
| 워커 번들 | `workerEntryPoints` | `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`를 Vite가 별도 청크로 번들한다. 확장 호스트 워커도 이 방식 |
| CSS | `getCssBundleEntryPointsForTarget`, 개발판 import map(`_VSCODE_CSS_LOAD`) | Vite가 CSS 임포트를 처리. 개발용 import map 우회는 필요 없다 |
| NLS | `--nls`, `nls.messages.js`, `WORKBENCH_NLS_URL` | v0.1.0 범위 밖이면 생략 |
| 정적 서빙, 캐시 | `_handleStatic`의 `CacheControl` | 호스팅/`vite preview`가 대신한다. 해시된 파일명이 `NO_EXPIRY` 역할 |
| 정적 자산 패키징 | `packageTask` | `public/`과 `dist/` |
| 내장 확장 번들 | `compile-web-extensions-build`, `packageAllLocalExtensionsStream` | 대체하지 않는다. 확장은 워크벤치 번들과 따로 만들어 매니페스트와 함께 정적 파일로 두는 구조를 따로 설계해야 한다 |
| 로케일 협상, CSP, 연결 토큰, 쿠키 | `_handleRoot`, `createWorkbenchContentSecurityPolicy` | 서버 기능이므로 정적 빌드에는 대응이 없다 |
| OAuth 콜백, 갤러리 프록시 | `_handleCallback`, `_handleWebExtensionResource` | 범위 밖 |

따를 만한 것(사실 아님, 권고):

- `create(domElement, options)`처럼 "한 번만 호출되는 팩토리 + 얇은 부트 셸" 구조는 Vite에서도 그대로 성립한다.
- 서비스 등록을 임포트 부수효과로 하는 방식은 Vite의 트리 셰이킹이 부수효과 모듈을 제거할 수 있으므로, 등록 모듈은 `package.json`의 `sideEffects` 설정이나 명시적 임포트로 보호해야 한다.
- 저장은 IndexedDB(`vscode-web-db`)다. 이 사실은 2.4에 있고 상세는 [vscode-state-settings.md](vscode-state-settings.md)에 있다. v0.1.0의 저장소 선택과 비교할 때 이 페이지의 `registerIndexedDBFileSystemProviders`를 근거로 한다.

## 7. 확인하지 못해 서술하지 않은 것

- `@vscode/test-web` 내부(이 저장소 밖 패키지)의 서빙 방식.
- `vs/sessions/*`와 `mobile` 대상(범위 밖).
- `build/next/index.ts`의 `--nls` 옵션이 `build/next/nls-plugin.ts`를 어떻게 연결하는지.

Decided in: wr-e8v6
