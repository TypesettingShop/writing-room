# 테마와 뷰

테마, 색, 트리 뷰와 상태 표시줄의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

Decided in: wr-efqx.n9k, wr-lnox, wr-gfge, wr-qk08

## 색 테마와 색 레지스트리

워크벤치의 색상은 모두 **색 id**(`editor.background`, `list.hoverBackground` 등 VS Code 표준 이름)로 등록되며, 선택한 색 테마가 그 값을 결정한다. 각 색상은 하나의 CSS 변수에 대응한다. 변수 이름은 id의 점을 하이픈으로 치환하여 생성한다: `editor.background` → `--vscode-editor-background`.

### 색 레지스트리

- `src/platform/theme/common/colorRegistry.ts`가 색을 등록한다. 색마다 테마 종류 넷(어두움, 밝음, 고대비 어두움, 고대비 밝음)의 기본값을 가진다. 기본값은 16진 색, 다른 색의 id(같은 테마에서 그 색의 값을 따른다), 또는 없음이다. 없으면 컨테이너에 그 변수를 `initial`로 걸어 `workbench.css`가 첫 그림을 위해 둔 어두운 값을 가리고, 스타일시트의 대체값이 쓰인다.
- 내장 색 205개에는 기본 색, 글, 버튼과 체크박스, 드롭다운과 입력, 배지·스크롤바·진행 표시, 목록과 트리, 액티비티 바, 사이드바, 에디터 그룹과 탭, 패널, 상태 표시줄, 제목 표시줄과 메뉴, 알림과 퀵 인풋, 차트, 에디터의 색이 포함된다. `titleBar.iconForeground`(제목 표시줄의 제품 아이콘)와 `markdownEditor.contentBorder`(Markdown 본문 양옆 테두리)는 Writing Room에서 추가한 이름이다.
- 에디터 그룹 사이(`editorGroup.border`), 액티비티 바(`activityBar.border`), 사이드바(`sideBar.border`), 탭 바 아래(`editorGroupHeader.tabsBorder`), 탭 사이(`tab.border`), 패널(`panel.border`), 제목 표시줄(`titleBar.border`), 상태 표시줄(`statusBar.border`)의 기본색은 내장 라이트에서 `#a2aec0`, 내장 다크에서 `#4a596e`다. 테마 파일의 `colors`에서 각 색을 지정할 수 있다. 일반 라이트·다크 계열에서 `sideBar.border`를 생략하면 `panel.border`를 따른다. 고대비에서는 이 경계들의 기본색으로 `contrastBorder`를 쓰며, 탭 바 아래는 `editorGroupHeader.tabsBorder`를 지정할 때 선이 그려진다.
- `markdownEditor.contentBorder`는 가운데 배치와 집중 모드에서 Markdown 본문 양옆의 선을 지정한다. 내장 라이트의 기본색은 `#d3dae6`, 내장 다크의 기본색은 `#313c50`이다. 두 색 모두 각 테마의 워크벤치 경계보다 연하다. 고대비 기본색은 `contrastBorder`를 따른다.
- 색 id는 VS Code의 `colors` 패턴(`^\w+[.\w+]*$`)을 따라야 한다(`isColorIdentifier`). 줄표, 공백, 괄호, 세미콜론이 들어갈 수 없으니 변수 이름이 선언이나 규칙을 끝낼 수 없다.
- 색 값은 16진 표기 넷만 받는다: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`(`isHexColor`). 받은 값은 `#rrggbb`나 `#rrggbbaa`의 소문자로 바꿔 둔다.
- 워크벤치 스타일시트(`src/**/*.css`)가 `var(--vscode-…)`로 읽는 색은 모두 레지스트리에 있고 두 내장 테마에서 값을 가진다. 단위 테스트가 스타일시트를 읽어 대조한다. 색이 아닌 변수(`--vscode-editor-font-family`)만 목록으로 뺀다.

### 내장 테마

| 설정 값 | `IColorTheme.id` | 종류 |
| --- | --- | --- |
| `Writing Room Dark` (기본) | `writing-room-dark` | 어두움 |
| `Writing Room Light` | `writing-room-light` | 밝음 |

- 어두운 테마의 배경과 전경 등은 v0.1.0 팔레트에서 왔다. `list.hoverBackground`처럼 당시 스타일시트의 대체값이던 색도 포함한다. 구조 경계는 위의 공통 기본색을 쓰고 Monaco는 `vs-dark`를 사용한다.
- 밝은 테마의 값은 Writing Room이 직접 정했다(VS Code의 테마 파일을 옮기지 않았다).
- `workbench.css`의 `.workbench` 블록에 남은 변수 스물한 개는 테마 서비스가 서기 전의 첫 그림을 위한 것이며 어두운 테마의 값과 같다(테스트가 지킨다). 그 밖의 하드코딩 색은 변수로 바뀌었다.

