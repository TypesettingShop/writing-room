# 창 UI

선택과 입력, 출력 채널과 진행 표시의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

## QuickPick과 InputBox

```js
const fruit = await vscode.window.showQuickPick(
  [{ label: 'Apple', description: 'red' }, { label: 'Citrus', kind: vscode.QuickPickItemKind.Separator }, { label: 'Lemon' }],
  { placeHolder: 'Pick a fruit', matchOnDescription: true });
const drinks = await vscode.window.showQuickPick(['Tea', 'Coffee'], { canPickMany: true });
const name = await vscode.window.showInputBox({ prompt: 'Name the note', validateInput: v => v.length < 3 ? 'Too short' : undefined });
```

- `showQuickPick(items, options?, token?)`: 항목은 문자열 배열이거나 `QuickPickItem` 배열이고, 그 배열을 주는 약속(`Thenable`)이어도 된다. 약속이면 목록이 올 때까지 바쁨 표시가 돈다. 그사이 닫히면 결과는 `undefined`이고 나중에 온 목록은 화면에 쓰지 않는다. 고른 항목은 확장이 넘긴 바로 그 객체(문자열이면 그 문자열)로 돌아온다. `canPickMany: true`면 배열이 돌아오고 `picked: true`인 항목이 처음부터 체크되어 있다. `onDidSelectItem`은 하이라이트가 옮겨 갈 때마다 불린다. `title`, `placeHolder`, `prompt`, `matchOnDescription`, `matchOnDetail`, `ignoreFocusOut`을 받는다.
- `showInputBox(options?, token?)`: `title`, `value`, `valueSelection`, `prompt`, `placeHolder`, `password`, `ignoreFocusOut`, `validateInput`을 받는다. 검증은 문자열이나 `{ message, severity }`(`InputBoxValidationSeverity.Info`/`Warning`/`Error`)를 돌려줄 수 있고, 오류(문자열이나 `Error`)만 Enter를 막는다. 검증은 값이 바뀔 때마다와 Enter 때 다시 돌고, 그 사이 값이 바뀌었으면 예전 값의 결과는 보이지도 수락에 쓰이지도 않는다.
- `createQuickPick()`과 `createInputBox()`는 객체를 돌려준다. 속성은 upstream과 같다: 공통으로 `title`, `step`, `totalSteps`, `enabled`, `busy`, `ignoreFocusOut`, `buttons`, `show()`, `hide()`, `dispose()`, `onDidHide`, `onDidTriggerButton`. 퀵 픽은 `value`, `placeholder`, `prompt`, `items`, `canSelectMany`, `matchOnDescription`, `matchOnDetail`, `activeItems`, `selectedItems`와 `onDidChangeValue`, `onDidAccept`, `onDidChangeActive`, `onDidChangeSelection`. 입력 상자는 `value`, `valueSelection`, `placeholder`, `prompt`, `password`, `validationMessage`(문자열 또는 `{ message, severity }`)와 `onDidChangeValue`, `onDidAccept`. 버튼은 `QuickInputButtons.Back`과 `ThemeIcon` 아이콘의 버튼이다.
- 한 번에 하나의 퀵 인풋만 보인다. 새것(다른 확장의 것이나 커맨드 팔레트 포함)이 뜨면 지금 것이 숨고 `onDidHide`가 나며, `showQuickPick`/`showInputBox`는 `undefined`로 끝난다. Esc, 다른 곳 클릭, 다른 요소로 옮긴 포커스도 같다(`ignoreFocusOut`이면 포커스를 잃어도 남는다). 닫히면 포커스는 열기 전의 요소로 돌아가고, `showQuickPick`/`showInputBox`의 약속은 그다음에 풀린다.
- 걸러 내기는 워크벤치에서 한다. 낱말마다 부분 문자열로 찾고(커맨드 팔레트와 같은 규칙), 대소문자를 가리지 않는다. 설명과 상세는 `matchOnDescription`/`matchOnDetail`일 때만 본다. `alwaysShow` 항목은 걸러 내기와 상관없이 보인다. 구분선(`QuickPickItemKind.Separator`)은 고를 수 없고 그 아래 항목들의 묶음 이름이 된다. 다중 선택은 행을 클릭하거나 Ctrl+Space(macOS Cmd+Space)로 체크하고 Enter나 **OK**로 받는다.
- 항목을 바꿔도(`items`에 새 배열) 하이라이트된 항목이 새 목록에 같은 객체로 있으면 하이라이트가 그대로다. 사용자가 타자를 치면 하이라이트는 첫 결과로 간다.
- 항목은 확장 호스트에 남는다. 워크벤치에는 표시할 글과 핸들만 가고, 고른 결과는 핸들로 돌아와 원래 객체가 된다. 항목의 다른 속성(함수, 큰 데이터)은 건너가지 않는다. 확장이 `value`나 `activeItems`, `selectedItems`를 바꾼 뒤에 도착한 그 이전의 사용자 이벤트는 버린다 — 확장이 바꾼 값이 이긴다.
- 항목 1만 개를 한 번에 주어도 목록은 보이는 근처의 행만 만들고 스크롤과 화살표에 따라 더 만든다.
- 확장을 비활성화하거나 제거하면 그 확장의 퀵 인풋이 닫힌다. 비밀번호 입력 상자의 값은 화면에 가려지고 로그에 남지 않는다.

