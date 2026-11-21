# Custom Editor

Custom Editor는 파일을 확장의 Webview로 연다. 확장은 어떤 파일 이름에 어떤 에디터를 쓸지 매니페스트에 적고(`contributes.customEditors`), 활성화할 때 그 에디터의 제공자를 등록한다(`window.registerCustomEditorProvider`). Webview 자체(오리진, 리소스, 메시지)는 [Webview](extension-api-webview.md)와 같다. 현재 공개된 API 전체는 [확장 API](extension-api.md)에 있다.

## 에디터 기여

```json
"contributes": {
  "customEditors": [
    {
      "viewType": "example.preview",
      "displayName": "Example Preview",
      "selector": [{ "filenamePattern": "*.md" }],
      "priority": "option"
    }
  ]
}
```

| 필드 | 뜻 |
| --- | --- |
| `viewType` | 에디터 id. 모든 확장을 통틀어 하나다. 같은 id를 나중에 기여한 확장의 항목은 오류로 빠진다 |
| `displayName` | "Reopen Editor With..." 목록에 보이는 이름 |
| `selector[].filenamePattern` | 파일 이름에 대는 glob(대소문자 무시). `/`가 들어 있으면 `스킴:경로` 전체에 댄다(예: `**/notes/*.md`). `*.{jpg,png}`처럼 대안을 쓸 수 있다 |
| `priority` | `default`(생략 시)는 맞는 파일을 기본으로 연다. `option`은 고를 때만 연다. `builtin`은 `default`로 다룬다 |

- 에디터마다 활성화 이벤트 `onCustomEditor:<viewType>`이 자동으로 추가된다. 매니페스트에 명시하지 않아도 해당 에디터로 파일을 열 때 확장이 활성화된다.
- 확장을 제거하면 그 에디터는 목록에서 빠지고, 열려 있던 탭은 같은 자리의 텍스트 에디터로 바뀐다.

## 어떤 에디터로 열리는가

파일을 열 때(Explorer, `vscode.open`, 링크) 에디터는 이 순서로 정해진다.

1. 설정 `workbench.editorAssociations`(glob 패턴에서 에디터 id로의 매핑)에 일치하는 항목이 있으면 해당 에디터로 연다. 더 긴 패턴이 우선한다. 알 수 없는 id는 건너뛴다. `default`는 텍스트 에디터다.
2. `default` 우선순위의 Custom Editor 중 **하나만** 일치하면 해당 에디터로 연다.
3. 그 외에는 텍스트 에디터로 연다. `default` Custom Editor가 둘 이상 일치할 때도 텍스트 에디터로 연다.

```json
"workbench.editorAssociations": {
  "*.md": "vscode.markdown.preview.editor",
  "docs/*.png": "default"
}
```

- 확장이 깨어난 뒤에도 그 `viewType`의 제공자가 없으면 파일은 텍스트 에디터로 열리고, 오른쪽 아래에 한 번 알린다.
- 텍스트 에디터가 열지 않는 파일(바이너리, 20 MiB 초과)도 Custom Editor는 연다.

## 에디터 바꾸기

- **View: Reopen Editor With...**(`workbench.action.reopenWithEditor`)는 활성 에디터의 파일을 열 수 있는 에디터(텍스트 에디터와 맞는 Custom Editor 전부)를 퀵 픽으로 보인다. 지금 에디터에는 `Active`가 붙는다. 고르면 같은 그룹, 같은 자리에서 탭이 바뀐다. 텍스트는 그대로라 저장하지 않은 글과 dirty 표시가 남는다. 자기 문서를 가진 에디터(아래)는 문서가 에디터와 함께 닫히므로, dirty하면 닫을 때처럼 저장할지 먼저 묻는다.
- 확장은 `vscode.commands.executeCommand('vscode.openWith', uri, viewType, columnOrOptions?)`로 연다. `viewType`이 `default`면 텍스트 에디터다. 셋째 인자는 뷰 열(`ViewColumn.Beside` 포함)이나 `{ viewColumn, preserveFocus }`다.
- 컨텍스트 키 `activeCustomEditorId`는 활성 에디터가 Custom Editor일 때 그 `viewType`이다(메뉴의 `when`에 쓴다).

