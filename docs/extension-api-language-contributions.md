# 언어 기여

언어 ID, 문법, 스니펫과 언어 구성의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다. 코드 없이 매니페스트만으로 언어를 더하는 확장(`vscode.markdown` 같은)은 이 세 기여로 동작한다.

## 언어: `contributes.languages`

```json
"languages": [{
  "id": "markdown",
  "aliases": ["Markdown", "markdown"],
  "extensions": [".md", ".markdown"],
  "filenames": ["README"],
  "filenamePatterns": ["*.md.txt"],
  "firstLine": "^#!markdown",
  "configuration": "./language-configuration.json"
}]
```

- `id`는 필수다. `aliases`, `extensions`, `filenames`, `filenamePatterns`, `mimetypes`는 문자열 배열, `firstLine`과 `configuration`은 문자열이다. 모양이 틀린 항목은 그 항목만 거부하고 확장의 메시지에 `contributes.languages[i].<필드>` 경로로 남긴다.
- 언어 이름은 첫 별칭이다. 별칭이 없으면 id를 쓴다.
- 같은 id를 여러 번 등록하면 하나로 합친다. 확장자, 파일 이름, 별칭은 합치고, 구성 파일은 등록 순서대로 모두 적용해 뒤의 것이 이긴다.
- Monaco가 내장한 언어(`javascript`, `markdown` 등 팔십여 개)도 등록된 언어다. 확장이 같은 id를 기여하면 내장 정의 위에 덮는다: 확장자는 합치고, 구성과 토크나이저는 확장 것이 이긴다.
- `languages.getLanguages()`는 등록된 모든 언어 id(내장과 기여)를 돌려준다. 단 첫 텍스트 모델이 생기기 전에는 기여 언어와 `plaintext`만 돌려준다(아래 Deviations).

### 언어 고르기

파일이나 제목 없는 문서의 모델을 만들 때 경로로 언어를 고른다. VS Code의 순서를 따른다.

1. 파일 이름이 `filenames`의 하나와 같다.
2. `filenamePatterns`의 패턴과 맞는 것 가운데 가장 긴 패턴. `/`가 든 패턴은 전체 경로와, 아니면 파일 이름과 맞춘다.
3. `extensions`의 확장자로 끝나는 것 가운데 가장 긴 확장자(`notes.fixture.md`는 `.md`보다 `.fixture.md`).
4. 경로로 못 고르면 첫 줄이 `firstLine` 정규식과 맞는 언어. 줄 앞의 BOM은 건너뛴다.

비교는 대소문자를 가리지 않는다. 같은 종류에서는 나중에 등록한 것이 이긴다(내장 다음 확장, 확장은 설치 순). 아무것도 아니면 `plaintext`다. `firstLine`이 정규식이 아니면 그 조건만 버리고 경고한다.

### 언어 모드

활성 텍스트 에디터가 있으면 상태 표시줄 오른쪽에 그 모델의 언어 이름이 보인다(접근 가능한 이름 `Select Language Mode`). 누르거나 커맨드 팔레트의 **Change Language Mode**(`workbench.action.editor.changeLanguageMode`, `Ctrl+K M`)를 실행하면 언어 목록이 열린다. 이름이나 `(id)`로 걸러 고르면 그 모델의 언어만 바뀐다. 고른 언어는 저장하지 않으며, 다음에 같은 파일을 열면 다시 경로로 고른다.

언어가 바뀌면 상태 표시줄, 에디터의 `editorLangId`와 `resourceLangId` 컨텍스트 키, 모델의 언어가 함께 바뀌고, 문서 API는 닫힘 다음 열림 이벤트를 낸다.

### `onLanguage` 활성화

`configuration`을 가진 언어마다 그 확장에 `onLanguage:<id>` 활성화 이벤트가 암묵적으로 더해진다(VS Code와 같다). 어떤 언어의 모델이 처음 생기거나 모델의 언어가 그 언어로 처음 바뀌면 `onLanguage:<id>`와 `onLanguage`를 낸다. 세션마다 언어 하나에 한 번이다. `plaintext` 모델은 `onLanguage:plaintext`를 내므로 `onLanguage:markdown`만 기다리는 확장은 깨어나지 않는다.