플랫폼의 `IQuickInputService`는 `pick`, `input`(기존)과 `createQuickPick`, `createInputBox`, `backButton`을 가진다. 기존 `pick`은 설명까지 걸러 낸다(`matchOnDescription: true`). 「언어 기능 제공자」의 기호 검색 화면이 이 객체 모델 위에 퀵 액세스를 얹는다.

## OutputChannel과 Output 뷰

```js
const channel = vscode.window.createOutputChannel('markdownlint');
channel.appendLine('Linting README.md');
channel.show(true); // 포커스는 그대로 둔다

const log = vscode.window.createOutputChannel('Markdown', { log: true });
log.info('Server started', { port: 6009 }); // 2026-11-19 12:24:05.123 [info] Server started {"port":6009}
log.trace('기본 수준(Info)에서는 나오지 않는다');
```

- `window.createOutputChannel(name, languageId?)`와 `window.createOutputChannel(name, { log: true })`를 지원한다. `name`은 앞뒤 공백을 지운 값이고, 비면 ``illegal argument `name`. must not be falsy``를 던진다. 빈 `languageId`는 ``illegal argument `languageId`. must not be empty``다. `languageId`는 받아 두고 쓰지 않는다.
- `OutputChannel`은 `name`, `append`, `appendLine`, `replace`, `clear`, `show(preserveFocus?)`, `show(column?, preserveFocus?)`(열은 무시한다), `hide`, `dispose`를 갖는다. 값은 VS Code의 구현처럼 문자열로 바꿔 쓴다: `append('')`는 아무것도 쓰지 않고, `append(undefined)`는 `undefined`를 쓴다.
- 확장 호스트는 쓰기를 모아 50밀리초마다, 또는 모인 글이 64 KiB에 이르면 바로 보낸다. 모아도 순서는 그대로다. `clear`와 `replace`는 그 앞에 모인 쓰기를 버리고 적용하므로, 지운 글이 나중에 다시 나타나지 않는다. `show`와 `hide`는 모인 쓰기를 먼저 보낸다. 확장의 `activate`가 끝나면 그동안 모인 쓰기도 보낸다.
- `show()`는 그 채널을 고르고 Output 뷰를 연다. 컨테이너가 있는 곳(패널이나, 옮겼다면 사이드바)이 숨어 있으면 드러낸다. `preserveFocus`가 참이 아니면 글 영역이 포커스를 받는다. `hide()`는 Output 뷰가 보이고 그 채널을 보이고 있을 때만 그 파트를 닫는다(VS Code와 같다).
- `dispose()`한 채널은 목록에서 바로 사라진다. 그 뒤에 그 채널을 쓰면 `Channel has been closed`를 던진다(VS Code와 같다). 확장을 비활성화하거나 제거하면, 또는 확장 호스트가 멈추면 그 확장의 채널이 모두 사라지고, 남은 채널 객체에 쓰는 것은 조용히 무시된다.
- `LogOutputChannel`은 `logLevel`, `onDidChangeLogLevel`, `trace`, `debug`, `info`, `warn`, `error`를 더 갖는다. 수준은 `LogLevel.Info`이고, 그보다 낮은 줄(`trace`, `debug`)은 쓰지 않는다. 줄 앞에는 지역 시각과 수준이 붙는다: `YYYY-MM-DD HH:MM:SS.mmm [info] ...`. 수준 이름은 `trace`, `debug`, `info`, `warning`, `error`다. 덧붙인 인자는 공백으로 이어지고, 객체는 JSON으로, `Error`는 메시지로(`trace`에서는 메시지와 스택) 쓴다. `error(new Error(...))`는 스택을 쓰고, 스택이 없으면 메시지를 쓴다. 로그 채널의 `append`, `appendLine`, `replace`도 `info` 줄로 쓴다(VS Code와 같다).

