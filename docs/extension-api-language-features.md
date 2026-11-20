# 언어 기능

언어 기능 제공자와 취소 가능한 요청의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

## 한눈에

확장이 `vscode.languages.register*Provider(selector, provider)`로 제공자를 등록하면, 확장 호스트가 제공자에 핸들을 주고 메인 스레드가 그 핸들로 Monaco 제공자를 등록한다. Monaco가 묻으면 메인 스레드가 문서의 URI와 위치만 실어 확장 호스트에 묻고, 확장 호스트가 자기 사본에서 문서를 찾아 제공자를 부른다. 결과는 DTO로 건너오고 메인 스레드가 모양과 한도를 검사한 뒤 Monaco에 준다.

```js
context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'markdown' }, {
  provideHover(document, position, token) {
    const range = document.getWordRangeAtPosition(position);
    return range && new vscode.Hover(new vscode.MarkdownString('**' + document.getText(range) + '**'), range);
  },
}));
```

코드는 이음매 하나와 기능 묶음 넷이다.

| 파일 | 하는 일 |
| --- | --- |
| `src/workbench/api/common/extHostLanguageFeatures.ts`, `src/workbench/api/browser/mainThreadLanguageFeatures.ts` | 이음매: 핸들, 어댑터, 호출(`invoke`), 취소, 등록과 해제, 결과 커맨드의 참조(`CommandStore`), `languages.match`, `setLanguageConfiguration` |
| `…Completions.ts` | 완성(해결 포함), 호버, 시그니처 도움말 |
| `…Edits.ts` | 서식 셋, 코드 액션, 이름 바꾸기 |
| `…Navigation.ts` | 문서 기호, 링크, 정의류와 참조, 하이라이트, 접기, 선택 범위, 코드 렌즈, 색, 인레이 힌트, 연결 편집, 의미 토큰, `vscode.execute*Provider` 커맨드 |
| `…WorkspaceSymbols.ts` | 워크스페이스 기호와 그 레지스트리(`src/workbench/contrib/search/common/search.ts`) |
| `extHostLanguageFeaturesReceiveOnly.ts` | 받기만 하는 제공자(아래 표) |

선언은 `src/vscode-dts/vscode.languageFeatures*.d.ts`이고 upstream `vscode.d.ts`와 이름과 시그니처가 같다(`apiConformance.test.ts`가 지킨다). 새 기능 묶음은 자기 파일에서 `api`와 `$` 메서드를 내고 두 `groupFactories`에 한 줄씩 더한다.

## 호출, 취소, 수명

- 호출은 URI, 위치나 범위, 옵션만 싣는다. 문서 전체를 다시 보내지 않는다. 50 MiB를 넘어 동기화하지 않은 모델에는 제공자를 부르지 않는다.
- 좌표: API는 0 기반, Monaco는 1 기반이다. 변환은 `extHostTypeConverters.ts`(`rangeToEditor`, `rangeFromEditor`)에서 한다. 접기의 줄 번호도 같다.
- Monaco가 토큰을 취소하면 취소가 RPC를 건너 제공자의 토큰에 닿는다. 취소되면 확장 호스트는 제공자를 기다리지 않고 대체값으로 답하고, 취소 뒤에 온 결과는 캐시에 남기지 않는다.
- 수동 코드 액션의 제공자가 응답하는 동안 커서나 진단이 자동 요청을 일으키면, 응답을 처리한 뒤 현재 위치의 전구를 갱신한다. 새 수동 요청, 제공자 등록 변경, 편집기 닫기는 진행 중인 요청을 바로 취소한다.
- 한 제공자가 던지면 확장의 공개 식별자와 함께 로그하고 대체값을 준다. 다른 제공자의 결과는 그대로 나온다.
- 결과 캐시(완성 목록, 코드 액션 목록, 코드 렌즈와 링크, 인레이 힌트, 워크스페이스 기호의 답)는 확장 호스트에 id로 남고, Monaco가 목록을 버리면(위젯이 닫히거나 다시 묻는다) 풀린다. 결과의 커맨드는 확장 호스트에 남고 참조 번호만 건너간다. 메인은 호스트마다 Monaco 커맨드 하나로 그 참조를 실행한다.
- 등록은 `Disposable`, 확장의 제거, 호스트의 종료에서 풀린다. Monaco 등록 수와 캐시가 원래대로 돌아간다.
- 메인 스레드는 Monaco가 처음 로드될 때(첫 모델) 등록한다. 워크스페이스 기호는 Monaco를 기다리지 않는다.

## 편집을 내는 기능