## 언어 구성

`configuration`이 가리키는 파일(보통 `language-configuration.json`)은 그 언어가 처음 쓰일 때 읽는다. 주석과 끝 쉼표를 허용하는 JSON이다.

| 필드 | 동작 |
| --- | --- |
| `comments` | `lineComment`(문자열 또는 `{ comment, noIndent }`), `blockComment`(두 문자열). 주석 토글(`Ctrl+/`, 블록 주석 키)이 쓴다 |
| `brackets`, `colorizedBracketPairs` | 두 문자열 쌍의 배열 |
| `autoClosingPairs` | 쌍 또는 `{ open, close, notIn }`. `notIn`은 `string`, `comment` 같은 토큰 종류 |
| `surroundingPairs` | 쌍 또는 `{ open, close }`. 선택을 감쌀 때 쓴다 |
| `autoCloseBefore` | 자동 닫기가 일어나는 다음 문자들 |
| `wordPattern` | 정규식 문자열 또는 `{ pattern, flags }`. `\p{...}`를 쓰는 패턴은 `flags`에 `u`가 있어야 한다 |
| `indentationRules` | `increaseIndentPattern`, `decreaseIndentPattern`(둘 다 필요), `indentNextLinePattern`, `unIndentedLinePattern` |
| `onEnterRules` | `beforeText`, `afterText`, `previousLineText`, `action`(`indent`는 `none`, `indent`, `indentOutdent`, `outdent`, `appendText`, `removeText`) |
| `folding` | `offSide`, `markers.start`, `markers.end` |

- 틀린 항목이나 컴파일되지 않는 정규식은 그 항목만 버리고 경고한다. 예를 들어 `increaseIndentPattern`이 틀리면 `indentationRules`만 빠지고 나머지 구성은 동작한다.
- 에디터가 지원하지 않는 필드(`autoClosingPairs[].beforeText`, 모르는 키)는 빼고 한 번 경고한다.
- 파일을 읽지 못하거나 JSON이 아니면 그 파일은 빈 구성이고 경고한다. 언어는 구성 없이 동작한다.
- 확장을 제거하면 그 확장의 구성이 풀린다. 다시 설치하면 다시 읽는다.

## 문법: `contributes.grammars`

```json
"grammars": [{
  "language": "markdown",
  "scopeName": "text.html.markdown",
  "path": "./syntaxes/markdown.tmLanguage.json",
  "embeddedLanguages": { "meta.embedded.block.javascript": "javascript" },
  "tokenTypes": { "meta.link.inline.markdown": "other" }
}]
```