### Output 뷰

- 패널의 Output 탭이다. 컨테이너와 뷰의 id는 v0.1.0의 자리표시자와 같은 `workbench.panel.output`이라 저장된 배치(고른 탭, 사이드바로 옮긴 컨테이너)가 그대로 유효하다.
- 왼쪽(좁은 곳에서는 위)의 **Output Channels** 목록(`listbox`)에서 채널을 고른다. 클릭이나 위아래 화살표, `Home`, `End`로 고른다. 목록은 이름순이고, 같은 이름의 채널이 둘 이상이면 이름 뒤에 확장의 이름(매니페스트 `displayName`, 없으면 확장 id)을 붙인다: `Language Server (Alpha)`. 이름이 같아도 확장이 다르면 채널은 따로다.
- 글 영역은 읽기 전용이고 역할은 `log`, 이름은 `Output`이다. 확장이 준 글은 텍스트로만 들어간다. 맨 아래에 있을 때만 새 출력을 따라 내려가고, 위로 올려 읽는 동안에는 그 자리에 있다.
- 뷰가 숨어 있는 동안(패널이 닫혔거나 다른 탭) 출력은 버퍼에만 쌓이고 화면은 그대로다. 뷰가 다시 보일 때 한 번에 그린다.
- 화면에는 한 줄을 10,000 코드 유닛까지만 그리고, 나머지는 `… N more characters not shown`으로 알린다(에디터의 `stopRenderingLineAfter` 기본값과 같다). 버퍼에는 한도 안에서 그대로 있다.
- **Clear Output**(`workbench.output.action.clearOutput`)은 고른 채널을 비운다. 뷰 제목 줄의 버튼과 커맨드 팔레트(**View: Clear Output**)에 있다.
- 워크벤치 코드는 `IOutputService`(`src/workbench/services/output/common/output.ts`)로 채널을 만든다: `registerChannel({ id, label, extensionId?, extensionName? })`가 `append`, `clear`, `replace`, `dispose`와 읽기용 `model`을 가진 채널을 돌려주고, `getChannel`, `getChannelDescriptors`, `getActiveChannel`, `setActiveChannel`, `showChannel(id, preserveFocus?)`, `hideChannel(id)`, `onDidRegisterChannel`, `onDidRemoveChannel`, `onActiveOutputChannel`이 있다.

### 한도

- 채널 하나는 1 MiB(1,048,576 UTF-16 코드 유닛, 줄마다 줄바꿈 하나를 1로 센다)까지 둔다. 넘으면 오래된 줄부터 버린다. 한 줄이 한도보다 길면 그 줄의 끝부분만 남긴다. 줄바꿈은 `\n`이고 그 앞의 `\r`은 버린다. 확장 호스트가 보낸 양과 상관없이 워크벤치가 이 한도를 지킨다.
- 목록에 보이는 채널 이름은 256자까지다.

