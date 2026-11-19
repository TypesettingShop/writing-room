# 테마와 뷰

테마, 색, 트리 뷰와 상태 표시줄의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

Decided in: wr-efqx.n9k

## 색 테마와 색 레지스트리

워크벤치의 색은 모두 **색 id**(`editor.background`, `list.hoverBackground` 같은 VS Code의 이름)로 등록되고, 고른 색 테마가 그 값을 정한다. 색 하나는 CSS 변수 하나가 된다. 변수 이름은 id의 점을 줄표로 바꾼 것이다: `editor.background` → `--vscode-editor-background`.

### 색 레지스트리

- `src/platform/theme/common/colorRegistry.ts`가 색을 등록한다. 색마다 테마 종류 넷(어두움, 밝음, 고대비 어두움, 고대비 밝음)의 기본값을 가진다. 기본값은 16진 색, 다른 색의 id(같은 테마에서 그 색의 값을 따른다), 또는 없음이다. 없으면 변수를 두지 않아 스타일시트의 대체값이 쓰인다.
- 내장 색은 204개다: 기본 색, 글, 버튼과 체크박스, 드롭다운과 입력, 배지·스크롤바·진행 표시, 목록과 트리, 액티비티 바, 사이드바, 에디터 그룹과 탭, 패널, 상태 표시줄, 제목 표시줄과 메뉴, 알림과 퀵 인풋, 차트, 에디터. `titleBar.iconForeground`(제목 표시줄의 제품 아이콘)만 Writing Room의 이름이고 나머지는 VS Code의 이름이다.
- 색 id는 VS Code의 `colors` 패턴(`^\w+[.\w+]*$`)을 따라야 한다(`isColorIdentifier`). 줄표, 공백, 괄호, 세미콜론이 들어갈 수 없으니 변수 이름이 선언이나 규칙을 끝낼 수 없다.
- 색 값은 16진 표기 넷만 받는다: `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`(`isHexColor`). 받은 값은 `#rrggbb`나 `#rrggbbaa`의 소문자로 바꿔 둔다.
- 워크벤치 스타일시트(`src/**/*.css`)가 `var(--vscode-…)`로 읽는 색은 모두 레지스트리에 있고 두 내장 테마에서 값을 가진다. 단위 테스트가 스타일시트를 읽어 대조한다. 색이 아닌 변수(`--vscode-editor-font-family`)만 목록으로 뺀다.

### 내장 테마

| 설정 값 | `IColorTheme.id` | 종류 |
| --- | --- | --- |
| `Writing Room Dark` (기본) | `writing-room-dark` | 어두움 |
| `Writing Room Light` | `writing-room-light` | 밝음 |

- 어두운 테마는 v0.1.0의 팔레트 그대로다. `workbench.css`가 정의하던 변수 스물한 개와, 아무도 정의하지 않던 변수에 다른 스타일시트가 준 대체값(예: `list.hoverBackground`의 `#ffffff12`)이 그 테마의 값이라 계산된 색이 v0.1.0과 같다. 이 테마에서 Monaco는 v0.1.0처럼 자기의 `vs-dark`를 그대로 쓴다.
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
- `include`는 그 파일의 폴더 기준 상대 경로이고 확장 폴더 안에서만 풀린다. 포함한 파일의 값이 먼저 들어가고 포함하는 파일의 값이 이긴다. 깊이 5까지 따라간다: 자기를 포함하는 파일은 여섯 번 읽히고 멈춘다.
- `colors`: id가 색 id가 아니거나 값이 16진 표기가 아니면 그 색만 버리고 경고한다(`red; } body{…}`, `url(…)`, `rgb(…)` 모두 버려진다). 값 `"default"`는 포함한 파일의 값을 지우고 등록된 기본값으로 돌린다.
- `tokenColors`: 배열만 읽는다. 규칙의 `scope`는 문자열이나 문자열 배열, `settings`의 `foreground`·`background`는 16진 색, `fontStyle`은 `italic`·`bold`·`underline`·`strikethrough`의 공백 목록이다. 틀린 필드는 그 필드만 버린다. 문자열(TextMate 테마 파일 경로)은 지원하지 않는다고 알린다.
- `semanticTokenColors`는 지원하지 않는다고 알리고 무시한다. 경고는 테마 하나에 스무 개까지 찍고 나머지는 개수만 알린다.
- 파일을 읽지 못하거나 JSON이 아니면 그 테마 전체가 실패하고 기본 어두운 테마가 보인다(설정은 그대로).