### `contributes.themes`

```json
{
  "contributes": {
    "themes": [
      { "label": "Paper", "uiTheme": "vs", "path": "./themes/paper.json" },
      { "id": "paper-night", "label": "Paper Night", "uiTheme": "vs-dark", "path": "./themes/night.json" }
    ]
  }
}
```

- `label`(필수), `uiTheme`(필수, `vs`·`vs-dark`·`hc-black`·`hc-light`), `path`(필수), `id`(선택)를 읽는다. 틀린 항목은 그 항목만 버리고 확장 메시지를 남긴다.
- 설정 `workbench.colorTheme`의 값은 VS Code처럼 테마의 `id`, 없으면 `label`이다. 내장 테마의 이름(`Writing Room Dark`, `Writing Room Light`)이나 앞선 확장이 이미 쓴 값은 받지 않는다.
- `path`는 확장 폴더 안의 상대 경로여야 한다. 밖을 가리키거나 절대 경로·URL이면 그 테마만 무시한다. `.tmTheme`(plist) 파일은 지원하지 않는다고 알리고 무시한다.

테마 파일은 주석과 끝 쉼표를 허용하는 JSON이다.

```jsonc
{
  "include": "./base/common.json",   // 이 파일 기준의 상대 경로
  "colors": {
    "editor.background": "#f5f0e6",
    "sideBar.background": "#efe7d8",
    "myExtension.accent": "#a0522d"  // 등록되지 않은 id도 CSS 변수가 된다
  },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#7a6a50", "fontStyle": "italic" } }
  ],
  "semanticHighlighting": false
}
```

- 한 파일은 8 MiB까지 읽는다. 파일을 읽는 길은 `IFileService` 하나다.
- `include`는 해당 파일의 폴더 기준 상대 경로이며 확장 폴더 내부에서만 참조할 수 있다. 포함 대상 파일의 값이 먼저 적용된 후 이를 포함하는 상위 파일의 값이 우선한다. 깊이 5까지 따라간다: 자기를 포함하는 파일은 여섯 번 읽히고 멈춘다.
- `colors`: id가 색 id가 아니거나 값이 16진 표기가 아니면 그 색만 버리고 경고한다(`red; } body{…}`, `url(…)`, `rgb(…)` 모두 버려진다). 값 `"default"`는 포함한 파일의 값을 지우고 등록된 기본값으로 돌린다.
- `tokenColors`: 배열만 읽는다. 규칙의 `scope`는 문자열이나 문자열 배열, `settings`의 `foreground`·`background`는 16진 색, `fontStyle`은 `italic`·`bold`·`underline`·`strikethrough`의 공백 목록이다. 틀린 필드는 그 필드만 버린다. 문자열(TextMate 테마 파일 경로)은 지원하지 않는다고 알린다.
- `semanticTokenColors`는 지원하지 않는다고 알리고 무시한다. 경고는 테마 하나에 스무 개까지 찍고 나머지는 개수만 알린다.
- 파일을 읽지 못하거나 JSON이 아니면 그 테마 전체가 실패하고 기본 어두운 테마가 보인다(설정은 그대로).

### 적용

- 테마 서비스(`src/workbench/services/themes/browser/workbenchThemeService.ts`)가 `IThemeService`의 실제 구현으로 등록된다.
- 테마를 적용하면 워크벤치 컨테이너(`.monaco-workbench`)에 등록된 모든 색과 테마가 준 미등록 id의 색을 CSS 변수로 걸고, 종류 클래스(`vs`, `vs-dark`, `hc-black`, `hc-light`) 하나를 단다. 밝은 종류(`vs`, `hc-light`)에서는 `color-scheme`이 `light`가 된다.
- Monaco: 기본 어두운 테마는 `vs-dark`. 그 밖의 테마는 `writing-room-theme`이라는 한 이름으로 `defineTheme`(base는 종류에 따라 `vs`/`vs-dark`/`hc-black`/`hc-light`, `inherit: true`, 테마가 준 검증된 색, `tokenColors`의 단순 범위(`comment`, `string.quoted`)를 규칙으로)한 뒤 `setTheme`한다. Monaco는 늦게 로드되므로 로드되는 순간(첫 에디터가 생기기 전)과 테마가 바뀔 때 준다.
- Monaco 적용은 `onDidColorThemeChange`보다 먼저, 같은 흐름 안에서 끝난다. TextMate 토큰화가 그 이벤트 뒤에 Monaco의 색 표를 읽고 테마의 `tokenColors` 전체로 문법 토큰을 칠한다.
- `onDidColorThemeChange`는 테마가 변경될 때 한 번 발생한다. 확장 서비스는 테마가 변경될 때마다 모든 기여를 다시 적용하지만, 내용이 동일한 `themes` 기여는 아무런 이벤트도 발생시키지 않는다. 적용 도중 테마가 바뀌면 현재 작업이 끝난 뒤 새 테마로 다시 적용하고 그 결과를 한 번 전달한다. 재적용은 최초 적용을 포함해 최대 4회까지만 시도하며, 상태가 안정되지 않으면 콘솔에 경고를 남기고 중단한다.
- 고른 테마의 파일은 비동기로 읽힌다. 읽는 사이 다른 테마를 고르면 늦게 온 결과는 성공이라도 버린다.

