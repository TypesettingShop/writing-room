# Writing Room 확장 API

## 매니페스트와 진입점

확장 디렉터리의 `package.json`에는 `name`, `publisher`, `version`이 필요하다. 식별자는 대소문자를 구분하지 않는 `publisher.name`이다. `displayName`, `icon`, `browser`, `activationEvents`와 `contributes`를 추가할 수 있다. `browser`가 있는 확장은 단일 CommonJS 파일을 제공한다. `require('vscode')`로 확장에 바인딩된 API 객체를 가져온다. 다른 모듈 의존성은 진입 파일에 번들링해야 한다.

`activate(context)`와 `deactivate()`를 내보낼 수 있다. `context.subscriptions`에 등록이 반환한 disposable을 넣으면 제거 시 정리된다. `context.extensionUri`는 확장 디렉터리를 나타낸다. `context.extension`은 `id`와 `packageJSON`을 제공한다.

기여 커맨드와 뷰에는 각각 `onCommand:<id>`, `onView:<id>`가 암묵적으로 추가된다. `*`와 `onStartupFinished`는 첫 레이아웃과 기여 등록 이후 실행된다. 확장별로 호스트가 실행되는 동안 한 번 활성화한다. 활성화가 실패하면 그 확장과 진입 파일의 URL이 로그에 남는다. 명령 팔레트에서 **Restart Extension Host**를 실행하면 기존 호스트의 등록을 정리하고 발생했던 활성화 이벤트를 새 호스트에서 재생한다.

## 기여 지점

| 키 | 항목 |
| --- | --- |
| `commands` | `command`, `title`, 선택적인 `category`, `icon`, `enablement` |
| `menus` | `commandPalette`, `editor/title`, `editor/title/context`, `view/title`, `view/item/context`에 `command`, `when?`, `group?` 등록 |
| `keybindings` | `command`, `key`, 선택적인 `mac`, `win`, `linux`, `when`, `args` |
| `viewsContainers` | `activitybar` 또는 `panel`에 `id`, `title`, `icon` 등록 |
| `views` | 컨테이너 ID 또는 `explorer` 아래에 `id`, `name`, `when?` 등록 |

`icon`은 codicon 지정자 `$(beaker)` 또는 확장 폴더 안의 상대 경로를 받는다. 메뉴에는 `commands`에서 선언한 커맨드를 넣는다. 그룹 순서는 `navigation@2`처럼 지정한다. 지원되는 컨텍스트 연산자는 `!`, `==`, `!=`, `&&`, `||`, 괄호다. 지원되지 않는 식이 있는 기여는 건너뛴다.

## 커맨드

`commands.registerCommand(command, callback, thisArg?)`가 반환하는 `Disposable`로 커맨드를 해제할 수 있다. `commands.executeCommand<T>(command, ...args)`는 처리 결과의 thenable을 반환한다. 스레드 사이를 오가는 인자와 결과는 브라우저에서 구조화 복제할 수 있어야 한다. `Disposable`과 `EventEmitter<T>`도 제공한다.

## 트리, 상태 표시줄, 메시지

- `window.registerTreeDataProvider(viewId, provider)`와 `window.createTreeView(viewId, { treeDataProvider })`로 자신의 매니페스트에 선언한 뷰를 채운다. `getChildren(element?)`과 `getTreeItem(element)`을 구현한다. `onDidChangeTreeData`에 요소를 전달하면 해당 행을 갱신하고, `undefined`를 전달하면 전체 트리를 갱신한다. `TreeItem`에는 레이블, 안정적인 `id`, 설명, 툴팁, 접힘 상태, 커맨드, `contextValue`를 줄 수 있다. `view/item/context`에서는 `viewItem` 컨텍스트 키로 항목을 구분한다.
- `window.createStatusBarItem(alignment?, priority?)`는 `text`, `tooltip`, `command`를 설정할 수 있는 항목을 반환한다. `show()`와 `hide()`로 표시를 전환하고 `dispose()`로 제거한다. 텍스트에서 `$(name)`은 codicon으로 렌더링된다.
- `window.showInformationMessage`, `showWarningMessage`, `showErrorMessage`는 문자열 또는 `{ title }` 버튼을 받는다. 고른 원래 항목으로 resolve되며 닫으면 `undefined`다. 메시지는 워크벤치 안에 쌓인다.

지원 범위는 `src/vscode-dts/vscode.d.ts`에 선언되어 있다. 트리의 사용자 요소는 Worker에 남는다. 항목을 선택하면 기존 요소를 핸들에서 복원하며, 일반 커맨드 인자는 구조화 복제한다. 트리 아이콘, 체크박스, 드래그 앤 드롭, `reveal`, 선택 이벤트, 상태 표시줄 색 지정, 모달 메시지와 Markdown 렌더링은 v0.1.0의 범위 밖이다. 확장 코드에는 `workspace`, `languages`, `env`, 설정, 편집기, 웹뷰, 확장 스토리지 API가 제공되지 않는다.

## Worker 격리

확장 코드는 워크벤치와 같은 오리진의 전용 Worker 하나에서 실행된다. 확장에는 DOM, `window`, 워크벤치의 `localStorage`와 호스트의 전용 메시지 포트가 제공되지 않는다. 앱 오리진에 대한 `fetch`와 IndexedDB는 Worker에서 사용할 수 있다. 확장들은 Worker 전역과 실행 자원을 공유하므로 동기 무한 루프는 호스트의 다른 확장도 멈춘다. 메인 스레드는 계속 응답하며 호스트를 재시작할 수 있다. 같은 문제가 있던 이벤트를 재생하면 문제가 다시 발생할 수 있다.

호스트는 진입 파일을 자격 증명과 리다이렉트 없이 최대 5 MiB까지 읽는다. CommonJS 파일 평가에는 `Function` 생성자를 쓴다. 앱을 따로 호스팅하며 CSP를 적용하는 경우 Worker 정책에서 `unsafe-eval`이 필요하다.

Decided in: wr-ggyb
