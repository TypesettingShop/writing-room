# Writing Room 확장 API

Writing Room v0.2.0은 VS Code와 같은 이름과 시그니처로 웹 확장 API의 부분집합을 제공한다. 기준은 고정 커밋 `41004e061e582855eb1e99b6a6e5d52994f661be`(패키지 버전 1.148.0)의 `vscode.d.ts`이고 `vscode.version`은 `1.148.0`을 보고한다. 선언한 심볼은 upstream과 이름, 매개변수, 반환 타입이 같고, 선언하지 않은 것은 지원하지 않는 것이다. 이 페이지는 색인이다. 지원 범위의 표, 받기만 하는 API, 지원하지 않는 것, 실제 확장으로 확인한 결과를 모으고 세부는 영역 페이지에 둔다. 처음 쓰는 사람은 [시작하기](getting-started.md)를 먼저 읽는다.

## 영역별 문서

- [문서와 에디터](extension-api-documents.md)
- [언어 기여](extension-api-language-contributions.md)
- [진단과 Problems](extension-api-diagnostics.md)
- [파일 시스템과 워크스페이스](extension-api-file-system.md)
- [파일 편집과 Explorer](files-and-explorer.md)
- [Webview](extension-api-webview.md)
- [설정 기여](extension-api-configuration.md)
- [창 UI](extension-api-window-ui.md)
- [테마와 뷰](extension-api-theming-and-views.md)
- [확장 런타임](extension-api-runtime.md)
- [확장 설치](extension-installation.md)
- [언어 기능](extension-api-language-features.md)
- [Custom Editor](extension-api-custom-editors.md)

## 호환 표

### 네임스페이스별 지원 범위

선언 수는 적합성 검사(`src/vscode-dts/test/apiConformance.test.ts`)가 내는 출력이다. 검사는 `src/vscode-dts/*.d.ts`를 upstream `vscode.d.ts`(`test/fixtures/vscode-api/vscode.d.ts`, 위 커밋의 원문)와 대조하고, 선언이 있는 모든 키가 런타임에 있고 런타임의 모든 키가 선언돼 있는지도 본다. 숫자는 이 저장소의 선언 수와 upstream의 선언 수다. 최상위 줄은 네임스페이스 이름도 하나로 센다.

| 범위 | 선언 / upstream | 지원하는 것 | 지원하지 않는 것 | 자세히 |
| --- | --- | --- | --- | --- |
| 최상위 선언 | 335 / 531 | 공용 값과 타입, 문서·언어·Webview·파일·설정·테마 영역의 클래스, 열거형, 인터페이스 | 노트북, 터미널, 디버그, 소스 제어, 댓글, 테스트, 인증, 채팅, 언어 모델의 선언 | 아래 표 |
| `workspace` | 35 / 47 | 문서 열기와 이벤트, `applyEdit`, `fs`, 파일 작업 이벤트, 감시, `findFiles`, `workspaceFolders`, `getConfiguration`, `registerFileSystemProvider`, `registerTextDocumentContentProvider` | `rootPath`, `save`, `saveAs`, `saveAll`, 노트북 직렬화와 열기, `registerTaskProvider`, 타임라인 제공자, `decode`, `encode` | [문서와 에디터](extension-api-documents.md), [파일 시스템](extension-api-file-system.md), [설정](extension-api-configuration.md) |
| `window` | 33 / 57 | 텍스트 에디터와 이벤트, 장식, `showTextDocument`, `tabGroups`, Webview와 Custom Editor, QuickPick과 InputBox, OutputChannel, 메시지, `withProgress`, 트리 뷰, 상태 표시줄, 열기·저장 대화상자, 활성 색 테마 | 노트북 에디터, 터미널, 창 상태, `showWorkspaceFolderPick`, `registerUriHandler`, 파일 장식 제공자, `withScmProgress` | [창 UI](extension-api-window-ui.md), [테마와 뷰](extension-api-theming-and-views.md), [Webview](extension-api-webview.md), [Custom Editor](extension-api-custom-editors.md) |
| `languages` | 40 / 40 | 완성, 호버, 서식, 코드 액션, 이름 바꾸기, 문서 기호, 링크, 정의와 참조, 접기, 진단 컬렉션, 워크스페이스 기호 등 제공자 등록 전부, `match`, `setLanguageConfiguration`, 진단 읽기 | `createLanguageStatusItem`. 제안 API `registerMultiDocumentHighlightProvider`는 받기만 한다(upstream `vscode.d.ts`에 없는 선언이어서 40을 채운다) | [언어 기능](extension-api-language-features.md), [진단과 Problems](extension-api-diagnostics.md) |
| `commands` | 2 / 4 | `registerCommand`, `executeCommand`. 내장 커맨드 `vscode.open`, `vscode.openWith`, `vscode.execute*Provider` 열한 가지 등 | `registerTextEditorCommand`, `getCommands` | 이 페이지 |
| `env` | 17 / 21 | `appName`, `language`, `clipboard`, `openExternal`, `asExternalUri`, `machineId`, `sessionId`, `uiKind`, `logLevel`, 텔레메트리 로거 | `appRoot`, `isNewAppInstall`, `isAppPortable`, `onDidChangeShell` | [확장 런타임](extension-api-runtime.md) |
| `extensions` | 3 / 3 | `all`, `getExtension`, `onDidChange` | | [확장 런타임](extension-api-runtime.md) |
| `l10n` | 3 / 3 | `t`, `bundle`, `uri` | | [확장 런타임](extension-api-runtime.md) |
| `tasks` | 8 / 8 | 모두 받기만 한다 | 실행하지 않는다 | 아래 받기만 하는 API |

