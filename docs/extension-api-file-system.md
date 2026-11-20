# 파일 시스템과 워크스페이스

웹 확장에서 파일을 읽고 쓰거나, 파일 변경을 감시하거나, 자체 스킴의 파일
시스템을 제공할 때 쓰는 API다. 선언은
[`vscode.fileSystem.d.ts`](../src/vscode-dts/vscode.fileSystem.d.ts)에 정의되어 있다.

## 워크스페이스 파일 사용

`workspace.workspaceFolders[0].uri`를 기준으로 `Uri.joinPath`를 써서 파일
URI를 만든다. 브라우저 워크스페이스는
`vscode-vfs://writing-room/workspace` 폴더 하나다. `getWorkspaceFolder`는
해당 폴더 또는 그 아래에 있는 URI에서 폴더를 돌려준다. `asRelativePath`는
폴더 안의 경로를 상대 경로로 바꾸고, 밖에 있는 경로 문자열 또는 URI의
`fsPath`는 그대로 돌려준다. 폴더 루트 자체에서도 원래 경로를
돌려준다. 두 번째 인수에 `true`를 주면 상대 경로 앞에 `workspace`를
붙인다.

`workspace.fs`는 `stat`, `readDirectory`, `createDirectory`,
`readFile`, `writeFile`, `delete`, `rename`, `copy`를 제공한다.
`readFile`과 `writeFile`에 쓰는 바이트 타입은 `Uint8Array`다.
`rename`과 `copy`의 `overwrite` 기본값은 `false`다. `isWritableFileSystem`은
스킴의 제공자가 읽기 전용이면 `false`, 쓰기 가능하면 `true`, 등록 정보가
없으면 `undefined`를 돌려준다. 개별 경로의 쓰기 권한에는 다음 표가 적용된다.

## 파일 접근 범위

| URI 범위 | 읽기 | 쓰기 |
| --- | --- | --- |
| `vscode-vfs://writing-room/workspace` 아래 | 허용 | 허용 |
| 자기 `context.globalStorageUri`, `context.storageUri` 아래 | 허용 | 허용 |
| 다른 확장의 저장 폴더와 그 밖의 사용자 데이터 | 거부 | 거부 |
| 설치된 확장의 패키지 폴더 | 허용 | 거부 |
| 설치된 확장의 URL 폴더 밖에 있는 `http(s)` URI | 거부 | 거부 |
| 확장이 등록한 파일 시스템 스킴 | 제공자가 판단 | 제공자가 판단 |
| 로컬 디스크 및 파일 제공자가 없는 앱 전용 스킴 | 거부 | 거부 |

메인 스레드는 URI에서 `.`과 `..`을 정리한 뒤 접근을 판단하고, 인코딩된
경로 구분자와 제어 문자를 거부한다. 이름 바꾸기에는 출발과 도착의 쓰기
권한이 필요하다. 복사에는 출발의 읽기 권한과 도착의 쓰기 권한이
필요하다. 제공자 사이에서 임시 파일을 만들며 복사하는 경우 임시 파일의
위치에도 쓰기 권한이 필요하다.

접근이 거부되면 `FileSystemError.NoPermissions`가 발생한다. 없는 파일은
`FileNotFound`, 덮어쓸 수 없는 대상은 `FileExists`, 제공자가 사라지면
`Unavailable`로 구분할 수 있다. 예를 들어 없는 파일의 오류는
`error.code === 'FileNotFound'`이며, `name`은
`EntryNotFound (FileSystemError)`다.

## 변경 감시와 탐색

`createFileSystemWatcher('**/*.md')`의 문자열은 워크스페이스 폴더에
상대적이다. 특정 폴더를 기준으로 하려면
`new RelativePattern(folderUri, '**/.markdownlint.{json,jsonc,yml,yaml}')`을
넘긴다. `onDidCreate`, `onDidChange`, `onDidDelete`에서 변경을 받는다.
감시 생성 시 각 이벤트의 무시 플래그를 지정할 수 있다. 더 이상
필요하지 않은 감시는 `dispose()`를 호출한다. 다른 탭의 워크스페이스
변경도 전달되며, 메인 스레드는 변경을 묶어 확장 호스트로 보낸다.

