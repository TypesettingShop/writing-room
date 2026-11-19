# 창 UI

선택과 입력, 출력 채널과 진행 표시의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

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

## Deviations from VS Code

- 채널의 글은 로그 파일이 아니라 메모리의 고리 버퍼에 있다. 페이지를 새로 고치면 사라지고, 채널을 문서로 열거나 파일로 저장할 수 없다. VS Code는 채널마다 로그 파일에 쓰고 Output 뷰는 그 파일을 읽는다 — 브라우저에는 로그 디렉터리가 없고, 버퍼가 끝없이 자라지 않게 1 MiB로 묶었다 (wr-x0vf.jgz).
- `LogOutputChannel`의 수준은 늘 `Info`이고 `onDidChangeLogLevel`은 일어나지 않는다. VS Code는 `Developer: Set Log Level`과 채널별 설정을 따른다 — 수준을 고르는 UI와 설정이 이 릴리스에 없다 (wr-x0vf.jgz).
- Output 뷰는 읽기 전용 에디터가 아니라 줄의 목록이다. 문법 색, 찾기, 링크, 필터가 없고, 10,000 코드 유닛보다 긴 줄은 화면에서 잘린다. 채널은 드롭다운이 아니라 목록(`listbox`)에서 고른다 — 에디터와 링크는 범위 밖이고, 콤보 상자는 커맨드 팔레트와 이름이 겹친다 (wr-x0vf.jgz).
- `workbench.view.showQuietly` 설정이 없어 `show()`는 늘 뷰를 연다 (wr-x0vf.jgz).

Decided in: wr-efqx.n9k, wr-x0vf