### 고르기와 물러서기

- 커맨드 `workbench.action.selectTheme`(팔레트의 `Preferences: Color Theme`, 메뉴 Preferences › Color Theme)가 퀵 픽을 연다. 테마는 light themes, dark themes, high contrast themes로 묶이고 묶음 안에서 이름 순이다. 확장 테마는 확장 이름이 설명으로 붙는다.
- 화살표로 옮기거나 입력해 강조가 바뀌면 그 테마가 미리 보인다. 미리 보기는 설정을 쓰지 않는다. Esc면 원래 테마로 돌아가고, Enter면 `workbench.colorTheme`을 쓴다.
- 설정이 가리키는 테마가 없으면(확장이 아직 등록되지 않았거나 제거되었다) 기본 어두운 테마를 보이되 설정 값은 건드리지 않는다. 그 확장이 다시 설치되면 테마가 다시 적용된다. 새로고침 때도 같은 길이다: 확장 기여가 올라오고 파일을 읽은 뒤 고른 테마가 적용된다.

### 범위 밖

파일 아이콘 테마, 제품 아이콘 테마, 의미 토큰 색, `workbench.colorCustomizations`, 운영체제의 색 구성 따라가기.

## 기여한 색과 테마 API

### `contributes.colors`

```json
{
  "contributes": {
    "colors": [
      {
        "id": "myExtension.accent",
        "description": "The accent of my views.",
        "defaults": { "dark": "#336699", "light": "#cc6633", "highContrast": "#ffff00", "highContrastLight": "#0000aa" }
      },
      {
        "id": "myExtension.follow",
        "description": "Follows the status bar.",
        "defaults": { "dark": "statusBar.background", "light": "myExtension.accent" }
      }
    ]
  }
}
```

- 항목은 `id`, `description`, `defaults`다. `defaults`에는 `dark`와 `light`가 꼭 있어야 하고, `highContrast`가 없으면 `dark`, `highContrastLight`가 없으면 `light`를 쓴다(VS Code와 같다).
- `id`는 VS Code의 패턴(`^\w+[.\w+]*$`)을 지켜야 한다: 글자, 숫자, 밑줄, 점. `my-extension.accent`처럼 줄표가 있으면 받지 않는다.
- 기본값은 16진 색(`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`)이거나 다른 색의 id다. id는 같은 테마에서 그 색의 값을 따른다(`"dark": "statusBar.background"`). 그 밖의 값(`red; } body{…}`, `url(…)`)은 그 색 전체를 버린다. VS Code처럼 `red` 같은 낱말은 색 id로 읽히므로 그런 색이 없으면 값이 없다.
- 틀린 항목은 그 항목만 버리고 확장 메시지(오류)를 남긴다. 워크벤치가 이미 등록한 id나 앞선 확장이 등록한 id는 받지 않는다.
- 확장이 기여한 색은 레지스트리에 등록되어 모든 테마에서 CSS 변수(`--vscode-myExtension-accent`)로 노출된다. 테마 파일이 해당 id의 값을 정의하면 테마의 값이 우선한다. 확장을 제거하면 등록된 색과 변수도 함께 제거된다.
- 확장 서비스가 테마가 바뀔 때마다 기여를 다시 적용해도, 내용이 같으면 레지스트리는 바뀌지 않는다.

### `ThemeColor`

- `new vscode.ThemeColor('myExtension.accent')`는 색 id를 가리킨다. 상태 표시줄 항목처럼 색을 받는 자리에 주면 워크벤치는 그 색의 CSS 변수(`var(--vscode-myExtension-accent)`)를 건다. 그래서 테마가 바뀌면 다시 풀린다. id가 색 id 패턴이 아니면 무시한다.

### `window.activeColorTheme`과 `onDidChangeActiveColorTheme`