## 메시지, 진행 표시, 상태 표시줄 메시지

```js
const choice = await vscode.window.showWarningMessage('Delete the note?', { modal: true, detail: 'It cannot be undone.' },
  { title: 'Delete' }, { title: 'Keep', isCloseAffordance: true });
await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting', cancellable: true },
  async (progress, token) => { progress.report({ message: 'half', increment: 50 }); /* ... */ });
vscode.window.setStatusBarMessage('$(sync~spin) Syncing', syncPromise);
```

- `showInformationMessage`, `showWarningMessage`, `showErrorMessage`는 둘째 인자로 `MessageOptions`(`modal`, `detail`)를 받는다. 고른 항목은 넘긴 그 객체로 돌아오고, 닫으면 `undefined`다.
  - 모달이 아니면 오른쪽 아래의 토스트다. 한 번에 셋까지 보이고 나머지는 차례를 기다린다. 기다리는 토스트는 보낸 쪽(확장)마다 열 개, 모두 쉰 개까지이고, 넘치면 그 쪽의 가장 오래 기다린 것부터 `undefined`로 닫힌다. 토스트에는 보낸 확장의 이름(`Source: <displayName>`)이 나온다. `detail`과 `isCloseAffordance`는 모달에서만 쓴다(VS Code와 같다).
  - `modal: true`면 대화상자(`role="dialog"`, `aria-modal="true"`)다. 떠 있는 동안 뒤의 워크벤치는 포커스와 클릭을 받지 않고, Tab은 버튼 사이를 돈다. 첫 `isCloseAffordance` 항목이 취소 버튼(맨 끝)이 되고, 없으면 `Cancel`(항목이 없으면 `OK`) 버튼이 붙는다. Esc와 취소 버튼은 닫기 항목이 있으면 그것을, 없으면 `undefined`를 돌려준다. 닫히면 포커스가 원래 자리로 돌아간다. 대화상자는 한 번에 하나이고 나머지는 차례를 기다린다.
  - 메시지와 상세는 텍스트로만 들어간다. 마크다운이나 HTML로 그리지 않는다.
- `withProgress(options, task)`: `location`이 `ProgressLocation.Notification`이면 진행 막대가 있는 토스트, `Window`면 상태 표시줄 왼쪽의 도는 아이콘과 글이다. `SourceControl`과 `{ viewId }`도 `Window`로 보인다. `progress.report({ message, increment })`의 증분은 더해져 100에서 멈추고, 증분이 오기 전에는 막대가 끝없이 돈다. 보고는 100밀리초에 한 번으로 모아 보내지만 마지막 보고는 반드시 보인다. `cancellable`이면 토스트에 **Cancel**이 있고, 누르면 토큰이 한 번 취소된다. 작업이 토큰을 무시해도 표시는 작업이 끝날 때까지 남는다. 작업이 끝나거나 던지면 표시가 사라지고, 결과나 오류는 그대로 호출자에게 간다.
- `setStatusBarMessage(text, hideAfterTimeout | hideWhenDone?)`: 상태 표시줄 왼쪽 끝에 글을 보이고 `Disposable`을 돌려준다. 시간이 지나거나 약속이 끝나거나 `dispose()`하면 사라진다. 여러 개면 가장 새것이 보이고, 그것이 사라지면 그 앞의 것이 다시 보인다.
- 아이콘 글의 `$(이름~spin)`은 어느 codicon이든 돌게 한다(사용자가 움직임 줄이기를 켜면 돌지 않는다).
- 확장을 비활성화하거나 제거하면 그 확장의 토스트, 대화상자, 진행 표시, 상태 표시줄 메시지가 사라지고 진행 중인 작업의 토큰이 취소된다.