- `scopeName`과 `path`는 필수다. `language`가 없는 문법은 다른 문법이 포함(`include`)하거나 `injectTo`로 주입할 때만 쓰인다. `tokenTypes`의 값은 `string`, `comment`, `other`다. `balancedBracketScopes`, `unbalancedBracketScopes`도 받는다.
- JSON 문법만 지원한다. 확장자가 `.json`이 아닌 문법(plist의 `.tmLanguage`)은 쓰지 않고 경고한다.
- 문법이 있는 언어가 처음 쓰일 때 TextMate 엔진(`vscode-textmate`), Oniguruma WebAssembly(`vscode-oniguruma`의 `onig.wasm`), 문법 파일을 받는다. 그 전에는 아무것도 받지 않는다. 앱의 다른 화면은 이것을 기다리지 않는다.
- 토큰 색은 현재 색 테마의 토큰 색(`tokenColors`)이다. TextMate 선택자 그대로 맞추므로 하위 선택자(`meta.embedded string`)도 동작한다. 테마가 바뀌면 새로고침 없이 다시 칠한다.
- 20,000자 이상인 줄은 토큰화하지 않고 기본 색으로 둔다. 한 줄의 토큰화가 500 ms를 넘으면 그 줄의 나머지는 기본 색이고, 다음 줄은 그 줄이 시작한 상태에서 이어진다. 긴 줄이나 느린 문법에서도 입력은 멈추지 않는다.
- `embeddedLanguages`의 구간은 그 언어로 토큰화된다. 등록되지 않은 언어 id를 가리키는 구간은 바깥 언어로 둔다. 임베디드 언어는 "요청"되지 않으므로, 그 언어의 모델이 세션에 한 번도 없었다면 기여 구성(주석, 괄호)은 읽히지 않고 `onLanguage:<임베디드 id>`도 나지 않는다(아래 Deviations).
- 같은 `scopeName`을 둘이 기여하면 나중 것이 이기고 경고한다. 한 언어에 문법이 둘이면 나중 것이 쓰인다.
- 엔진이나 WebAssembly를 받지 못하거나, 문법 파일이 없거나 깨졌으면 그 언어는 Monaco 내장 토크나이저(없으면 색 없음)로 남고 경고가 개발자 콘솔에 남는다. 에디터는 열리고 글은 보인다.
- 확장을 제거하면 그 문법을 쓰지 않는다. Monaco 내장 언어면 내장 토크나이저가 돌아온다.