```js
const kindName = { 1: 'light', 2: 'dark', 3: 'high contrast', 4: 'high contrast light' };
item.text = 'Theme: ' + kindName[vscode.window.activeColorTheme.kind];
context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(theme => {
  item.text = 'Theme: ' + kindName[theme.kind];
}));
```

- `ColorThemeKind`는 `Light` 1, `Dark` 2, `HighContrast` 3, `HighContrastLight` 4다. 종류는 테마의 `uiTheme`(`vs`, `vs-dark`, `hc-black`, `hc-light`)에서 온다. 내장 테마는 `Writing Room Dark`가 Dark, `Writing Room Light`가 Light다.
- `activeColorTheme`은 `kind` 하나를 가진 얼린 객체이고, 확장이 활성화되기 전에 이미 맞는 값이다(확장 호스트가 시작할 때 묻는다).
- `onDidChangeActiveColorTheme`은 종류가 바뀔 때가 아니라 **테마가 바뀔 때마다 한 번** 난다(VS Code와 같다). 동일한 종류의 다른 테마로 변경하더라도 이벤트가 발생한다. 동일한 테마를 다시 선택하는 경우에는 발생하지 않는다.
- 비활성화되거나 제거된 확장의 리스너는 더 불리지 않는다.

## 상태 표시줄 색

```js
const item = vscode.window.createStatusBarItem('build', vscode.StatusBarAlignment.Left, 90);
item.text = '$(error) Build';
item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
item.accessibilityInformation = { label: 'Build failed with 3 errors', role: 'link' };
item.tooltip = new vscode.MarkdownString('**3 errors**');
item.command = 'myExtension.showErrors';
item.show();
```

- `createStatusBarItem(id, alignment?, priority?)`: id를 주면 `item.id`가 그 값이고 워크벤치의 항목 요소는 `<확장 식별자>.<id>`(`data-entry-id`)다. 같은 id로 둘을 만들어도 두 항목이다. id 없이 만든 항목의 `item.id`는 v0.1.0처럼 호스트 안의 번호다(VS Code는 확장 식별자를 준다).
- `color`: 16진 색 문자열(네 표기만) 또는 `ThemeColor`. 문자열이 16진 색이 아니면(`red`, `rgb(…)`, `red; background: url(…)`) 색을 걸지 않는다. 확장 호스트와 메인 스레드가 모양을 거르고, 스타일에 넣기 직전에 상태 표시줄이 `isHexColor`·`isColorIdentifier`로 값을 검사한다.
- `backgroundColor`: `ThemeColor`이고 `statusBarItem.errorBackground`와 `statusBarItem.warningBackground`만 적용한다. 그 밖의 id는 설정하는 순간 버려져 `item.backgroundColor`가 `undefined`가 된다(VS Code와 같다). 배경이 걸리면 글자색은 `color`와 상관없이 짝 전경색(`statusBarItem.errorForeground`, `statusBarItem.warningForeground`)이다.
- `accessibilityInformation`: `label`이 접근 가능한 이름(`aria-label`)이 된다. 없으면 v0.1.0처럼 `name`, 그것도 없으면 확장 이름이다. `role`은 소문자 낱말(`link`, `checkbox`, `menu-item` 꼴)일 때만 건다.
- `tooltip`의 `MarkdownString`은 원문 텍스트로 `title`에 들어간다. 마크다운을 렌더하지 않고 HTML로 넣지 않는다.
- 갱신은 v0.1.0처럼 한 마이크로태스크에 모여 한 번 건너간다. 상태 표시줄 항목의 색 id(`statusBarItem.*`)는 모두 레지스트리에 있어 테마가 정할 수 있다.
- 범위 밖: 항목의 커맨드 인자 확장, 항목 숨기기 메뉴.

## 트리 뷰

`contributes.views`로 기여한 뷰에 `window.createTreeView`나 `window.registerTreeDataProvider`로 트리를 붙인다. v0.1.0의 동작(요소 단위 갱신, 전체 갱신, 컨텍스트 메뉴의 `viewItem`, 항목 커맨드의 기본 인자)은 그대로이고, 이 멤버가 아이콘·체크박스·선택·`reveal`·펼침 이벤트·제목류·드래그 앤 드롭·환영 문구를 더했다(wr-mk2j.uak).