## 텍스트 문서를 쓰는 에디터

```js
vscode.window.registerCustomEditorProvider('example.preview', {
  resolveCustomTextEditor(document, webviewPanel, token) {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = render(document.getText());
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document === document) {
        webviewPanel.webview.postMessage({ text: document.getText() });
      }
    });
  },
}, { webviewOptions: { retainContextWhenHidden: true } });
```

- `document`는 텍스트 에디터가 보는 것과 같은 `TextDocument` 객체다. 확장이 이 함수를 받을 때 그 문서는 이미 `workspace.textDocuments`에 있다.
- 고칠 때는 `workspace.applyEdit`을 쓴다. 같은 파일을 연 텍스트 에디터에 바로 보이고, 텍스트 에디터의 실행 취소로 되돌릴 수 있다.
- 탭의 점, `Ctrl+S`(macOS `Cmd+S`), 다른 이름으로 저장, 닫기 전 확인이 텍스트 에디터와 같다. 같은 파일을 보이는 다른 에디터가 남아 있으면 닫을 때 묻지 않는다(글은 그 에디터에 남는다).
- 초안도 텍스트 에디터와 같다. 텍스트 에디터 없이 Custom Editor로만 고친 파일도 새로고침 뒤 초안이 돌아오고, 뒤에 있는 탭도 시작할 때 초안을 읽어 점을 보인다([초안 백업과 새로고침](files-and-explorer.md#초안-백업과-새로고침), wr-dbo2).
- Custom Editor가 열려 있는 동안 문서는 열린 상태로 유지된다. 같은 문서의 텍스트 에디터를 닫더라도 `onDidCloseTextDocument` 이벤트는 발생하지 않으며, 둘 다 닫힐 때 발생한다.
- Custom Editor가 활성일 때 `window.activeTextEditor`는 `undefined`이고 `window.tabGroups`에는 `TabInputCustom`으로 나온다.
- 제목 없는 문서(`untitled:`)도 열 수 있다. 저장은 다른 이름으로 저장이다.

## 자기 문서를 가진 에디터

텍스트가 아닌 파일은 `CustomReadonlyEditorProvider`(보기만)나 `CustomEditorProvider`(편집)로 연다.

- `openCustomDocument(uri, openContext, token)`이 돌려준 `CustomDocument`를 `resolveCustomEditor(document, webviewPanel, token)`이 그린다. 문서는 `viewType`과 파일마다 하나라 에디터 둘이 함께 열려도 `openCustomDocument`는 한 번 불린다. 마지막 에디터가 닫히면 문서의 `dispose`가 불린다.
- 파일 내용은 확장이 `workspace.fs`로 읽고, Webview에는 `asWebviewUri`로 준다.
- `onDidChangeCustomDocument`에 `CustomDocumentEditEvent`(`undo`, `redo`가 있다)를 내면 탭이 dirty가 되고 편집이 순서대로 기록된다. 에디터가 활성일 때 **Edit: Undo**, **Edit: Redo**(`Ctrl+Z`, `Ctrl+Y`/`Ctrl+Shift+Z`, Webview 안에서 누른 키 포함)가 확장의 `undo`, `redo`를 그 순서로 부른다. Webview 안의 입력 칸, `textarea`, `contenteditable`에서 누른 이 키들은 그 칸의 실행 취소라 확장으로 가지 않는다(wr-wxe1). 저장한 지점으로 돌아오면 dirty가 풀린다. `CustomDocumentContentChangeEvent`는 실행 취소 없이 dirty만 만든다.
- 저장, 다른 이름으로 저장, 되돌리기는 `saveCustomDocument`, `saveCustomDocumentAs`, `revertCustomDocument`를 부른다. 저장이 실패하면 오른쪽 아래에 `Failed to save '<이름>': <이유>`가 뜨고 dirty가 남는다. 되돌리기는 편집 기록을 비운다.
- 백업이 없으므로 dirty한 문서가 있으면 페이지를 떠날 때 브라우저가 묻는다.

## 같은 파일을 두 번 열 때

등록 옵션 `supportsMultipleEditorsPerDocument`가 없거나 거짓이면 한 파일에 그 에디터는 하나다. 다시 열면 열린 에디터가 요청한 그룹으로 옮겨 와 앞에 나온다. 참이면 요청마다 에디터가 생기고 문서를 나눠 쓴다.

## 수명

- 해결은 탭이 처음 보일 때 한다. 해결이 끝나기 전에 탭을 닫으면 `token`이 취소되고 늦게 온 결과는 버린다. 제공자가 던지면 탭에 `The custom editor could not be opened: <이유>`가 보인다.
- 새로고침하면 Custom Editor 탭이 같은 자리에 돌아오고, 보일 때 확장을 깨워 다시 해결한다. 복원 순서는 upstream과 같다: 저장한 탭을 되살리고(`CustomEditorInputSerializer`), 탭이 보이면 설치 확장의 등록을 기다린 뒤 `onCustomEditor:<viewType>`으로 확장을 깨우고, 제공자의 `resolveCustomTextEditor`(또는 `resolveCustomEditor`)를 부른다.
- 열린 Custom Editor 탭이 텍스트 에디터로 물러서는 것은 제공자가 정말 없을 때뿐이다: `viewType`의 기여가 없어졌거나(확장 제거), 활성화가 끝났는데 제공자를 등록하지 않았을 때. 그때 탭을 텍스트 에디터로 바꾸고 `viewType`마다 페이지에 한 번 알린다. 활성화가 끝나지 않은 채 확장 호스트가 멈추면(페이지가 떠나며 호스트를 먼저 멈출 때, 호스트가 죽었을 때) 물러서지 않고 탭이 다시 기다린다. 보이는 탭은 제공자가 다시 등록될 때(**Restart Extension Host** 뒤 같은) 해결되고, 숨은 탭은 보일 때 해결된다. 그래서 앞에 보이던 Custom Editor도 새로고침 뒤 그대로 돌아온다 (wr-v108.ck3). 호스트가 멈춘 동안 파일을 새로 열면 제공자의 옵션을 알 수 없어 텍스트 에디터로 연다.
- **Restart Extension Host** 뒤에는 열린 에디터가 새 호스트에서 다시 해결된다. 자기 문서를 가진 에디터는 문서를 새로 연다. 저장하지 않은 변경이 있었으면 사라졌다고 알린다.
- 확장은 자기 매니페스트에 있는 `viewType`만, 하나에 제공자 하나만 등록할 수 있다. 어긋나면 `registerCustomEditorProvider`가 던진다.

## Deviations from VS Code

- `default` 우선순위의 에디터가 둘 이상 맞는 파일은 텍스트 에디터로 연다. VS Code는 사용자에게 묻고 답을 기억한다. `builtin` 우선순위는 `default`로 다룬다 (wr-ibv9.7gr).
- "Reopen Editor With..."는 커맨드 팔레트에만 있다. VS Code는 탭의 컨텍스트 메뉴에도 두고, 목록에 기본 에디터를 정하는 항목이 있다 (wr-ibv9.7gr).
- 처음 열 때 확장을 깨워 제공자의 옵션을 안 뒤에 탭을 연다. VS Code는 탭을 먼저 열고 해결을 나중에 한다 (wr-ibv9.7gr).
- 제공자가 패널에 준 `title`과 `iconPath`는 탭에 보이지 않는다. 탭 이름은 파일 이름이다. `webviewOptions.enableFindWidget`은 받지만 찾기가 없다 (wr-ibv9.nl3).
- Custom Editor의 Webview 상태(`getState`/`setState`)는 새로고침 뒤에 남지 않는다. 제목 없는 문서의 Custom Editor 탭은 새로고침 뒤 돌아오지 않는다 (wr-ibv9.nl3).
- 백업이 없다: `backupCustomDocument`는 불리지 않고 `openContext.backupId`와 `untitledDocumentData`는 늘 `undefined`다. 자기 문서를 가진 에디터의 dirty한 변경은 새로고침 뒤 남지 않는다. 그래서 페이지를 떠날 때 묻는다 (wr-ibv9.f1u).
- **Edit: Undo**와 **Edit: Redo**는 Custom Editor가 활성일 때만 있는 커맨드다. VS Code의 실행 취소는 모든 에디터에 걸친 하나의 기록이다 (wr-ibv9.f1u).

Decided in: wr-efqx.n9k, wr-ibv9
