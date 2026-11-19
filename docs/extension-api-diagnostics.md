# 진단과 Problems

진단 컬렉션과 Problems 뷰의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

## 한눈에

확장이 `vscode.languages.createDiagnosticCollection`으로 컬렉션을 만들고 리소스마다 진단을 넣으면, 확장 호스트가 진단을 마커로 바꿔 메인 스레드로 보낸다. 메인 스레드는 값을 검사해 마커 서비스(`IMarkerService`)에 넣고, 마커 서비스의 변경이 세 곳에 나타난다.

- 에디터: 그 리소스의 텍스트 모델에 물결줄과 호버. 모델이 나중에 생겨도 생길 때 그린다.
- Problems 뷰: 리소스별 목록. 행을 누르면 그 자리로 간다.
- 상태 표시줄 왼쪽: 오류 수와 경고 수.

```js
const collection = vscode.languages.createDiagnosticCollection('markdownlint');
context.subscriptions.push(collection);
const item = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'Heading levels should only increment by one level at a time',
  vscode.DiagnosticSeverity.Warning);
item.source = 'markdownlint';
item.code = { value: 'MD001', target: vscode.Uri.parse('https://github.com/DavidAnson/markdownlint/blob/main/doc/md001.md') };
collection.set(document.uri, [item]);
```

## API

선언은 `src/vscode-dts/vscode.diagnostics.d.ts`이고 upstream `vscode.d.ts`와 이름과 시그니처가 같다.

| API | 동작 |
| --- | --- |
| `Diagnostic`, `DiagnosticSeverity`, `DiagnosticRelatedInformation`, `DiagnosticTag` | upstream과 같다. `Diagnostic`은 범위와 메시지가 없으면 `TypeError`(`range must be set`, `message must be set`), 심각도 기본값은 `Error`다. `toJSON`도 같다 |
| `languages.createDiagnosticCollection(name?)` | 이름이 없으면 `_generated_diagnostic_collection_name_#N`. 같은 확장에서 같은 이름을 또 쓰면 경고를 남기고 따로 된 컬렉션을 만든다(`name`은 그대로) |
| `DiagnosticCollection.set(uri, diagnostics)` | 그 리소스의 진단을 **바꾼다**(덧붙이지 않는다). `undefined`면 `delete`와 같다. 첫 인자가 없으면 `clear`와 같다 |
| `DiagnosticCollection.set(entries)` | 같은 리소스의 항목은 합쳐지고 `[uri, undefined]`는 그 앞의 것을 비운다. 메인 스레드로 한 번 보내고 변경 이벤트도 한 번이다 |
| `delete`, `clear`, `get`, `has`, `forEach`, 반복 | `get`은 얼린 복사본이고 없는 리소스는 빈 배열이다(upstream과 같다) |
| `dispose()` | 그 컬렉션의 마커가 모두 사라진다. 그 뒤의 호출은 `illegal state - object is disposed`를 던진다 |
| `languages.getDiagnostics(uri?)` | 모든 확장의 컬렉션과 워크벤치의 다른 소유자의 진단을 합쳐 돌려준다 |
| `languages.onDidChangeDiagnostics` | 바뀐 리소스를 50 ms 모아 한 번 낸다. 같은 리소스는 한 번만 들어 있다. 다른 소유자의 변경도 온다 |

같은 리소스를 가리키는 URI는 `toString()`이 같으면 같은 키다(`untitled:my%20notes`와 `untitled:my notes`).

### 심각도와 범위

| API `DiagnosticSeverity` | 마커 `MarkerSeverity` |
| --- | --- |
| `Error` 0 | `Error` 8 |
| `Warning` 1 | `Warning` 4 |
| `Information` 2 | `Info` 2 |
| `Hint` 3 | `Hint` 1 |

API 범위(0부터)는 마커의 줄과 열(1부터, 끝 열은 포함하지 않음)로 바뀐다. `code`가 빈 문자열이나 `0`이면 코드가 없는 것이다(upstream과 같다). 숫자 코드는 문자열이 된다.

## 소유와 수명