| 표면 | 지원하는 것 |
| --- | --- |
| `TreeItem` | `label`, `id`, `description`(문자열), `tooltip`, `command`, `collapsibleState`, `contextValue`, `iconPath`, `resourceUri`, `accessibilityInformation`, `checkboxState`, 생성자 `new TreeItem(resourceUri, collapsibleState)` |
| `TreeDataProvider` | `getChildren`, `getTreeItem`, `onDidChangeTreeData`, `getParent`(`reveal`에 필요), `resolveTreeItem`(툴팁) |
| `TreeViewOptions` | `treeDataProvider`, `showCollapseAll`, `canSelectMany`, `dragAndDropController`, `manageCheckboxStateManually` |
| `TreeView` | `reveal`, `selection`, `onDidChangeSelection`, `visible`, `onDidChangeVisibility`, `onDidExpandElement`, `onDidCollapseElement`, `onDidChangeCheckboxState`, `title`, `description`, `message`, `badge`, `dispose` |
| 기여 | `contributes.viewsWelcome`(`view`, `contents`, `when`, `enablement`) |
| 타입 | `TreeItemCheckboxState`, `DataTransfer`, `DataTransferItem` |

```js
const vscode = require('vscode');

const inbox = { name: 'Inbox', children: [] };
const draft = { name: 'Draft', parent: inbox };
inbox.children.push(draft);

const view = vscode.window.createTreeView('notes.list', {
  treeDataProvider: {
    getChildren: element => element ? element.children ?? [] : [inbox],
    getParent: element => element.parent,
    getTreeItem: element => {
      const item = new vscode.TreeItem(element.name, element.children
        ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = element.name;
      item.iconPath = element.children
        ? new vscode.ThemeIcon('inbox', new vscode.ThemeColor('charts.blue'))
        : { light: vscode.Uri.joinPath(context.extensionUri, 'media/light.svg'),
            dark: vscode.Uri.joinPath(context.extensionUri, 'media/dark.svg') };
      if (!element.children) {
        item.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      }
      return item;
    },
    resolveTreeItem: item => { item.tooltip = 'Loaded on hover'; return item; },
  },
  canSelectMany: true,
  showCollapseAll: true,
});
view.onDidChangeSelection(event => console.log(event.selection[0] === draft)); // true: 원래 객체
await view.reveal(draft, { select: true, focus: true, expand: false });
view.title = 'Notebook';
view.badge = { value: 3, tooltip: '3 unread notes' };
```

### 아이콘과 레이블

- `ThemeIcon`: id가 codicon 이름 꼴(`[a-zA-Z0-9-]+`, 뒤에 `~spin`)일 때만 `codicon-…` 클래스로 그린다. 색(`ThemeIcon.color`)은 색 id 패턴을 지난 id만 `var(--vscode-…)`로 건다. 테마가 값을 주지 않는 id는 변수에 값이 없어(`initial`이거나 미등록) 행의 글자 색을 따른다. 색이 없는 `ThemeIcon`은 `icon.foreground`다.
- `Uri`와 `{ light, dark }`: 메인 스레드가 그 확장의 설치 폴더나 워크스페이스 폴더 안인지 정규화한 뒤 확인한다. 밖이면(다른 확장의 폴더, 임의의 웹 주소, `%2e%2e`로 올라가는 경로) 아이콘을 버린다. 둘 가운데 하나라도 밖이면 쌍 전체를 버린다.
- 그림은 `IFileService`로 256 KiB까지 읽고(넘으면 그리지 않는다), 확장자가 `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`인 것만 blob URL을 만들어 `<img>`로 넣는다. SVG를 문서 안에 넣지 않으므로 그림 속 스크립트나 스타일이 워크벤치에 닿지 않는다.
- 밝은 종류(`vs`, `hc-light`)의 테마에서는 `light`, 그 밖에서는 `dark`를 그린다. 테마가 바뀌면 바로 다른 쪽으로 바꾼다.
- blob URL은 그 아이콘을 쓰는 행이 없어지면(항목이 사라짐, 테마가 바뀌어 다른 쪽 그림을 씀) 다음 그리기에서 해제하고, 뷰가 닫히면 모두 해제한다. 읽기에 실패한 아이콘은 같은 행이 남아 있는 동안 다시 읽지 않는다.
- 문자열 `iconPath`(파일 시스템 경로)는 브라우저에서 뜻이 없어 무시한다.
- `resourceUri`: `label`이 없으면 그 URI의 마지막 경로 조각이 레이블이다.
- `accessibilityInformation.label`은 행의 `aria-label`이 된다.

### 선택, 펼침, 보임, `reveal`

