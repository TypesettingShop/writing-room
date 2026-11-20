# 문서와 에디터

확장에서 워크벤치의 글을 읽고, 편집기에 표시하고, 한 문서 또는 여러 리소스를 수정하는 방법을 정리한다. 확장의 진입점과 매니페스트는 [확장 API](extension-api.md#매니페스트와-진입점)를 참고한다.

## 문서를 열어 읽기

- `workspace.openTextDocument(uri)`는 URI의 텍스트 모델을 열고 `TextDocument`를 반환한다. `workspace.openTextDocument({ language, content })`는 제목 없는 문서를 만든다. 탭에 표시하려면 `window.showTextDocument(document)`를 호출한다.
- `workspace.textDocuments`에는 확장에 공개되는 모델이 들어 있다. 같은 URI를 다시 열거나 창을 분할해도 문서 객체를 공유한다. 문서 열림은 에디터 표시보다 먼저 전달된다. `languages.setTextDocumentLanguage`로 언어를 바꾸면 같은 문서의 닫힘 이벤트에 이어 열림 이벤트가 난다.
- `getText`, `lineAt`, `offsetAt`, `positionAt`은 Worker의 문서 미러에서 읽는다. 줄, 열과 오프셋은 0부터 세며 열과 오프셋은 UTF-16 코드 유닛 기준이다. 내용 변경 이벤트에는 변경 범위, 바뀐 텍스트, 버전과 실행 취소·다시 실행 사유가 전달된다. dirty만 바뀌면 변경 목록은 비어 있다.
- `workspace.registerTextDocumentContentProvider`는 자체 스킴의 가상 문서를 제공한다. 내용이 바뀌면 제공자의 `onDidChange`에 해당 URI를 전달한다. 가상 문서의 `save()`는 `false`를 반환한다.

## 에디터에서 읽고 쓰기

- `window.activeTextEditor`는 활성 그룹의 텍스트 에디터다. Explorer나 `vscode.open`으로 연 작업 폴더 파일의 에디터도 제목 없는 문서의 에디터와 똑같이 든다. 다른 종류의 탭이 활성화되거나 파일이 오류 페인(바이너리, 20 MB 초과, 없는 파일)에 있으면 `undefined`다. `visibleTextEditors`에는 현재 표시하는 분할 에디터도 들어 있다. 선택, 옵션, 표시 범위와 뷰 열은 각 에디터의 이벤트를 구독한다.
- `window.showTextDocument(document, { viewColumn: ViewColumn.Beside, preserveFocus: true, selection })`는 옆 그룹에서 범위를 표시하고 현재 포커스를 유지한다. `revealRange`는 현재 에디터의 스크롤을 조정한다.
- `TextEditor.edit`의 콜백 안에서 편집을 모은다. 범위가 겹치면 약속을 거부한다. 그사이에 문서 버전이 바뀌면 `false`를 반환하므로 최신 문서로 편집을 다시 계산할 수 있다. `insertSnippet`은 지정한 위치나 현재 선택 영역에서 Monaco 스니펫 세션을 시작한다.
- `window.createTextEditorDecorationType(options)`로 장식 종류를 만들고 `editor.setDecorations(type, ranges)`로 해당 에디터에 적용한다. 빈 배열로 범위를 비우거나 타입을 해제해 모든 에디터에서 제거한다. 테마 색은 현재 테마에서 구하고 호버의 마크다운은 신뢰하지 않는 텍스트로 처리한다.

## 여러 리소스를 편집하고 저장하기

- `workspace.applyEdit(edit)`에서 `WorkspaceEdit`에 담은 텍스트 편집, 파일 생성·이동·삭제를 처리한다. 적용 전에 대상과 버전을 검사한다. 다른 저장소의 데이터 같은 접근 범위 밖 리소스나 오래된 버전을 포함하면 `false`를 반환한다.
- 이미 있는 파일의 텍스트를 편집하면 기본적으로 dirty 모델에 남긴다. FEDIT 텍스트 파일 서비스가 관리하는 모델은 탭이 없어도 dirty 동안 유지된다. 디스크 읽기는 기존 저장본을 보여 주며 `workspace.openTextDocument(uri)`와 이후에 연 탭에서는 변경된 초안이 보인다. 파일 작업 직후의 텍스트 편집도 해당 서비스가 모델을 만들 수 있으면 같은 경로를 쓴다.
- `{ isRefactoring: true }`이고 `files.refactoring.autoSave`가 켜진 복수 리소스 편집에서 적용 전 깨끗했던 숨은 텍스트 파일을 자동 저장할 수 있다.
- `TextDocument.save()`는 저장 성공 여부를 반환한다. 제목 없는 문서에서는 사용자가 워크스페이스 안의 저장 경로를 고른다. 성공하면 원본 문서는 닫히고 열린 탭은 같은 자리에 저장된 파일을 표시한다. 경로를 고르는 동안 열린 탭도 같은 방식으로 바뀐다. 쓰기가 끝날 때까지 탭이 없으면 원본 문서만 닫힌다. 취소하거나 쓰기에 실패하면 `false`를 반환하고 원본 글과 탭을 유지한다.
- `workspace.onWillSaveTextDocument`에서 등록한 `waitUntil`은 저장 전 작업에 쓴다. 리스너는 이벤트를 받는 동안 등록하고, 반환한 편집은 계산한 버전이 아직 현재 버전일 때만 적용된다. 한 번의 저장에 1.5초를 배정하고 세 번 실패한 리스너를 제외한다.

## 탭, 커맨드, 컨텍스트 메뉴

- `window.tabGroups.all`과 `activeTabGroup`에서 탭의 순서와 입력을 읽는다. `tabGroups.close`는 워크벤치의 닫기 경로를 사용하고 사용자가 취소하면 `false`를 반환한다.
- `commands.executeCommand`로 `vscode.open`, `revealLine`, 저장, 활성 탭 닫기와 해당 에디터의 Monaco 액션을 실행한다. `editor.action.showReferences`는 문서 URI, 위치와 참조 위치 목록을 받는다. `editor.action.rename`은 `[uri, position]`으로 대상 위치를 지정할 수 있다.
- `contributes.menus`의 `editor/context`에 항목을 등록하면 Monaco 메뉴에 표시된다. `when`은 그 에디터의 워크벤치 컨텍스트에서 평가하며 실행 시 대상 URI를 첫 인자로 전달한다.

## Deviations from VS Code

- 문서 동기화 한도는 50 MiB에 해당하는 UTF-16 코드 유닛 수다. API로 연 숨은 문서의 참조는 3분과 총 크기 한도를 적용한다. 모델을 가진 열린 탭과 dirty 파일 모델의 생명주기는 각 서비스가 관리한다.
- 텍스트 인코딩은 UTF-8이다. 브라우저의 작업공간 스킴은 `vscode-vfs`이고 `vscode.open`에서 HTTP 주소를 열거나 사용자 지정 레이블을 적용하는 경로는 없다.
- 탭 고정과 미리보기는 항상 `false`다. 일반 탭 닫기에는 그룹 서비스의 기본 포커스 규칙을 적용한다. Monaco 컨텍스트 메뉴는 확장 하위 메뉴를 `하위 메뉴: 항목` 형식으로 한 단계에 표시한다.
- 실제 파일의 숨은 dirty 모델은 FEDIT의 모델 서비스가 관리한다. 해당 서비스를 아직 등록하지 않은 빌드에서 생성·이동 직후의 편집은 파일 API의 바이트 기록 경로를 사용한다.
- `TextEditor`의 공유 핸들은 워크스페이스와 제목 없는 문서 등 공유 리소스를 쓴다. 확장 전용 저장소 쓰기에는 호출자 권한을 전달하는 `workspace.applyEdit`을 사용한다.
- 확장이 제목 없는 문서의 `TextDocument.save()`를 호출해 성공하면 열린 탭은 그 자리에서 파일 에디터가 된다. VS Code는 제목 없는 탭을 닫는다. 두 경우 모두 확장이 보던 제목 없는 문서는 닫히고 호출은 `true`를 반환한다 (wr-qd31.p3p).
- `workspace.save`, `workspace.saveAs`, `workspace.saveAll`은 지원 범위 밖이다 (wr-qd31.p3p).

Decided in: wr-efqx.n9k, wr-j641, wr-qd31