- 선택 서식은 편집기에 포커스를 두고 `Ctrl+K`에 이어 `Ctrl+F`를 누른다(macOS는 `⌘K`에 이어 `⌘F`). 범위 서식 제공자가 있는 쓰기 가능한 편집기에서 동작한다.
- 서식: 편집은 제공자가 읽은 문서 버전을 달고 온다. Monaco가 물을 때의 버전과 다르거나 그 사이 모델이 바뀌었으면 통째로 버린다. 범위 서식은 고른 범위 밖을 건드리는 편집도 적용한다(upstream과 같다). 같은 종류의 제공자가 여럿이면 Monaco가 고른다.
- 코드 액션과 이름 바꾸기: Monaco에 편집을 주지 않는다. 확장 호스트가 「문서·에디터 API」의 묶음 편집(`$applyWorkspaceEdit`: 확장 권한, 읽기 전용, 버전 검사, 열리지 않은 파일은 열고 고치고 저장)으로 요청 때의 버전에서 적용한다. 코드 액션의 커맨드는 편집이 적용된 뒤에만 돈다. 편집이 거부되면 커맨드는 돌지 않고 "The code action could not be applied" 알림이 뜬다. 편집이 없는 액션은 고를 때 해결한다.
- 코드 액션 제공자가 받는 `context.diagnostics`는 upstream `CodeActionAdapter`처럼 확장 호스트가 가진 그 문서의 진단 가운데 요청 범위와 겹치는 것이다(커서가 진단의 시작이나 끝에 닿아도, 빈 범위의 진단도 든다. 1,000개까지). 모든 확장의 컬렉션이 가진 원래 `vscode.Diagnostic` 객체 그대로라 확장이 진단에 붙인 필드(markdownlint의 `fixInfo` 같은 것)가 살아 있다. 워크벤치의 다른 소유자 마커는 거울에서 변환한 것이다. 범위는 확장이 진단을 넣을 때의 범위로 본다. 워크벤치 마커 서비스에 없는 Monaco 자신의 언어 워커 마커(소유자는 언어 id: `json`, `css`·`scss`·`less`, `typescript`·`javascript`. HTML 워커는 마커를 만들지 않는다)만 요청에 실려 건너와, 범위와 겹치는 것이 확장 호스트 진단 뒤에 변환한 진단으로 붙는다(같은 1,000개 상한). 워크벤치가 가진 마커는 확장 호스트에 이미 있으므로 다시 보내지 않는다 (wr-v108.x26, wr-4134). 제공자가 받은 진단 객체를 고치면 그 진단을 낸 확장의 컬렉션 값도 바뀐다(upstream과 같다. 화면의 마커는 그대로다).
- 이름 바꾸기의 `prepareRename` 범위와 자리표시 글, 던진 메시지(거부 사유)가 Monaco의 입력 칸과 인라인 메시지로 간다.
- 저장할 때 서식(`editor.formatOnSave`), 저장할 때 코드 액션, 리팩터링 미리 보기, 붙여넣기 서식은 없다.

## 링크와 다른 파일로 가기

- 링크를 누르면 `IOpenerService`가 연다: `http`·`https`는 확인 뒤 새 탭, 워크스페이스 URI는 에디터(`#L줄,열` 조각은 선택), `command:` 링크는 그 확장이 매니페스트에 기여한 커맨드만.
- 정의·선언·형식 정의·구현과 참조가 다른 파일에 있으면 워크벤치가 Monaco에 등록한 에디터 오프너(`monaco.editor.registerEditorOpener`)가 `IEditorService.openEditor`로 연다. 대상이 여럿이면 Monaco의 피크가 열리고, 미리 보기는 이미 열린 모델만 된다.

## 워크스페이스 기호: Go to Symbol in Workspace

- 여는 법: 커맨드 팔레트(F1)의 "Go to Symbol in Workspace...", 키 `Ctrl+T`(macOS `Cmd+T`), 또는 퀵 인풋에 `#`를 친다. 브라우저 탭이 `Ctrl+T`를 가져가면 팔레트로 연다.
- `#` 뒤의 글을 입력이 멈추고 200 ms 뒤에 모든 제공자에 보낸다. 앞 질의는 취소되고 늦게 온 결과는 버린다. 제공자마다 결과가 오는 대로 합쳐 보이고, 10,000행을 넘으면 마지막 행에 넘친 수를 적는다. 행이 없으면 고를 수 없는 "No matching workspace symbols"가 보인다.
- 행의 설명은 `컨테이너 이름 • 워크스페이스 기준 경로`다. 고르면 해결을 지원하는 제공자는 먼저 해결하고, 범위의 시작에서 에디터를 연다. `http(s)`는 링크처럼 열고, `command:`와 파일 서비스에 없는 스킴은 안내만 한다.
- 화면을 여는 것은 확장을 활성화하지 않는다. 이미 활성화된 확장의 제공자만 묻는다.
- `vscode.executeWorkspaceSymbolProvider(query)`는 같은 레지스트리의 모든 제공자를 기다려 `SymbolInformation` 배열을 준다.

## API 커맨드