- 행을 누르면 그 행이 선택되고(항목 커맨드가 있으면 실행), 화살표 키는 초점과 선택을 함께 옮긴다. `canSelectMany`이면 Ctrl(맥은 Cmd)+클릭으로 더하거나 빼고 Shift+클릭이나 Shift+화살표로 범위를 고른다. 선택된 행은 `aria-selected="true"`다.
- `onDidChangeSelection`, `onDidExpandElement`, `onDidCollapseElement`, `onDidChangeCheckboxState`가 주는 요소는 확장이 `getChildren`으로 준 원래 객체다. 메인 스레드는 핸들만 보내고 확장 호스트가 핸들에서 요소를 되살린다. 다른 확장은 이 뷰의 핸들로 이벤트를 일으킬 수 없다.
- 펼침 이벤트는 사용자가 항목을 펼치거나 접었을 때, `reveal` 호출로 상위 조상 항목이 펼쳐졌을 때, 그리고 Collapse All을 실행했을 때 발생한다. 제공자가 처음부터 `Expanded`로 지정한 항목은 이벤트를 발생시키지 않는다.
- `visible`과 `onDidChangeVisibility`: 뷰 본문이 화면에 크기를 가지고 있으면 보이는 것이다(다른 뷰 컨테이너로 바꾸거나 컨테이너를 패널로 옮겨 숨으면 `false`).
- `reveal(element, { select, focus, expand })`: 제공자에 `getParent`가 없으면 `Required registered TreeDataProvider to implement 'getParent' method to access 'reveal' method`로 거절한다. 있으면 `getParent`로 뿌리까지 올라간 뒤 아직 읽지 않은 조상의 자식을 읽어 핸들을 정하고, 뷰를 열어(닫혀 있으면 그 컨테이너를 보이고) 조상을 위에서부터 펼친다. 기본값은 `select: true`, `focus: false`, `expand: false`. `expand`가 `true`면 한 단, 수면 그 단수만큼(최대 3) 요소 아래를 펼친다. 부모 사슬이 돌면 오류다.
- `showCollapseAll`: 뷰 머리에 `Collapse All` 단추를 둔다.

### 제목, 설명, 메시지, 배지

- `title`의 처음 값은 매니페스트의 뷰 이름이다. 바꾸면 뷰 머리의 제목과 뷰 영역의 접근 가능한 이름이 바뀐다. 트리가 사라지면(제공자 해제, 확장 제거) 원래 이름으로 돌아간다.
- `description`은 제목 옆에 흐린 글로, `badge`(`{ value, tooltip }`)는 그 옆에 숫자로 그린다. `value`는 절댓값의 정수 부분이고 0이면 숨긴다. `tooltip`은 배지의 접근 가능한 이름이다. 모양이 틀린 배지는 무시한다.
- `message`는 트리 위에 글로 보인다. 확장이 준 글은 모두 텍스트 노드로 들어간다(HTML로 읽지 않는다). 메시지가 있으면 환영 문구를 보이지 않는다.

### 환영 문구 (`contributes.viewsWelcome`)

```json
{
  "contributes": {
    "viewsWelcome": [
      {
        "view": "notes.list",
        "contents": "No notes yet.\n[Create Note](command:notes.create)\nRead [the guide](https://example.com/guide).",
        "when": "!notes.loading"
      }
    ]
  }
}
```

- 트리에 제공자가 없거나 뿌리 항목이 하나도 없고 `message`가 비었을 때, `when`이 참인 항목의 글을 보인다. 항목이 생기면 사라진다. `when`·`enablement`가 보는 컨텍스트 키가 바뀌면 다시 판단한다.
- `contents`는 줄마다 문단이 된다. 링크 하나뿐인 줄은 단추가 된다. 글과 링크는 DOM 텍스트와 요소로만 만든다(`<b>`도 글자 그대로 보인다).
- `[글](command:id)`: 그 확장이 `contributes.commands`에 선언한 커맨드만, 인자 없이 `IOpenerService`로 실행한다. 선언하지 않은 커맨드, `command:id?…`처럼 인자가 붙은 링크, `http(s)`가 아닌 주소는 링크가 아닌 글로 남는다. `[글](https://…)`는 주소 전체를 보여 주고 확인을 받은 뒤 새 탭에서 연다.
- `enablement`가 거짓이면 단추를 끄고 링크는 눌러도 아무것도 하지 않는다. `group`은 받되 무시한다.

### 체크박스

- `checkboxState`가 있는 항목은 행 앞에 체크박스를 그린다. 수(`TreeItemCheckboxState`)나 `{ state, tooltip, accessibilityInformation }`를 받는다. 체크박스의 접근 가능한 이름은 `accessibilityInformation.label`, `tooltip`, 레이블 순으로 정한다.
- 체크박스를 누르거나 행에서 Space를 치면 상태가 바뀌고, 확장 호스트가 그 항목의 `checkboxState`를 고쳐 둔 뒤(객체 꼴이면 `state`만 바꾼다) `onDidChangeCheckboxState`로 `[원래 요소, 새 상태]` 목록을 알린다.
- `manageCheckboxStateManually`가 아니면 VS Code처럼 이어서 바뀐다: 불러온 자식들이 같은 상태가 되고, 체크박스를 가진 자식이 모두 체크면 부모도 체크, 아니면 해제다. 이어서 바뀐 항목도 같은 이벤트에 함께 들어간다. 아직 불러오지 않은 자식은 바뀌지 않는다.