- 마커의 소유자는 `<확장 식별자>:<컬렉션 이름>`이다(예: `davidanson.vscode-markdownlint:markdownlint`). 두 확장이 같은 이름의 컬렉션을 써도 한쪽의 `clear`나 `dispose`가 다른 쪽을 지우지 못한다. 메인 스레드는 확장 호스트가 말한 확장 키로 소유자를 만들고, 등록되지 않은 키는 거부한다.
- 확장이 비활성화되거나 활성화에 실패하면 그 확장의 컬렉션이 모두 버려진다. 확장을 제거하거나 확장 호스트가 다시 시작되거나 멈추면 메인 스레드가 그 확장의(호스트의) 마커를 모두 지운다.
- 에디터에 그릴 때는 소유자마다 `monaco.editor.setModelMarkers(model, owner, markers)`를 부른다. 한 소유자의 변경이 다른 소유자(Monaco 자신의 `json` 검사 등)의 물결줄을 지우지 않는다. 모델이 없는 리소스의 마커는 서비스에 남아 있다가 모델이 생길 때 그려진다.

## 한도와 검사

| 무엇 | 값 |
| --- | --- |
| 리소스당 마커(한 컬렉션) | 1,000개. 넘으면 오류, 경고, 정보, 힌트 순으로 1,000개를 남기고 마지막 것의 자리에 정보 마커 `Not showing N further errors and warnings.`를 하나 더한다. 확장은 `get`으로 넣은 것을 그대로 읽는다 |
| 메시지 | 8,192 UTF-16 코드 유닛. 넘는 부분은 잘리고 `…`가 붙는다 |
| `source`, 코드, 컬렉션 이름 | 256. 컬렉션 이름이 더 길면 그 호출을 거부한다 |
| 관련 정보 | 마커 하나에 64개 |
| 줄과 열 | 1 이상 2³¹−1 이하의 정수 |

메인 스레드는 확장 호스트가 보낸 값을 믿지 않는다(`sanitizeMarker`, `checkMarkers`). 던지지 않고 고친다.

- 음수, 0, 숫자가 아닌 줄과 열은 1이 된다. 끝이 시작보다 앞이면 두 끝을 바꾼다.
- 모르는 심각도는 `Error`다. 태그는 `Unnecessary`(1), `Deprecated`(2)만 남는다.
- `code.target`은 `http`, `https`, `vscode-vfs`(워크스페이스) 스킴만 링크가 된다. 그 밖(`javascript:`, `data:`, `untitled:` 등)이나 URI가 아닌 값은 링크 없이 코드 문자열만 남는다.
- 관련 정보(`relatedInformation`)의 리소스가 `http`, `https`, `mailto`, `vsls`, `command` 스킴이면 그 항목을 버린다. Monaco의 호버가 관련 정보를 자기 열기 경로로 넘기고, 그 경로는 이 스킴들을 워크벤치의 확인 없이 브라우저에 넘긴다.
- 알려진 한계: 호버의 링크는 Monaco 자신의 열기 경로로 간다. `http(s)` 코드 링크는 워크벤치의 확인 질문 없이 새 탭으로 열리고, `vscode-vfs` 코드 링크와 다른 파일을 가리키는 관련 정보는 그 파일이 지금 에디터에 열려 있지 않으면 아무것도 하지 않는다. Monaco의 링크 열기를 워크벤치 `IOpenerService`에 잇는 일은 따로 남겼다 (wr-dt90).
- 메시지가 없는 마커, URI가 아닌 리소스의 항목은 버린다. 확장 호스트가 보내는 것보다 긴 목록(1,001개 초과)은 검사하기 전에 같은 규칙으로 줄인다.

## 마커 서비스

`src/platform/markers/common/markers.ts`의 `IMarkerService`가 워크벤치 안의 공용 이음매다. 확장이 아닌 워크벤치 코드도 자기 소유자 이름으로 마커를 넣을 수 있고, 그 마커는 Problems 뷰와 에디터에 같이 보이며 확장의 `getDiagnostics`에도 보인다.

- `changeOne(owner, resource, markers)`은 바꾸기, `changeAll(owner, data)`은 그 소유자의 전부 바꾸기, `remove(owner, resources)`, `read({ owner?, resource?, severities?, take? })`, `getStatistics()`.
- `onMarkerChanged`는 한 동기 실행 안의 변경을 마이크로태스크 한 번으로 모아, 바뀐 리소스를 한 번씩 담아 낸다. 아무것도 지우지 못한 `remove`는 이벤트를 내지 않는다.