### 적용

- 테마 서비스(`src/workbench/services/themes/browser/workbenchThemeService.ts`)가 `IThemeService`의 실제 구현으로 등록된다.
- 테마를 적용하면 워크벤치 컨테이너(`.monaco-workbench`)에 등록된 모든 색과 테마가 준 미등록 id의 색을 CSS 변수로 걸고, 종류 클래스(`vs`, `vs-dark`, `hc-black`, `hc-light`) 하나를 단다. 밝은 종류(`vs`, `hc-light`)에서는 `color-scheme`이 `light`가 된다.
- Monaco: 기본 어두운 테마는 `vs-dark`. 그 밖의 테마는 `writing-room-theme`이라는 한 이름으로 `defineTheme`(base는 종류에 따라 `vs`/`vs-dark`/`hc-black`/`hc-light`, `inherit: true`, 테마가 준 검증된 색, `tokenColors`의 단순 범위(`comment`, `string.quoted`)를 규칙으로)한 뒤 `setTheme`한다. Monaco는 늦게 로드되므로 로드되는 순간(첫 에디터가 생기기 전)과 테마가 바뀔 때 준다.
- Monaco 적용은 `onDidColorThemeChange`보다 먼저, 같은 흐름 안에서 끝난다. TextMate 토큰화가 그 이벤트 뒤에 Monaco의 색 표를 읽고 테마의 `tokenColors` 전체로 문법 토큰을 칠한다.
- `onDidColorThemeChange`는 테마가 바뀔 때 한 번 난다. 확장 서비스는 테마가 바뀔 때마다 모든 기여를 다시 적용하는데, 내용이 같은 `themes` 기여는 아무 이벤트도 내지 않는다.
- 고른 테마의 파일은 비동기로 읽힌다. 읽는 사이 다른 테마를 고르면 늦게 온 결과는 성공이라도 버린다.

### 고르기와 물러서기

- 커맨드 `workbench.action.selectTheme`(팔레트의 `Preferences: Color Theme`, 메뉴 Preferences › Color Theme)가 퀵 픽을 연다. 테마는 light themes, dark themes, high contrast themes로 묶이고 묶음 안에서 이름 순이다. 확장 테마는 확장 이름이 설명으로 붙는다.
- 화살표로 옮기거나 입력해 강조가 바뀌면 그 테마가 미리 보인다. 미리 보기는 설정을 쓰지 않는다. Esc면 원래 테마로 돌아가고, Enter면 `workbench.colorTheme`을 쓴다.
- 설정이 가리키는 테마가 없으면(확장이 아직 등록되지 않았거나 제거되었다) 기본 어두운 테마를 보이되 설정 값은 건드리지 않는다. 그 확장이 다시 설치되면 테마가 다시 적용된다. 새로고침 때도 같은 길이다: 확장 기여가 올라오고 파일을 읽은 뒤 고른 테마가 적용된다.

### 범위 밖

파일 아이콘 테마, 제품 아이콘 테마, 의미 토큰 색, `workbench.colorCustomizations`, 운영체제의 색 구성 따라가기.

## 기여한 색과 테마 API

## 상태 표시줄 색

## 트리 뷰

## Deviations from VS Code

- 색 테마 데이터를 새로고침 사이에 캐시하지 않는다. 확장 테마를 고른 채 새로고침하면 기본 어두운 테마로 그렸다가, 확장 기여가 올라오고 파일을 읽은 뒤 바뀐다(wr-mk2j.2j5).
- 테마와 확장이 주는 색은 16진 표기 넷만 받는다. `.tmTheme`, 문자열 `tokenColors`, `semanticTokenColors`, `workbench.colorCustomizations`, 파일·제품 아이콘 테마는 지원하지 않는다(wr-mk2j.2j5).
- Monaco에는 `tokenColors`의 단순 범위만 규칙으로 간다. 기본 어두운 테마의 Monaco는 v0.1.0처럼 `vs-dark` 그대로라 에디터 배경(`#1e1e1e`)이 워크벤치의 `editor.background`(`#171b24`)와 다르다(wr-mk2j.2j5).