`vscode.executeDocumentSymbolProvider`, `executeLinkProvider`, `executeDefinitionProvider`, `executeReferenceProvider`, `executeHoverProvider`, `executeCompletionItemProvider`, `executeFormatDocumentProvider`, `executeFormatRangeProvider`, `executeCodeActionProvider`, `executeDocumentRenameProvider`, `executeWorkspaceSymbolProvider`. 확장 호스트에서 돌고(`ExtHostCommands.registerApiCommand`), 메인이 워크벤치 전체의 제공자를 선택자 점수 순으로 불러 DTO를 주면 API 타입의 인스턴스로 되돌린다. 던지는 제공자는 건너뛴다.

## 받기만 하는 제공자

Monaco 독립 실행형에 화면이 없는 제공자다. 등록은 받아 `Disposable`을 돌려주고 확장 호스트에 잡아 두지만 아무도 묻지 않는다. 없는 함수를 부르면 활성화가 던지므로 받는다(vscode.markdown-language-features는 활성화에서 끌어다 놓기와 붙여넣기 편집 제공자를 직접 등록한다). 표의 원천은 코드의 `receiveOnlyProviders` 목록이다.

| 함수 | 기능 |
| --- | --- |
| `registerCallHierarchyProvider` | 호출 계층 |
| `registerTypeHierarchyProvider` | 형식 계층 |
| `registerInlineValuesProvider` | 인라인 값(디버깅) |
| `registerEvaluatableExpressionProvider` | 평가할 식(디버깅) |
| `registerDocumentDropEditProvider` | 에디터에 끌어다 놓기 |
| `registerDocumentPasteEditProvider` | 편집이 있는 붙여넣기(Paste As) |
| `registerInlineCompletionItemProvider` | 인라인 완성(고스트 텍스트) |
| `registerDocumentRangeSemanticTokensProvider` | 보이는 범위의 의미 토큰 |
| `registerMultiDocumentHighlightProvider` | 여러 문서의 하이라이트(제안 API) |

관련 클래스(`CallHierarchyItem`, `TypeHierarchyItem`, `DocumentDropEdit`, `DocumentPasteEdit`, `DocumentDropOrPasteEditKind`, `InlineValueText` 등)는 upstream처럼 만들어진다. 실제로 구현할 때는 목록에서 빼고 기능 묶음에 등록한다.

## 테스트 훅

커맨드 팔레트에 없는 커맨드로 확장 호스트의 캐시 크기를 센다: `_workbench.languageFeatures.completionCacheSize`, `codeActionCacheSize`, `navigationCacheSize`, `workspaceSymbolCacheSize`. 테스트용 확장은 `test/fixtures/extensions/language-features/`(언어 `lftest`, `.lft`)이고 스펙은 `test/e2e/language-features.spec.ts`와 `test/e2e/workspace-symbols.spec.ts`다.

## Deviations from VS Code

- VS Code는 자동 상태로의 교체를 500ms 미루고 그때 진행 중인 수동 코드 액션도 취소한다. Writing Room은 수동 요청의 응답을 처리한 뒤 자동 결과를 다시 조회해, 사용자가 요청한 메뉴나 비활성 사유가 느린 제공자에서도 표시되게 한다 (wr-v2p8.i95).
- 의미 토큰은 등록과 토큰을 받지만 테마가 의미 토큰 색을 주지 않아 화면에는 보이지 않는다 (wr-c9d8.rj2).
- `vscode.executeDocumentSymbolProvider`의 결과는 `DocumentSymbol`의 하위 클래스(`location`, `containerName`이 더 있다)다. VS Code는 `SymbolInformation`의 하위 클래스를 준다 (wr-c9d8.rj2).
- API 커맨드에 열리지 않은 문서의 URI를 주면 문서를 열지 않고 빈 결과를 준다. VS Code는 문서를 연다 (wr-c9d8.rj2).
- `vscode.executeCodeActionProvider`의 컨텍스트 진단은 빈 배열이다. `vscode.executeCompletionItemProvider`의 항목에는 `command`가 없다 (wr-c9d8.rj2).
- 해결하기 전의 링크 툴팁은 "Follow link" 또는 확장이 준 툴팁이다 (wr-c9d8.rj2).
- 워크스페이스 기호 화면은 퍼지 점수 대신 퀵 인풋의 부분 문자열 걸러 내기를 쓴다. 종류 아이콘, 일치 글자 강조, 옆 그룹에서 열기가 없다. 커맨드 팔레트는 `>` 접두어 제공자가 아니고 자기 진입을 쓴다 (wr-c9d8.qq0).
- 받기만 하는 제공자 아홉은 불리지 않는다(위 표) (wr-c9d8.kxn).
- 저장할 때 서식과 코드 액션, 리팩터링 미리 보기, 붙여넣기 서식이 없다 (wr-c9d8.08x).

Decided in: wr-efqx.n9k, wr-c9d8, wr-c9d8.7u8, wr-c9d8.w6j, wr-c9d8.08x, wr-c9d8.rj2, wr-c9d8.qq0, wr-c9d8.kxn, wr-ykn8, wr-v2p8
