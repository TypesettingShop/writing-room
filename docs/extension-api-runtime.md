# 확장 API 런타임

웹 확장의 상태, 활성화, 지역화와 Worker 동작을 설명한다. 선언은
[`vscode.runtime.d.ts`](../src/vscode-dts/vscode.runtime.d.ts)에 있다.

## 상태와 경로

`activate(context)`에서 `globalState`는 사용자 프로필의 상태를 읽고,
`workspaceState`는 브라우저 워크스페이스의 상태를 읽는다. 두 객체 모두
`keys()`, `get(key, defaultValue?)`, `update(key, value)`를 제공한다.
`update(key, undefined)`로 키를 지운다. 읽은 객체는 복사본이다. 값을 바꾸려면
`update`의 약속을 기다린다.

| 속성 | 값 |
| --- | --- |
| `globalStorageUri` | `vscode-userdata:/User/globalStorage/<publisher.name>` |
| `storageUri` | `vscode-userdata:/User/workspaceStorage/<workspace id>/<publisher.name>` |
| `logUri` | `vscode-userdata:/logs/<publisher.name>` |
| `extensionPath` | `extensionUri.fsPath` |
| `extensionMode` | `ExtensionMode.Production` |

경로를 받는 시점에는 폴더가 없을 수 있다. `storagePath`, `globalStoragePath`,
`logPath`는 해당 URI의 `fsPath`다. `asAbsolutePath`는 상대 경로를 이어 붙여
정규화한다. 리소스를 실제로 읽거나 쓸 때 파일 접근 범위가 적용된다.

상태는 공개 확장 ID를 붙인 키에 JSON 객체로 저장한다. 각 확장이 범위마다
256 KiB, 두 범위를 합해 모든 확장이 2 MiB를 공유한다. 한도를 넘는 쓰기는
거부하고 이전 값을 유지한다. 이미 전체 한도를 넘긴 상태에서 크기를 줄이는
쓰기는 받는다. 여러 `update`는 메인 스레드에서 순서대로 처리한다.
영속 모드에서는 다른 탭이 쓴 상태 변경도 받은 다음 읽기에 반영한다.

브라우저가 사이트 데이터를 막거나 스토리지 쓰기가 실패하는 등 탭이 메모리
모드로 전환되면, 세션에 설치한 확장과 내장 확장, 기존에 설치한 확장 모두
`update`로 두 상태를 그 탭에 저장할 수 있다. 같은 한도를 적용하고, 저장한
값은 곧바로 `get`과 `keys`에 반영한다. 새로고침하면 메모리 모드에서 쓴
값은 사라지고, 읽을 수 있는 영속 값이 있으면 그 값이 다시 보인다.

`context.secrets`는 페이지 메모리에 있다. 호스트를 재시작해도 유지되며 페이지를
새로고침하면 사라진다. 제거할 때 두 상태와 비밀, 위의 세 저장 폴더를 지운다.

## 환경과 확장 목록

`vscode.version` 기본값은 `1.148.0`이다. `vscode.env`는 앱 이름
`Writing Room`, 호스트 `web`, `UIKind.Web`, URI 스킴 `writing-room`
및 현재 확장 언어를 보고한다. `machineId`는 프로필에 저장한 무작위 ID며
`sessionId`는 페이지를 열 때마다 바뀐다. 브라우저가 저장소나 Web Locks를 막은
창, 또는 스토리지가 메모리로 물러선 탭에서는 `machineId`를 저장하지 않고 그
페이지 동안만 같은 값을 쓴다. 그래도 확장의 활성화는 막지 않는다.

`env.clipboard`는 브라우저의 읽기와 쓰기 권한을 따른다. `env.openExternal`은
HTTP, HTTPS, mailto 주소 전체를 확인 대화상자에 보이고 승인 뒤 연다.
`env.asExternalUri`는 HTTP와 HTTPS URI를 그대로 반환한다.