표의 수는 검사 출력에서 가져온 것이다. 검사가 예외로 허용한 선언은 27건이다(`src/vscode-dts/test/apiDeviations.json`). 모두 upstream `vscode.d.ts`에는 없는 제안 API이며 항목마다 이슈 id와 까닭이 있다. `externalUriOpener`(wr-jbmd.g2y) 18건은 vscode.simple-browser가 활성화에서 부르고, `registerMultiDocumentHighlightProvider`와 그 클래스(wr-c9d8.kxn) 9건은 받기만 한다.

### 받기만 하는 API

받아서 정리 가능한 객체를 돌려주지만 동작하지 않는 API다. 없는 함수를 부르면 활성화가 던지는 확장이 있어서 둔다.

| API | 동작 |
| --- | --- |
| `languages`의 제공자 아홉: `registerCallHierarchyProvider`, `registerTypeHierarchyProvider`, `registerInlineValuesProvider`, `registerEvaluatableExpressionProvider`, `registerDocumentDropEditProvider`, `registerDocumentPasteEditProvider`, `registerInlineCompletionItemProvider`, `registerDocumentRangeSemanticTokensProvider`, `registerMultiDocumentHighlightProvider` | 등록은 받고 아무도 묻지 않는다. [받기만 하는 제공자](extension-api-language-features.md#받기만-하는-제공자) |
| `tasks` | 등록은 정리 가능한 객체를 돌려준다. 조회는 빈 배열, 실행은 거부, 이벤트는 없다. `Task`와 실행 클래스는 만들 수 있다 |
| `window.registerExternalUriOpener`(제안 API) | 등록은 받고 열기 도구에 묻지 않는다. `env.openExternal`은 오프너 서비스로 연다 |
| `workspace.notebookDocuments`와 노트북 이벤트 | 빈 배열이고 이벤트는 발생하지 않는다 |
| `workspace.isTrusted` | 늘 `true`이고 변경 이벤트는 없다 |
| `env.createTelemetryLogger` | 호출을 받고 아무것도 보내지 않는다 |
| `globalState.setKeysForSync`, 환경 변수 컬렉션 | 호출은 받고 동기화나 터미널 적용은 하지 않는다 |

자세한 동작과 VS Code와의 차이는 [확장 런타임의 Deviations](extension-api-runtime.md#deviations-from-vs-code)에 있다.

### 지원하지 않는 네임스페이스

`debug`, `scm`, `tests`, `comments`, `authentication`, `chat`, `lm`, `notebooks`는 선언이 없고 `require('vscode')`의 해당 키는 `undefined`다. 터미널, 노트북 편집기, 파일 장식, 타임라인, 언어 상태 항목처럼 위 표의 "지원하지 않는 것"에 있는 멤버도 같다. 확장이 이것을 부르면 `undefined` 접근이나 호출 오류로 실패한다.

### 지원하는 기여 지점

`contributes`의 키 열다섯 가지를 읽는다.

| 키 | 항목 | 자세히 |
| --- | --- | --- |
| `commands` | `command`, `title`, 선택적인 `category`, `icon`, `enablement` | 아래 기여 지점 |
| `menus` | `commandPalette`, `editor/title`, `editor/title/context`, `editor/context`, `explorer/context`, `webview/context`, `view/title`, `view/item/context` 또는 선언한 하위 메뉴에 `command`나 `submenu` 등록. `when`과 `group`은 선택 사항이다 | 아래 기여 지점 |
| `submenus` | `id`, `label`, 선택적인 `icon`으로 하위 메뉴 선언 | 아래 기여 지점 |
| `keybindings` | `command`, `key`, 선택적인 `mac`, `win`, `linux`, `when`, `args`. 단일 객체나 배열을 받는다 | 아래 기여 지점 |
| `viewsContainers` | `activitybar` 또는 `panel`에 `id`, `title`, `icon` 등록 | 아래 기여 지점 |
| `views` | 컨테이너 ID 또는 `explorer` 아래에 `id`, `name`, `when?` 등록. `"type": "webview"`로 WebviewView를 선언한다 | [Webview](extension-api-webview.md#사이드바와-패널의-webviewview) |
| `viewsWelcome` | 뷰가 비었을 때 보이는 환영 문구 | [테마와 뷰](extension-api-theming-and-views.md#환영-문구-contributesviewswelcome) |
| `languages` | 언어 정의, 확장자와 파일 이름, 언어 구성 | [언어 기여](extension-api-language-contributions.md) |
| `grammars` | TextMate 문법과 임베디드 언어 | [언어 기여](extension-api-language-contributions.md) |
| `snippets` | 언어별 스니펫 | [언어 기여](extension-api-language-contributions.md) |
| `configuration` | 설정 속성 | [설정 기여](extension-api-configuration.md) |
| `configurationDefaults` | 일반 키와 `[언어]` 구역의 기본값 | [설정 기여](extension-api-configuration.md) |
| `themes` | 색 테마 | [테마와 뷰](extension-api-theming-and-views.md) |
| `colors` | 색 id | [테마와 뷰](extension-api-theming-and-views.md) |
| `customEditors` | `viewType`, `displayName`, `selector`, `priority` | [Custom Editor](extension-api-custom-editors.md) |

### 지원하지 않는 기여 지점

위 열다섯 가지 밖의 키는 읽지 않는다. 확장의 상태에 `Unsupported contributions: <키 목록>` 정보가 남고 확장은 나머지 기여로 계속 돌아간다. 예: `jsonValidation`, `yamlValidation`, `taskDefinitions`, `problemMatchers`, `debuggers`, `terminal`, `notebooks`, `authentication`, `walkthroughs`, `iconThemes`, `productIconThemes`, `semanticTokenScopes`. 파일 아이콘 테마와 제품 아이콘 테마, 의미 토큰 색은 범위 밖이다([테마와 뷰](extension-api-theming-and-views.md#범위-밖)).

### 인수한 확장

Open VSX의 실제 웹 확장을 수정 없이 설치해 개발 서버와 프리뷰 빌드 양쪽에서 확인했다. 고정한 패키지의 크기와 sha256은 `test/fixtures/real-extensions/pins.json`에 있고 다음과 같다. 모든 확장은 MIT 라이선스다. 설치 화면, 새로고침 뒤 복원과 제거까지 거쳐 허용한 콘솔 메시지 밖의 오류가 없는 것을 통과의 조건으로 삼았다.

| 단 | id | 버전 | 라이선스 | sha256 | 통과한 단 |
| --- | --- | --- | --- | --- | --- |
| 주 1 | `vscode.markdown` | 1.95.3 | MIT | `53591b889e8941db812f263d8e5eaa34ec83718e399ecd7a1e178410bd3877a9` | 언어 모드, TextMate 문법, 언어 구성, 스니펫, 새로고침 뒤 유지와 제거 (`test/e2e/real-markdown-basics.spec.ts`) |
| 주 2 | `DavidAnson.vscode-markdownlint` | 0.62.1 | MIT | `b6baf90037c903aa21b9c525972910561a903b82e12fe8d67220740ec15b1aa0` | 진단과 Problems, 호버, 빠른 수정, 범위 서식, 설정과 워크스페이스의 설정 파일, Output 채널, 커맨드, 새로고침과 제거 (`test/e2e/real-markdownlint.spec.ts`) |
| 주 3 | `vscode.markdown-language-features` | 1.95.3 | MIT | `d2ba7aa2c1265e349862aa542a35daa45f81f2efbec8b51184d672999204d09e` | 미리보기(옆과 제자리), 포워딩 주소의 미리보기, Reopen With, 언어 서버 열세 가지 기능과 제거 (`test/e2e/real-markdown-preview.spec.ts`) |
| 바닥 | `GitHub.github-vscode-theme` | 6.3.5 | MIT | `a85236a58ad490b1600ec5a0fd0cea7eec56fb9d33660a1ac82c6da639ad3af4` | 색 테마 아홉 개를 기여하고 고른 테마를 적용 (`real-markdown-basics.spec.ts`) |
| 바닥 | `Tyriar.sort-lines` | 1.12.0 | MIT | `feecf004b40c9a9e73ba81347d61b69bb231f24df72d01b6b9a17435542deec9` | 선택한 줄 정렬: 키와 에디터 컨텍스트 메뉴, 제거 (`real-markdownlint.spec.ts`) |
| 바닥 | `vscode.simple-browser` | 1.95.3 | MIT | `9c3694e2707ce18863d49b7447955e36f9faf9c98ca8035170795d08fa9844cb` | WebviewPanel과 새로고침 뒤 복원 (`real-markdown-preview.spec.ts`) |

바닥 셋은 작은 확장으로 한 영역만 따로 돌려 주 후보가 깨질 때 어느 영역의 문제인지 좁힌다. 이 표에 없는 확장이 돈다고 보장하지 않는다. `main`만 있고 `browser` 진입점이 없는 확장은 기여만 적용되고 코드는 돌지 않는다([확장 설치](extension-installation.md)). 캐시를 채우고 이 스위트를 돌리는 법은 [시작하기](getting-started.md#검증하기)에 있다.

## 매니페스트와 진입점

확장 디렉터리의 `package.json`에는 `name`, `publisher`, `version`이 필요하다. 식별자는 대소문자를 구분하지 않는 `publisher.name`이다. `displayName`, `icon`, `browser`, `activationEvents`와 `contributes`를 추가할 수 있다. `browser`가 있는 확장은 단일 CommonJS 파일을 제공한다. `require('vscode')`로 확장에 바인딩된 API 객체를 가져온다. 다른 모듈 의존성은 진입 파일에 번들링해야 한다.

`activate(context)`와 `deactivate()`를 내보낼 수 있다. `context.subscriptions`에 등록이 반환한 disposable을 넣으면 제거 시 정리된다. `context.extensionUri`는 확장 디렉터리를 나타낸다. 내장 확장은 개발 서버와 배포 빌드에서 이 디렉터리를 기준으로 리소스를 읽을 수 있다. `context.extension`은 `id`, `packageJSON`(지역화 전 매니페스트의 사본), `isActive`, `exports`, `activate()`, `extensionUri`, `extensionPath`, `extensionKind`를 제공한다. 상태와 저장 경로, 환경, 활성화 이벤트, 종료의 자세한 동작은 [확장 런타임](extension-api-runtime.md)에 있다. `browser`가 `./dist/browser/extension`처럼 끝나면 로더가 `.js`를 붙인다.

기여 커맨드와 뷰에는 각각 `onCommand:<id>`, `onView:<id>`가 암묵적으로 추가된다. `*`와 `onStartupFinished`는 첫 레이아웃과 기여 등록 이후 실행된다. 확장별로 호스트가 실행되는 동안 한 번 활성화한다. 활성화가 실패하면 그 확장과 진입 파일의 URL이 로그에 남는다. 명령 팔레트에서 **Restart Extension Host**를 실행하면 기존 호스트의 등록을 정리하고 발생했던 활성화 이벤트를 새 호스트에서 재생한다. 기존 Worker의 종료 응답을 최대 5초 기다리고, 시한이 지나면 Worker를 끝낸 뒤 새 호스트를 시작한다. 이 시한은 호스트 종료 응답의 예산이다. 현재 확장의 비동기 `deactivate`가 끝나기를 기다리는 계약은 아니다(후속 wr-gl87). 살아 있던 Webview 패널마다 `onDidDispose`가 한 번 전달되고, 직렬화할 수 있는 탭은 새 호스트에서 복원되며 나머지는 닫힌다. 탭 아이콘과 패널별 `onDidDispose`의 자세한 동작은 [Webview](extension-api-webview.md#확장-호스트-재시작)에 있다.

## 기여 지점 상세

지원하는 키와 항목은 위의 [지원하는 기여 지점](#지원하는-기여-지점) 표에 있다. 다음은 `commands`, `menus`, `submenus`, `keybindings`, `viewsContainers`, `views`에 공통인 규칙이다.

`icon`은 codicon 지정자 `$(beaker)` 또는 확장 폴더 안의 상대 경로를 받는다. 커맨드와 하위 메뉴의 아이콘은 `{ light, dark }` 경로 쌍도 받는다. 커맨드 아이콘이 유효하지 않으면 아이콘을 제외하고 커맨드는 남긴다. `menus`의 `command`와 `submenu`는 각 기여 지점에 선언한 ID를 가리킨다. `alt`는 읽으며 메뉴 표시에는 적용하지 않는다. 그룹 순서는 `navigation@2`처럼 지정한다. 기여에 사용할 수 있는 식과 키는 [when 절과 컨텍스트 키](editor-services.md#when-절과-컨텍스트-키)에 정리되어 있다. 구문이 잘못된 식을 쓰는 기여는 건너뛴다.

## 커맨드

`commands.registerCommand(command, callback, thisArg?)`가 반환하는 `Disposable`로 커맨드를 해제할 수 있다. `commands.executeCommand<T>(command, ...args)`는 처리 결과의 thenable을 반환한다. 스레드 사이를 오가는 인자와 결과는 브라우저에서 구조화 복제할 수 있어야 한다. `Disposable`과 `EventEmitter<T>`도 제공한다.

## 트리, 상태 표시줄, 메시지

- `window.registerTreeDataProvider(viewId, provider)`와 `window.createTreeView(viewId, { treeDataProvider })`로 자신의 매니페스트에 선언한 뷰를 채운다. `getChildren(element?)`과 `getTreeItem(element)`을 구현한다. `onDidChangeTreeData`에 요소를 전달하면 해당 행을 갱신하고, `undefined`를 전달하면 전체 트리를 갱신한다. `TreeItem`에는 레이블, 안정적인 `id`, 설명, 툴팁, 접힘 상태, 커맨드, `contextValue`를 줄 수 있다. `view/item/context`에서는 `viewItem` 컨텍스트 키로 항목을 구분한다.
- `window.createStatusBarItem(alignment?, priority?)`와 `createStatusBarItem(id, alignment?, priority?)`는 `text`, `tooltip`, `command`, 색을 설정할 수 있는 항목을 반환한다. `show()`와 `hide()`로 표시를 전환하고 `dispose()`로 제거한다. 텍스트에서 `$(name)`은 codicon으로 렌더링된다. 색 지정은 [테마와 뷰](extension-api-theming-and-views.md#상태-표시줄-색)에 있다.
- `window.showInformationMessage`, `showWarningMessage`, `showErrorMessage`는 문자열 또는 `{ title }` 버튼을 받는다. 고른 원래 항목으로 resolve되며 닫으면 `undefined`다. `{ modal: true }`는 대화상자로 묻는다. 메시지는 워크벤치 안에 쌓인다. QuickPick, InputBox, OutputChannel, 진행 표시는 [창 UI](extension-api-window-ui.md)에 있다.

`vscode.version`의 기본값은 `1.148.0`이다. 공용 값은 `Uri`, `Position`, `Range`, `Selection`, `Location`, `TextEdit`, `SnippetTextEdit`, `WorkspaceEdit`, `SnippetString`, `MarkdownString`, `ThemeIcon`, `ThemeColor`, `CancellationTokenSource`, `CancellationError`, `RelativePattern`, `EndOfLine`, `ViewColumn`, `LogLevel`, `CodeActionKind`, `DataTransfer`, `DataTransferItem`을 포함한다. 위치와 편집 범위의 줄과 열은 0에서 시작한다. 에디터 메뉴에서 실행한 확장 커맨드에는 해당 리소스의 `Uri`를 첫 인자로 전달한다.

지원 범위는 `src/vscode-dts/vscode*.d.ts`에 선언되어 있고 위의 [호환 표](#호환-표)가 요약한다. 트리의 사용자 요소는 Worker에 남는다. 항목을 선택하면 기존 요소를 핸들에서 복원하며, 일반 커맨드 인자는 구조화 복제한다. 트리 아이콘, 체크박스, 드래그 앤 드롭, `reveal`, 선택 이벤트는 [테마와 뷰](extension-api-theming-and-views.md#트리-뷰)에 있다. 확장은 문서와 에디터([문서와 에디터](extension-api-documents.md)), 언어 기능([언어 기능](extension-api-language-features.md)), 파일([파일 시스템](extension-api-file-system.md)), 설정([설정 기여](extension-api-configuration.md)), Webview([Webview](extension-api-webview.md))와 확장 스토리지([확장 런타임](extension-api-runtime.md))를 위 영역 페이지의 API로 쓴다.

## Worker 격리

확장 코드는 워크벤치와 같은 오리진의 전용 Worker 하나에서 실행된다. 확장에는 DOM, `window`, 워크벤치의 `localStorage`와 호스트의 전용 메시지 포트가 제공되지 않는다. 확장이 화면을 그리려면 Worker 안의 DOM이 아니라 [Webview](extension-api-webview.md)(앱과 다른 오리진의 iframe)나 [Custom Editor](extension-api-custom-editors.md)를 쓰고, 트리와 상태 표시줄, 퀵 인풋, 메시지는 워크벤치의 정책에 따라 워크벤치가 그린다([창 UI](extension-api-window-ui.md), [테마와 뷰](extension-api-theming-and-views.md)). 앱 오리진에 대한 `fetch`와 IndexedDB는 Worker에서 사용할 수 있다. 확장들은 Worker 전역과 실행 자원을 공유하므로 동기 무한 루프는 호스트의 다른 확장도 멈춘다. 잡히지 않은 비동기 콜백 오류와 처리되지 않은 Promise 거부는 Worker의 스택에서 확장 진입 파일을 찾을 수 있으면 Output의 **Extension Host (Worker)** 채널에 확장의 공개 ID와 함께 기록되고, 주인을 찾지 못한 오류는 개발자 콘솔로 간다. 구독 정리와 `deactivate`의 실패도 그 채널로 간다. 한 확장의 오류가 다른 확장을 멈추지 않는다([확장 호스트 로그](extension-api-runtime.md#확장-호스트-로그)). Worker가 멈추면 메인 스레드는 계속 응답하며 호스트를 재시작할 수 있다. 같은 문제가 있던 이벤트를 재생하면 문제가 다시 발생할 수 있다.

호스트는 진입 파일을 자격 증명과 리다이렉트 없이 최대 5 MiB까지 읽는다. CommonJS 파일 평가에는 `Function` 생성자를 쓴다. 앱을 따로 호스팅하며 CSP를 적용하는 경우 Worker 정책에서 `unsafe-eval`이 필요하다.

## URL에서 확장 설치

1. 커맨드 팔레트에서 **Install Extension from Location...**을 실행하고 확장 디렉터리 URL을 입력한다. HTTPS와 개발용 `http://localhost`, `http://127.0.0.1`을 지원한다.
2. 디렉터리는 `package.json`과 매니페스트가 가리키는 상대 경로의 파일을 제공해야 한다. 다른 오리진에 있다면 매니페스트, 진입 파일, 이미지 응답에 앱 오리진 또는 `*`를 허용하는 `Access-Control-Allow-Origin` 헤더를 제공한다. 요청은 자격 증명을 보내지 않으며 리다이렉트를 따라가지 않는다.
3. 이름, 게시자, 버전과 출처 오리진을 확인한 뒤 **Install**을 선택한다. 256 KiB 이하의 매니페스트를 검증하고 설치 당시 사본을 저장한다. 진입 파일과 원격 아이콘은 활성화 이벤트가 발생할 때 각각 최대 5 MiB와 256 KiB까지 읽는다. 아이콘이 제한을 넘으면 기본 아이콘을 표시한다.
4. **Uninstall Extension...**에서 설치한 항목을 선택해 저장된 사본, 기여와 해당 뷰 컨테이너의 배치 기록을 제거한다. 매니페스트를 갱신하려면 제거 후 다시 설치한다. 원격 서버가 응답하지 않아도 저장된 기여는 표시되며 활성화 실패는 로그에 남는다.

이 확장의 코드는 설치 화면에 표시된 서버에서 받아 앱 오리진의 Worker에서 실행된다. 매니페스트 사본은 프로필 스토리지에 저장한다. 스토리지가 브라우저에서 차단되면 워크벤치는 메모리 저장소를 사용하며 그 세션 안에서만 설치를 유지하고, 확인 항목이 'Browser storage is unavailable: the extension stays for this session only.'로 알린다. 자세한 네 상태는 [확장 설치의 패키지 저장소](extension-installation.md#패키지-저장소)에 있다. VSIX 파일과 URL, Open VSX 검색과 설치, 해시와 서명 확인은 [확장 설치](extension-installation.md)에 있다.

Decided in: wr-ggyb, wr-efqx, wr-jbmd