앱을 따로 호스팅하며 CSP를 건다면, 확장 호스트 Worker의 `unsafe-eval`([Worker 격리](extension-api.md#worker-격리)) 말고도 페이지 정책에 `wasm-unsafe-eval`이 필요하다. Oniguruma가 WebAssembly이기 때문이다.

테스트는 내부 커맨드 `_workbench.textMate.tokenizeLine(languageId, line)`로 한 줄의 토큰과 스코프(`[{ text, scopes }]`, 문법이 없으면 `null`)를 받는다. 커맨드 팔레트에는 없다.

## 스니펫: `contributes.snippets`

```json
"snippets": [{ "language": "markdown", "path": "./snippets/markdown.code-snippets" }]
```

```json
{
  "Insert bold text": {
    "prefix": "bold",
    "body": "**${1:${TM_SELECTED_TEXT}}**$0",
    "description": "Insert bold text"
  }
}
```

- 스니펫 파일은 주석과 끝 쉼표를 허용하는 JSON이다. `prefix`는 문자열이나 문자열 배열(접두마다 항목 하나), `body`는 문자열이나 줄 배열, `description`은 선택이다. 모양이 틀린 항목만 버리고 경고한다. 한 파일에서 5,000개까지 읽는다.
- 그 언어의 완성 목록(`Ctrl+Space`, 또는 입력 중 자동)에 스니펫 종류로 나온다. 레이블 옆에 스니펫 이름이, 자세히 보기에 설명과 출처 확장 이름(`Insert bold text (Markdown Language Basics)`)이 있다. 같은 접두가 두 확장에 있으면 둘 다 보인다.
- 넣으면 탭 정지, 자리표시자, 선택지와 변수(`TM_SELECTED_TEXT` 등)가 동작한다. 글을 선택한 채 완성을 열어 고르면 선택한 글이 `TM_SELECTED_TEXT` 자리에 들어간다.
- 파일은 그 언어에서 완성이 처음 요청될 때 읽는다. 읽지 못하거나 깨진 파일은 경고하고 건너뛰며, 다른 확장의 스니펫과 언어의 다른 완성은 그대로 나온다.
- 다른 언어(예: `plaintext`)에는 나오지 않는다. 확장을 제거하면 사라진다.

## 경로와 한도

- 매니페스트가 가리키는 구성, 문법, 스니펫 경로는 그 확장의 위치 안에서만 풀린다. `../` 등으로 밖을 가리키면 그 항목을 거부하고 경고하며, 그 파일은 요청하지 않는다.
- 파일은 파일 서비스로 읽는다. URL로 설치한 확장은 자격 증명과 리다이렉트 없이, 패키지로 설치한 확장은 사용자 데이터에서 읽는다. 한 건에 8 MiB까지다.

## Deviations from VS Code

- Monaco의 내장 언어가 확장 없이 있다. VS Code는 모든 언어를 내장 확장에서 받는다. 기여 언어는 내장 정의 위에 덮이고, Monaco가 먼저 자기 구성과 토크나이저를 넣은 뒤에 기여 쪽을 넣어 기여가 이긴다 (wr-1ejz.31d).
- Monaco 내장 언어는 텍스트 에디터 패키지가 로드된 뒤에 레지스트리에 들어온다(첫 페인트에서 패키지를 받지 않으려고). 그 전에는 경로 고르기가 기여 언어와 `plaintext`만 안다. 그때 `plaintext`로 만들어진 모델(`app.js`)은 패키지가 로드되자마자 내장 언어로 바뀐다. 세션의 첫 모델이 Monaco가 모르는 기여 언어라면 같은 이유로 `plaintext`로 만들어졌다가 곧 그 언어로 바뀐다(언어 변경 이벤트가 난다) (wr-1ejz.31d).
- 같은 이유로 첫 텍스트 모델이 생기기 전에는 `languages.getLanguages()`에 Monaco 내장 언어 id가 없고, `openTextDocument({ language: 'javascript' })` 같은 호출은 알 수 없는 언어로 거부된다 (wr-1ejz.lcz).
- 모델을 만든 뒤에 기여된 언어는 이미 `plaintext`로 열린 모델에 다시 적용되지 않는다. 새로고침하거나 언어 모드로 고른다. VS Code는 다시 고른다 (wr-1ejz.lcz).
- 임베디드 언어(`embeddedLanguages`)를 만나도 그 언어를 요청하지 않는다. VS Code는 토큰화 중에 만난 언어를 요청해 확장을 활성화하고 구성을 읽는다 (wr-1ejz.lcz).
- Monaco의 `json`은 loader 없이 `onLanguage`에서 자기 모드를 비동기로 설정한다. 그 끝을 알 공개 수단이 없어, `json`에 기여한 구성이나 문법은 Monaco 쪽에 덮일 수 있다. 다른 내장 언어는 기여가 이긴다 (wr-1ejz.lcz).
- 언어 id는 Monaco에서 풀 수 없다. 확장을 제거하면 구성, 문법, 스니펫은 풀리지만 언어 id는 새로고침까지 Monaco에 남는다. 워크벤치의 언어 목록에서는 바로 빠진다 (wr-1ejz.31d).
- `autoClosingPairs`의 `beforeText`는 Monaco에 자리가 없어 빼고 경고한다. 쌍은 조건 없이 닫힌다 (wr-1ejz.31d).
- 토큰화는 메인 스레드에서 한다. VS Code는 Worker로 옮길 수 있다 (wr-1ejz.t0z).
- Monaco는 모든 언어가 토큰 색 표 하나를 쓰고 내장 토크나이저는 Monaco 테마의 색 번호를 쓴다. 그래서 Monaco에 주는 색 표는 Monaco 테마의 색 표 뒤에 문법 테마의 색을 붙인 것이다. Monaco 테마가 바뀌면(색 테마 변경 이벤트 뒤) 다시 만든다. VS Code는 모든 언어가 TextMate라 색 표가 문법 테마 하나다 (wr-1ejz.t0z).
- 스니펫 항목의 범위는 커서 앞의 단어다. VS Code는 접두가 단어 중간에서 시작하는 경우를 더 따진다. 사용자 스니펫 파일, 임베디드 언어별 스니펫, `editor.action.insertSnippet`의 목록 화면은 없다 (wr-1ejz.bav).
- `files.associations`, 내용으로 언어 추측, 언어 아이콘, `languages.setLanguageConfiguration`은 이 영역에 없다 (wr-1ejz).

Decided in: wr-efqx.n9k, wr-1ejz