`extensions.all`에서 선언형 확장을 포함한 등록 목록을 얻는다. 제공하는 API 버전과
`engines.vscode`가 맞지 않는 확장은 진단만 남기며, 해당 확장의 코드와
기여는 등록하지 않는다. `getExtension`은
대소문자를 구분하지 않는다. 설치하거나 제거하면 `onDidChange`가 발생한다.
`Extension.activate()`를 기다리면 확장이 내보낸 값을 받고, `packageJSON`은
지역화 전 매니페스트의 복사본을 준다.

## 활성화와 종료

| 이벤트 | 처리 |
| --- | --- |
| `*`, `onStartupFinished` | 워크벤치 시작 때 발생 |
| `onCommand:<id>` | 명령 실행 때 발생. 명령 기여에서 암묵적으로 등록 |
| `onView:<id>` | 뷰를 열 때 발생. 뷰 기여에서 암묵적으로 등록 |
| `onLanguage:<id>` | 언어 문서가 열릴 때 발생 |
| `workspaceContains:<경로 또는 glob>` | 시작 때 워크스페이스 검사. glob은 7초까지 검사 |
| `onUri`, `onDebug*`, `onTask*`, `onNotebook*`, `onAuthenticationRequest`, `onTerminal*` | 발생하지 않음 |

다른 확장 영역은 각 영역에 공개된 활성화 이벤트를 추가할 수 있다.
`extensionDependencies`는 먼저 활성화한다. 대상이 없거나 실패하거나 의존이
순환하면 그 확장의 활성화가 실패한다. 활성화가 10초 이상 걸리면 로그를 남긴다.
활성화 중에 실행한 다른 확장의 커맨드는 대상의 활성화와 등록을 기다린다.
대상이 이미 호출자를 기다리는 경우에는 현재 등록된 커맨드를 즉시 실행하고,
등록을 찾을 수 없으면 `command not found`로 거부한다. 호스트를 재시작하면
이미 발생한 이벤트를 다시 보낸다.

제거할 때에는 `deactivate`의 약속을 최대 5초 기다린 다음
`context.subscriptions`를 정리하고 API 등록을 푼다. `deactivate`와 구독 정리가
끝날 때까지 확장 API를 사용할 수 있다. 구독의 `dispose`가 API를 읽거나 새로
등록해도 되며, 정리 중에 한 등록도 마지막에 풀린다. 정리가 끝나면 그 확장의 API
호출은 `Extension '<id>' is no longer active.`로 거부된다. 정리하는 동안에도
다른 확장의 `extensions.all`과 `getExtension`에는 그 확장이 보이지 않는다.
활성화가 실패했을 때와 호스트를 끝낼 때에도 API가 살아 있는 동안 구독을
정리한다. 페이지를 떠날 때에는 호스트가 약속의 완료를 기다리지 않는다.

제거를 시작하면 그 확장은 바로 확장 목록과 활성화 대상에서 빠진다. 그 확장의
기여(설정, 커맨드, 메뉴, 뷰, 언어 등)는 호스트가 `deactivate`와 구독 정리를
끝낸 뒤에 함께 빠진다. 그래서 정리 중인 확장의 설정 리스너는 자기 설정 구역이
사라진 변경을 받지 않는다. 그 사이에는 커맨드가 팔레트에 남아 보일 수 있다.
호스트가 없거나 멈추거나 끝나면 기여는 그때 빠진다.

## 지역화

매니페스트의 표시 문자열은 `package.nls.json`의 `%키%` 항목을 참조할 수 있다.
표에는 문자열 또는 `{ "message": "...", "comment": ["..."] }`를 쓴다.
명령 ID와 설정 키는 원래 값을 유지하며 없는 번역은 원래 문자열을 표시한다.
`settings.json`의 `locale` 기본값은 `"en"`이고 변경은 다음에 워크벤치를
열 때 적용한다. 선택한 언어의 `package.nls.<언어>.json`이 기본 표의 일부를
덮어쓸 수 있다. 시작할 때 기본 번역으로 기여를 먼저 등록한다. 언어별 표는
백그라운드에서 최대 2초간 읽으며, 받은 번역으로 표시 문자열을 갱신한다.
`en-US`처럼 지역이 있는 영어에서는 기본 표에 지역별 번역을 덧붙인다.
매니페스트 번역 파일 한도는 256 KiB다.