`onWillCreateFiles`, `onWillDeleteFiles`, `onWillRenameFiles`의
콜백에서 `waitUntil`을 바로 호출하면 작업 전에 약속을 기다린다.
약속이 반환하는 `WorkspaceEdit`는 문서 편집 경로로 적용한다. 작업이
끝나면 해당 `onDid*Files` 이벤트가 발생한다. 이 이벤트는 Explorer와
`workspace.applyEdit`의 파일 작업에서 발생한다. VS Code와 같이
`workspace.fs` 호출에서는 발생하지 않으므로, 그 변경은 파일 감시로
관찰한다. 이름 바꾸기는 작업 이벤트 한 건이고 감시에서는 이전 경로가
삭제되고 새 경로가 생성된 것으로 전달된다.

`findFiles(include, exclude, maxResults, token)`은 워크스페이스를 너비
우선으로 걷는다. `exclude`를 생략하면 `.git`과 `node_modules`를
건너뛴다. `null`은 기본 제외를 해제한다. 제외 경로 아래는 탐색하지
않으며, 취소하면 그때까지 찾은 결과를 돌려준다.

## 자체 파일 시스템 제공

매니페스트의 `activationEvents`에 `onFileSystem:my-scheme`을 추가하고,
`activate(context)`에서
`workspace.registerFileSystemProvider('my-scheme', provider, options)`가
돌려주는 구독을 `context.subscriptions`에 넣는다. 다른 확장은
`workspace.fs.readFile(Uri.parse('my-scheme:/example.txt'))`처럼 접근한다.
이 접근에서 아직 제공자가 없으면 활성화를 기다린다.

제공자는 `onDidChangeFile`에서 변경 목록을 발행하고, `watch`에서는
해당 감시에 쓰는 자원을 정리하는 구독을 반환한다. `openTextDocument`로
제공자 파일을 처음 읽을 때도 해당 스킴의 활성화를 기다린다. 제공자가
등록되면 `vscode.open`으로 기본 텍스트 편집기에 열 수 있다. 제공자 등록을 해제하거나
확장을 제거하거나 호스트가 끝나면 대리 제공자와 감시가 정리된다. 대기
중인 제공자 호출은 `Unavailable`로 종료된다.

## Deviations from VS Code

| 동작 | Writing Room |
| --- | --- |
| 워크스페이스 | 고정 폴더 하나다. `workspaceFile`은 `undefined`이며 `updateWorkspaceFolders`는 `false`를 반환한다. 신뢰는 항상 참이고 폴더·신뢰 변경 이벤트는 발생하지 않는다. wr-8a5f.e74 |
| 파일 접근 | 브라우저 저장소와 설치 패키지, 등록한 제공자로 위의 범위를 제한한다. 읽기는 파일당 50 MiB까지 허용한다. `useTrash`를 받으면 파일을 바로 지운다. wr-8a5f.e74 |
| 탐색과 참여자 | 최대 20,000개 결과와 100,000개 항목을 검사한다. `exclude`를 생략하면 `files.exclude` 설정 대신 `.git`과 `node_modules`를 건너뛴다. 진행 중에 취소하면 빈 목록 대신 그때까지 찾은 결과를 돌려준다. 파일 작업 참여자는 5초 동안 기다린다. wr-8a5f.7bx |
| 제공자 | 자체 스킴을 Explorer의 워크스페이스로 붙이지 않는다. `isReadonly`에 `MarkdownString`을 주면 읽기 전용으로 등록한다. wr-8a5f.1ph |
| 예약 스킴 | 등록된 스킴과 `file`, `untitled`, `vscode-userdata`, `vscode-vfs`, `http`, `https`, `data`, `blob`, `webview-panel`, `vscode-webview`, `vscode-custom-editor`, `output`을 예약한다. wr-8a5f.1ph |

[확장 API 색인](extension-api.md) · [확장 런타임의 저장 경로](extension-api-runtime.md#상태와-경로)

Decided in: wr-efqx.n9k, wr-8a5f