워크벤치 쪽에는 `INotificationService`(`notify`, `info`, `warn`, `error`, `prompt`; `src/platform/notification/common/notification.ts`, 구현은 `notificationsToasts.ts`)와 `IDialogService`(`prompt`; `src/platform/dialogs/`)가 있다. 워크벤치 자신의 확인은 v0.1.0처럼 퀵 픽으로 하고, 대화상자는 확장의 모달 메시지에만 쓴다.

## Deviations from VS Code

- 퀵 픽 항목의 아이콘(`iconPath`), 항목 버튼(`buttons`, `onDidTriggerItemButton`), `resourceUri`, `keepScrollPosition`, 버튼의 `location`과 `toggle`, `showWorkspaceFolderPick`은 없다 — 범위 밖이다 (wr-x0vf.6wt).
- 걸러 내기는 낱말마다 부분 문자열을 찾는 v0.1.0의 규칙이고 VS Code의 퍼지 점수와 결과 정렬은 없다. 결과는 확장이 준 순서다 (wr-jbmd, wr-x0vf.6wt).
- 다중 선택에 "모두 선택" 체크 상자가 없다. 체크는 행 클릭과 Ctrl+Space로 한다 (wr-x0vf.6wt).
- 확장이 `value`, `activeItems`, `selectedItems`를 바꾼 뒤에 도착한, 그 이전의 사용자 이벤트는 확장에 전하지 않는다. VS Code는 늦은 이벤트도 그대로 전해 확장의 변경을 덮을 수 있다 — 오래된 비동기 응답을 받아들이지 않는다는 계약을 따른다 (wr-jbmd, wr-x0vf.6wt).
- 확장의 `hide()`는 `onDidHide`를 바로 낸다. VS Code는 워크벤치가 숨긴 뒤에 낸다 (wr-x0vf.6wt).
- `withProgress`의 `ProgressLocation.SourceControl`과 `{ viewId }`는 `Window`로 보인다. 소스 제어와 뷰 안의 진행 표시가 없다 (wr-x0vf.hyt).
- 기다리는 토스트는 보낸 쪽마다 열 개, 모두 쉰 개까지이고 넘치면 오래된 것부터 닫힌다. 알림 센터(모아 보기)와 방해 금지가 없어 닫힌 토스트는 다시 볼 수 없다 (wr-x0vf.hyt).
- 모달 메시지는 브라우저 안의 대화상자이고, 운영 체제의 대화상자를 쓰지 않는다 (wr-x0vf.hyt).
- 채널의 글은 로그 파일이 아니라 메모리의 고리 버퍼에 있다. 페이지를 새로 고치면 사라지고, 채널을 문서로 열거나 파일로 저장할 수 없다. VS Code는 채널마다 로그 파일에 쓰고 Output 뷰는 그 파일을 읽는다 — 브라우저에는 로그 디렉터리가 없고, 버퍼가 끝없이 자라지 않게 1 MiB로 묶었다 (wr-x0vf.jgz).
- `LogOutputChannel`의 수준은 늘 `Info`이고 `onDidChangeLogLevel`은 일어나지 않는다. VS Code는 `Developer: Set Log Level`과 채널별 설정을 따른다 — 수준을 고르는 UI와 설정이 이 릴리스에 없다 (wr-x0vf.jgz).
- Output 뷰는 읽기 전용 에디터가 아니라 줄의 목록이다. 문법 색, 찾기, 링크, 필터가 없고, 10,000 코드 유닛보다 긴 줄은 화면에서 잘린다. 채널은 드롭다운이 아니라 목록(`listbox`)에서 고른다 — 에디터와 링크는 범위 밖이고, 콤보 상자는 커맨드 팔레트와 이름이 겹친다 (wr-x0vf.jgz).
- `workbench.view.showQuietly` 설정이 없어 `show()`는 늘 뷰를 연다 (wr-x0vf.jgz).

Decided in: wr-efqx.n9k, wr-x0vf