매니페스트의 `l10n` 폴더 아래
`bundle.l10n.<언어>.json`을 최대 8 MiB까지 읽는다. 번들은 진입점을 평가하기
전에 준비한다. `vscode.l10n.t`에 영어 원문과 위치 또는 이름으로 된 자리표시자를
주면 번역이나 원문에 값을 넣는다. 번들이 없는 경우 `l10n.bundle`과
`l10n.uri`는 `undefined`다.

## 확장 리소스와 Worker

`Uri.joinPath(context.extensionUri, 'data.json')`으로 파일의 URI를 만들고
`fetch`에 전달한다. 브라우저가 바로 읽을 수 없는 스킴은 호스트가 설치된 확장
폴더의 읽기 전용 리소스로 변환한다. 경로 정규화 뒤 폴더 밖으로 나간 요청을
거부한다. blob은 건당 64 MiB, 확장당 합계 256 MiB를 사용하며 제거 또는 호스트
종료 때 해제한다.

`new Worker(Uri.joinPath(context.extensionUri, 'worker.js').toString())`로
클래식 Worker를 만든다. 교차 오리진과 패키지 저장소의 스크립트는 설치된 확장
폴더에서 읽어서 로드한다. 생성 직후의 메시지는 스크립트 준비 뒤 순서대로
전달한다. 생성한 Worker는 제거 또는 호스트 종료 때 끝난다.

## Deviations from VS Code

| 영역 | 동작 |
| --- | --- |
| 확장 제거 | VS Code는 활성화된 확장을 그 자리에서 빼지 않고 확장 호스트를 다시 시작할 때 비활성화한 뒤 기여를 바꾼다. 여기서는 호스트를 다시 시작하지 않고 그 확장만 비활성화한 뒤 기여를 뺀다(wr-eycu.4bd). |
| `globalState.setKeysForSync` | 호출을 받는다. 설정 동기화는 실행하지 않는다. |
| 환경 변수 컬렉션 | 터미널 환경에 변경을 적용하지 않는다. |
| `tasks` | 등록은 정리 가능한 객체를 돌려준다. 조회는 빈 배열, 실행은 거부, 이벤트는 발생하지 않는다. `Task`, `TaskScope`, `TaskGroup`, `CustomExecution`, `ShellExecution`, `ProcessExecution` 및 옵션 열거형은 생성과 값 참조에 사용할 수 있다. |
| 외부 URI 열기 제안 API | `window.registerExternalUriOpener`(제안 API `externalUriOpener`)는 정리 가능한 객체를 돌려준다. 등록한 열기 도구에 묻지도 맡기지도 않으며 `env.openExternal`은 그 도구를 거치지 않고 오프너 서비스로 연다. `ExternalUriOpenerPriority`는 값을 제공한다. 선언은 upstream 제안 d.ts의 시그니처를 따르며 적합성 검사의 예외 목록(`apiDeviations.json`)에 있다. |
| 노트북 | `workspace.notebookDocuments`는 빈 배열이다. 열기, 닫기, 변경, 저장 이벤트는 발생하지 않는다. `NotebookCellKind`는 값을 제공한다. |
| 워크스페이스 신뢰 | `workspace.isTrusted`는 `true`이며 신뢰 변경 이벤트는 발생하지 않는다. |
| 텔레메트리 | 항상 꺼져 있다. 로거가 호출을 받아도 보낸 사람의 함수가 실행되지 않는다. |
| 외부 API | `debug`, `scm`, `tests`, `comments`, `authentication`, `chat`, `lm`, `notebooks`는 `undefined`다. |
| Worker | 모듈 Worker와 중계 Worker 안의 상대 경로 `importScripts`는 오류로 거부한다. 호스트 자체의 `postMessage`, `close`, `importScripts`는 사용할 수 없다. |

Decided in: wr-efqx.n9k, wr-mn1x, wr-jbmd.g2y, wr-s9ew, wr-eycu.u4t, wr-eycu.4bd