### 드래그 앤 드롭

```js
const type = 'application/vnd.code.tree.notes.list';
vscode.window.createTreeView('notes.list', {
  treeDataProvider,
  dragAndDropController: {
    dragMimeTypes: [type],
    dropMimeTypes: [type, 'text/plain', 'files'],
    handleDrag: (source, transfer) => transfer.set(type, new vscode.DataTransferItem(source)),
    handleDrop: async (target, transfer) => {
      const moved = transfer.get(type)?.value;      // handleDrag가 넣은 배열 그 자체
      const file = transfer.get('application/octet-stream')?.asFile();
      if (file) { console.log(file.name, (await file.data()).length); }
    },
  },
});
```

- `dragAndDropController`가 있는 트리의 행은 끌 수 있다. 끄는 항목은 그 행이 선택에 들어 있으면 선택 전체, 아니면 그 행이다.
- 드래그를 시작하면 바로 `handleDrag(원래 요소들, dataTransfer, token)`을 부른다. 채운 `DataTransfer`는 드래그가 끝날 때까지 확장 호스트에 남는다.
- 드롭을 받는 트리는 `handleDrop`이 있어야 하고, 같은 뷰에서 온 드래그, `dropMimeTypes`에 끈 트리의 `application/vnd.code.tree.<뷰 id 소문자>`나 그 트리의 `dragMimeTypes`가 든 드래그, 또는 바깥에서 온 드래그 가운데 `dropMimeTypes`에 든 형식(파일은 `files`나 그 파일의 형식)이 있는 것만 받는다. 받을 수 있는 동안 아래 행(빈 곳이면 트리 전체)에 `list.dropBackground` 색이 칠해진다.
- `handleDrop(대상 요소, dataTransfer, token)`의 `dataTransfer`에는 `application/vnd.code.tree.<원본 뷰>`(값은 `{"id", "itemHandles"}` JSON)이 늘 있고, 같은 확장의 트리에서 온 드래그면 `handleDrag`가 넣은 항목이 **값 그대로**(같은 객체) 들어 있다. 다른 확장의 트리에서 온 드래그는 그 항목의 `asString()` 결과 문자열만, 받는 트리의 `dropMimeTypes`에 든 형식만 받는다. 글로 바꿀 수 없는 값(서로 가리키는 객체)은 문자열 쪽에서 빠진다. 행이 아닌 빈 곳에 놓으면 대상은 `undefined`다.
- 운영체제에서 끌어온 파일은 형식(없으면 `application/octet-stream`)으로 들어가고 `asFile()`이 `{ name, data() }`를 준다. 항목 하나당 50 MiB까지 읽으며, 넘는 파일의 `data()`는 `The file '<이름>' is too large to drop.`으로 거절한다. 문자열 형식(`text/plain` 등)은 `dropMimeTypes`에 들어 있을 때 그 글을 준다. 같은 형식의 파일을 여럿 놓아도 모두 전달된다. `get(형식)`은 그 형식의 첫 항목을 주므로 파일을 모두 받으려면 `DataTransfer`를 순회한다. `forEach`와 순회는 형식별로 묶어 같은 형식 안에서는 놓은 순서대로 내보낸다. `set(형식, 항목)`은 그 형식의 모든 항목을 새 항목 하나로 바꾼다.
- 드래그 세션은 놓기, `dragend`, Escape, `pagehide` 가운데 먼저 오는 것에서 끝난다. 창이 초점을 잃어도 세션은 플랫폼과 관계없이 유지된다. Wayland에서는 드래그 중에도 창이 초점을 잃을 수 있기 때문이다 (wr-0itb). 끝나면 드롭 표시와 창 안의 페이로드가 사라지며 놓지 않고 끝났다면 `handleDrag`의 토큰을 취소하고 확장 호스트가 쥔 값을 놓는다. 끄는 도중 그 트리의 제공자가 사라지면(확장 제거, 해제) 세션을 끝낸다.
- 트리 드래그는 자기 표식(`application/x-writing-room-tree`)과 세션을 가진다. 에디터 영역, 탭 줄, 뷰 컨테이너는 자기 표식과 진행 중인 세션만 받으므로 트리 드래그를 받지 않는다. 거꾸로 트리는 에디터·에디터 그룹·뷰 컨테이너 드래그를 표식이나 진행 중인 세션으로 알아보고, `dropMimeTypes`에 `text/plain`이 있어도 받지 않는다.