## Problems 뷰

v0.1.0의 자리표시자를 같은 컨테이너(`workbench.panel.markers`)와 같은 뷰 id(`workbench.panel.markers.view`) 아래의 실제 뷰로 바꿨다. 컨테이너를 사이드바로 옮긴 배치와 저장된 배치는 그대로 유효하다.

- 목록은 리소스로 묶인다. 묶음의 이름은 파일 이름과 폴더다. 행은 심각도 아이콘, 메시지, `source(code)`, `[Ln 줄, Col 열]`이고 오류, 경고, 정보, 힌트 순, 같은 심각도 안에서는 위치 순이다.
- 역할은 `tree`와 `treeitem`이다. 위아래 화살표로 다니고, 왼쪽과 오른쪽 화살표로 묶음을 접고 편다. 행에서 Enter나 클릭은 그 리소스를 열고 범위를 선택한다.
- 마커가 없으면 `No problems have been detected in the workspace.`를 보인다.
- 마커 변경은 한 애니메이션 프레임에 한 번만 다시 그린다. 한 번에 그리는 행은 2,000개까지이고 넘으면 나머지 수를 알리는 행 하나를 보인다.
- 커맨드 `workbench.actions.view.problems`(**View: Focus Problems (Errors, Warnings, Infos)**)가 뷰를 열고 포커스를 준다.

## 상태 표시줄

왼쪽의 `status.problems` 항목이 오류 수와 경고 수를 보인다(`$(error) 2 $(warning) 1`). 접근 가능한 이름은 수를 읽어 준다(`2 errors, 1 warning`). 누르면 Problems를 연다. 수는 마커 서비스의 통계와 같다.

## Deviations from VS Code

- 마커 소유자에 확장 식별자가 붙는다(`<확장 식별자>:<컬렉션 이름>`). VS Code는 컬렉션 이름만 써서, 이름이 같은 두 확장의 컬렉션이 한 소유자로 섞인다 — 한 확장이 다른 확장의 마커를 지우지 못하게 했다 (wr-dt90.731).
- 같은 이름의 컬렉션이 이미 있는지는 확장마다 따로 본다. VS Code는 호스트 전체에서 본다 (wr-dt90.731).
- `set(entries)` 한 번에 보내는 마커 수에 상한(VS Code의 1,100개)을 두지 않는다. VS Code는 한 호출의 합계가 1,100개를 넘으면 뒤의 리소스를 메인 스레드로 보내지 않는다. 여기서는 리소스마다 1,000개 한도만 둔다 (wr-dt90.731).
- 메인 스레드가 메시지 길이, `source`와 코드 길이, 관련 정보 수를 자르고 `code.target`과 관련 정보 리소스의 스킴을 거른다. VS Code의 메인 스레드는 값을 그대로 받는다 (wr-jbmd, wr-dt90.731).
- `delete`로 없는 리소스를 지우거나, 워크벤치 쪽 다른 소유자의 마커가 없던 리소스가 계속 없을 때는 `onDidChangeDiagnostics`를 내지 않는다. VS Code는 이때도 낸다 (wr-dt90.731).
- `DiagnosticCollection` 메서드에 `Uri`가 아닌 값을 주면 `Illegal argument: uri`를 던진다. VS Code는 조용히 무시하거나 문자열로 다룬다 (wr-dt90.731).
- 확장이 비활성화되면 그 확장의 컬렉션이 버려진다. VS Code는 확장이 `context.subscriptions`에 넣은 경우에만 버린다 (wr-dt90.731).
- 마커 변경 이벤트는 마이크로태스크로 모은다(VS Code의 `MicrotaskEmitter`와 같다). 리소스 필터(`installResourceFilter`), `isSourceTruncated`, 마커의 `modelVersionId`와 `origin`은 없다 (wr-dt90.731).
- Problems 뷰에 필터, 표 보기, 빠른 수정, 복사가 없다 (wr-dt90.jok).

Decided in: wr-efqx.n9k, wr-dt90, wr-dt90.731, wr-dt90.jok