### 갱신과 안정적인 `id`

- `onDidChangeTreeData`에 `undefined`(또는 `null`)를 주는 전체 갱신 뒤에는 `id`가 같은 항목이 다른 부모 아래로 옮겨 갈 수 있다(wr-5r5z). 확장 호스트는 전체 갱신마다 세대를 올려, 이전 세대에서 다른 부모에 있던 같은 `id`를 옮긴 것으로 보고, 옛 부모를 다시 읽을 때 옮겨 간 항목을 지우지 않는다. 화면도 새 부모를 먼저 읽든 옛 부모를 먼저 읽든 그 항목을 한 번만 보인다. 새 부모를 먼저 읽으면 펼침 상태도 따라간다.
- 한 번의 목록 안에서(전체 갱신 없이) 같은 `id`가 두 부모에 나오면 v0.1.0처럼 `Tree view '<뷰>' has duplicate item id '<id>'.` 오류다.

### 범위 밖

파일 장식, 트리 필터(입력해 거르기), 여러 열, 제안 API(`activeItem`, `onDidChangeActiveItem`, 마크다운 `message`), `TreeItemLabel.highlights`의 강조 표시, `description: true`(리소스 경로를 설명으로).

## Deviations from VS Code

- 색 테마 데이터를 새로고침 사이에 캐시하지 않는다. 확장 테마를 고른 채 새로고침하면 기본 어두운 테마로 그렸다가, 확장 기여가 올라오고 파일을 읽은 뒤 바뀐다(wr-mk2j.2j5).
- 테마와 확장이 주는 색은 16진 표기 넷만 받는다. `.tmTheme`, 문자열 `tokenColors`, `semanticTokenColors`, `workbench.colorCustomizations`, 파일·제품 아이콘 테마는 지원하지 않는다(wr-mk2j.2j5).
- Monaco에는 `tokenColors`의 단순 범위만 규칙으로 간다. 기본 어두운 테마의 Monaco는 v0.1.0처럼 `vs-dark` 그대로라 에디터 배경(`#1e1e1e`)이 워크벤치의 `editor.background`(`#171b24`)와 다르다(wr-mk2j.2j5).
- `contributes.colors`가 이미 등록된 색 id(워크벤치의 것이나 앞선 확장의 것)를 다시 등록하면 VS Code는 덮어쓰지만 여기서는 받지 않고 오류를 남긴다. 확장을 제거할 때 다른 쪽의 색이 함께 빠지지 않게 하려는 것이다(wr-mk2j.2xb).
- 트리 아이콘은 그 확장의 설치 폴더와 워크스페이스 폴더 안의 `svg`·`png`·`jpg`·`jpeg`·`gif`·`webp`만, 256 KiB까지 `<img>`로 그린다. 문자열 `iconPath`(파일 경로)는 무시하고 `resourceUri`는 레이블에만 쓴다(파일 아이콘 테마, `description: true` 없음). VS Code는 아무 URI나 받는다. 브라우저에서 확장이 읽을 수 있는 범위를 지키기 위해서다(wr-mk2j.uak).
- `viewsWelcome`의 `command:` 링크는 그 확장이 선언한 커맨드만 인자 없이 실행하고, 인자가 붙은 링크와 `http(s)`가 아닌 링크는 글로 남긴다. `group`은 무시한다. 뷰 배지는 뷰 머리에만 그리고 액티비티 바의 컨테이너 아이콘에 모으지 않는다(wr-mk2j.uak).
- `resolveTreeItem`은 툴팁만 채운다(VS Code는 커맨드도 늦게 채운다). `accessibilityInformation.role`은 트리의 역할 구조를 지키려고 쓰지 않는다. `reveal`이 실패하면 VS Code처럼 로그에 남기지 않고 약속을 거절한다(wr-mk2j.uak).
- 트리 드래그 앤 드롭: 같은 확장의 트리 사이(같은 뷰만이 아니다)에서는 `handleDrag`의 값 그대로, 다른 확장의 트리에는 문자열만 간다. 운영체제 파일은 놓을 때 50 MiB까지 미리 읽는다. 트리 드래그는 에디터 영역에 놓을 수 없다(VS Code는 `text/uri-list`가 있으면 에디터로 연다). 탭과 뷰 컨테이너의 드래그와 섞이지 않게 하기 위해서다(wr-mk2j.uak).
