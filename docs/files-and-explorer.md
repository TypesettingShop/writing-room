# 파일 편집과 Explorer

파일 탐색과 열기·저장 대화상자의 지원 범위는 이 페이지에 기록한다. 현재 공개된 API와 기여는 [확장 API](extension-api.md)에 있다.

## 저장소

기본 워크스페이스는 `vscode-vfs://writing-room/workspace`다. 이름은 `workspace`이고
워크스페이스 ID는 `writing-room`이다. 처음 열면 빈 폴더로 시작한다. 브라우저가
저장소를 여는 동안에도 워크벤치는 화면을 먼저 표시한다.

같은 브라우저 프로필에서 같은 사이트 주소를 다시 열면 저장한 파일과 빈 폴더를
읽을 수 있다. 워크스페이스와 사용자 데이터는 사이트 오리진별 IndexedDB
`writing-room-files` 버전 1에 들어간다.

| 객체 저장소 | 용도 |
| --- | --- |
| `vscode-vfs` | `writing-room` 권한부의 워크스페이스 파일과 폴더 |
| `vscode-userdata` | 이후 기능에서 사용할 경로는 확장 패키지 `/extensions/`, 확장별 `/User/globalStorage/`와 `/User/workspaceStorage/`, `/logs/` |

설정 원문 `vscode-userdata:/User/settings.json`은 기존 사용자 설정 저장소에 있다.
파일 서비스는 이 경로에서의 읽기와 쓰기를 거부한다. [VS Code 웹의 설정 저장 방식](vscode-state-settings.md#33-웹-환경에서-settingsjson의-물리적-저장-위치)

### 저장 형식과 동시 편집

- 키는 정규화한 절대 경로다. 겹친 슬래시, 끝 슬래시, `.`과 `..`을 정리한
  뒤 저장 위치를 결정한다. 인코딩된 구분자, 역슬래시, 제어 문자는 거부한다.
- 값에는 종류, 생성 시각, 수정 시각, 크기가 있다. 파일 값에는 바이트를 담은
  Blob도 있다. 읽기 한도가 있으면 Blob을 읽기 전에 크기를 검사한다.
- 읽기 결과의 etag는 수정 시각과 크기를 담는다. 같은 etag로 두 탭이 쓰면
  처음 커밋한 탭의 쓰기가 적용되고 두 번째 쓰기는 `FILE_MODIFIED_SINCE`를
  받는다. 같은 객체 저장소의 폴더 이동과 재귀 삭제는 한 트랜잭션으로 적용한다.
  제공자 사이의 이동은 대상에 임시 사본을 옮긴 뒤 원본을 지운다.
- 트랜잭션이 커밋되면 같은 주소의 다른 탭에 변경을 알린다. 열린 탭은 변경
  이벤트 이후 저장소에서 최신 값을 읽을 수 있다.

### 브라우저가 저장소를 열 수 없을 때

파일 저장소 열기가 5초를 넘기거나 브라우저가 접근을 차단하면 현재 페이지에서
메모리 저장소를 사용한다. 다른 탭의 버전 변경으로 연결이 닫히면 앱은 지원하는
버전으로 한 번 다시 연결한다. 브라우저의 데이터가 더 새 버전이라 재연결할 수
없으면 메모리 저장소로 전환하고 새 버전의 데이터베이스는 보존한다.

전환 시 개발자 콘솔에 `Workbench file storage switched to memory` 경고가 한 번 나온다.
메모리 전환 뒤 저장한 파일은 페이지를 새로고침하거나 닫으면 사라진다.

## 텍스트 파일 편집

### 열기

- 파일 서비스에 제공자가 있는 스킴(워크스페이스 `vscode-vfs`, 사용자 데이터 `vscode-userdata`,
  읽기 전용 `http`·`https`, 확장이 등록한 파일 시스템)의 리소스는 텍스트 파일 에디터
  (`workbench.editors.files.textFileEditor`)로 열린다. 해석기의 기본 텍스트 에디터(`default`)
  등록이며, 더 높은 우선순위의 에디터(설정 JSON, 확장의 Custom Editor)가 있으면 그쪽이 연다.
- 같은 파일이 이미 열려 있으면 그 탭을 다시 쓴다. 같은 파일을 두 그룹에 열어도 텍스트는 하나여서
  한쪽에서 친 글이 다른 쪽에 바로 보인다. 마지막 탭을 닫으면 그 텍스트도 메모리에서 빠진다.
- 언어는 파일 경로로 고른다. 언어 기여가 없으면 `plaintext`다.
- 텍스트로 열지 않는 파일은 빈 탭 대신 에디터 자리에 이유를 보인다(`role="alert"`).
  - 앞 512바이트에 0 바이트가 있으면: `...because it is either binary or uses an unsupported text encoding.`
  - 20 MiB(20,971,520바이트)를 넘으면: `...because it is larger than 20 MB.`
  - 파일이 없으면: `...the file was not found.` 폴더면 `...the resource is a folder, not a file.`
  - 탭은 남는다. 파일이 생기거나 바뀐 뒤 탭을 다시 보이면 다시 읽는다.

### 탭

- 탭 이름은 파일 이름이다. 같은 그룹에 이름이 같은 탭이 둘 이상이면 이름 옆에 폴더를
  붙인다. 폴더는 워크스페이스 폴더 기준 상대 경로이고, 워크스페이스 맨 위의 파일은
  `workspace`다. 폴더는 탭의 접근 가능한 설명에도 들어간다(예: `docs, Modified`).
- 툴팁은 워크스페이스 기준 전체 경로다(`workspace/docs/index.md`). 지워진 파일은
  `(deleted)`, 읽기 전용 파일은 `(read-only)`가 붙는다.
- 읽기 전용 파일(`http`·`https` 같은 읽기 전용 제공자의 파일)은 이름 옆에 자물쇠가 있고,
  탭의 설명에 `Read-only`가 들어가며, 에디터가 입력을 받지 않는다.

### 고치기와 저장

- 고치면 탭에 점이 붙고 탭의 설명이 `Modified`가 된다. dirty 여부는 "마지막으로 저장한
  버전"과 비교한다. 실행 취소로 저장한 상태에 돌아가면 점이 사라진다.
- `Ctrl+S`(macOS `Cmd+S`)로 저장한다. 저장은 이 순서다: 저장 전 참여자(확장의
  `onWillSaveTextDocument` 등, `ITextFileService.onWillSave`)를 기다리고, 그 편집까지 포함한
  텍스트를 파일을 읽을 때의 etag를 조건으로 쓰고, 성공하면 etag와 dirty를 고친 뒤 저장 후
  이벤트를 낸다.
- 저장이 쓰는 동안 친 글은 저장된 내용에 들어가지 않고, 저장이 끝난 뒤에도 탭은 dirty다.
- 같은 파일의 저장은 줄을 선다. 저장이 도는 동안 다시 저장하면 하나만 기다리고, 그 사이 더
  누른 저장은 그것에 합쳐져 가장 새 내용 하나가 마지막에 저장된다.
- 파일은 UTF-8로 읽고 쓴다. 파일 앞의 UTF-8 BOM은 텍스트에서 빼 두었다가 저장할 때 다시
  붙인다. 줄 끝은 파일의 것(첫 줄바꿈 기준)을 지킨다. 한 파일에 섞인 줄 끝은 그 하나로 맞춰진다.

### 다른 탭이 먼저 저장했을 때

- 같은 브라우저의 다른 탭이 파일을 저장하면 이 탭에 알림이 온다(BroadcastChannel).
  - 고치지 않은 파일은 새 내용을 다시 읽는다. 바뀐 부분만 바꾸므로 커서와 스크롤이 남는다.
  - 고치고 있는 파일은 내용을 그대로 둔다. 저장하면 덮어쓰지 않고 퀵 픽으로 묻는다:
    제목 `Failed to save '<이름>': The content of the file is newer. Do you want to overwrite the file with your changes?`,
    항목 **Overwrite**(내 내용으로 덮어쓰기), **Revert**(내 변경을 버리고 새 파일 읽기),
    **Cancel**(저장하지 않고 고친 채로 둔다). Esc는 Cancel이다.
- 열린 파일이 지워지면 탭과 내용이 그대로 남고 툴팁에 `(deleted)`가 붙는다. 저장하면 파일을
  다시 만든다.

### 저장 실패

- 저장이 실패하면 오른쪽 아래에 오류 알림 `Failed to save '<이름>': <이유>`가 뜨고 탭은 dirty로 남는다.
- 브라우저 저장소가 가득 차면(IndexedDB 할당량) 이유는
  `The browser storage is full. Free up space and try again.`이다.

### 초안 백업과 새로고침

- 고친 파일의 내용은 마지막 변경 1초 뒤에 초안으로 저장된다.
  위치는 `vscode-userdata:/User/workspaceStorage/<워크스페이스 id>/backups/<이름>`이고, 지금
  워크스페이스 id는 `writing-room`이다. `<이름>`은 리소스 문자열의 64비트 FNV-1a 해시(16진수
  16자리)다. 파일의 첫 줄은 JSON 머리(형식 버전, 리소스, 읽을 때의 etag, BOM 여부)이고 그 뒤가 본문이다.
- 저장하거나, 되돌리거나, 실행 취소로 저장한 상태에 돌아가면 초안을 지운다.
- 새로고침하면 열린 파일 탭이 돌아온다. 탭 상태에는 리소스와 "초안 있음" 표시만 남고,
  내용은 탭이 보일 때 읽는다. 초안이 있으면 그 내용으로 dirty하게 열린다. 뒤에 있는 탭도 시작할
  때 초안을 읽어 점을 보인다. 초안이 있는 파일을 저장하면 초안을 만들 때의 etag로 확인하므로,
  그 사이 다른 탭이 저장했으면 덮어쓰기 전에 묻는다.
- 시작할 때 열린 탭이 없는 초안은 지운다. 다른 탭이 아직 쓰고 있는 초안(Web Locks로 표시)은
  지우지도 읽지도 않는다.
- 초안을 아직 쓰지 못했거나(변경 뒤 1초 안) 쓰기에 실패한 dirty 파일이 있으면 페이지를 떠날 때
  브라우저가 나가기 확인을 한다. 제목 없는 텍스트가 저장 한도를 넘을 때의 확인과는 따로 걸린다.

## 닫기 전 확인

- 고친 파일 탭과 텍스트가 있는 제목 없는 탭은 닫기 전에 퀵 픽으로 묻는다: 제목
  `Do you want to save the changes you made to <이름>?`, 항목 **Save**, **Don't Save**(설명
  `Your changes will be lost if you don't save them.`), **Cancel**. 고치지 않은 파일과 빈 제목 없는 탭은 묻지 않고 닫힌다.
- 같은 에디터가 다른 그룹에도 열려 있으면 묻지 않는다. 텍스트는 남은 탭에 그대로 있다.
- **Cancel**, Esc, 바깥 클릭, 다른 퀵 인풋이 뜨는 것은 모두 취소다. 취소하면 탭, 텍스트, 초안 백업이 그대로다.
- **Save**: 파일은 저장하고, 저장이 실패하면(할당량, 충돌 물음의 Cancel) 닫지 않는다. 제목 없는 탭은 경로 대화상자로
  어디에 저장할지 묻고, 경로를 고르지 않으면 닫지 않는다. 저장하면 탭이 닫힌다(파일 에디터를 대신 열지 않는다).
- **Don't Save**: 파일은 고친 것을 버리고(파일은 그대로, 초안은 지운다) 닫는다. 제목 없는 탭은 텍스트와 함께 닫힌다.
- 여러 에디터를 한 번에 닫으면(Close Others, Close All, Close All Editors) 하나씩 차례로 묻는다. 한 번이라도 취소하면
  그 그룹에서 아무것도 닫지 않고, Close All Editors는 다음 그룹으로 넘어가지 않는다. 앞서 **Don't Save**로 답한 에디터는
  고친 것을 버린 채 열려 있다.

## 파일 커맨드와 키

| 메뉴 (File) | 커맨드 | 키 (Linux·Windows / macOS) |
| --- | --- | --- |
| New Text File | `workbench.action.files.newUntitledFile` | Ctrl+Alt+N (Windows Ctrl+K N) / ⌥⌘N |
| New File... | `workbench.action.files.newFile` | Ctrl+Alt+Super+N / ⌃⌥⌘N |
| Save | `workbench.action.files.save` | Ctrl+S / ⌘S |
| Save As... | `workbench.action.files.saveAs` | Ctrl+Shift+S / ⇧⌘S |
| Save All | `saveAll` | 없음 (Windows Ctrl+K S) / ⌥⌘S |
| Revert File | `workbench.action.files.revert` | 없음 |

- 키와 커맨드 id는 VS Code 웹과 같다. 팔레트(F1)에서는 `File: Save As...`처럼 `File:`이 붙는다.
- 브라우저나 운영체제가 먼저 가져가서 페이지에 닿지 않는 키가 있다: Firefox의 Ctrl+Shift+S(화면 캡처), 데스크톱이 Super
  키를 쓰는 Linux의 Ctrl+Alt+Super+N, 브라우저의 Ctrl+N(새 창). 그때는 메뉴나 팔레트를 쓴다.
- **New File...**: 경로 대화상자(제목 `Create File`, 기본 이름 `Untitled.txt`, 활성 파일의 폴더에서 시작)로 경로를 받아 빈
  파일을 만들고 연다. 이미 있는 파일을 고르면 바꿀지 먼저 묻는다.
- **Save**: 제목 없는 탭이면 경로를 묻는다(아래). 읽기 전용 파일은 저장하지 않는다.
- **Save As...**: 경로 대화상자가 지금 파일의 폴더와 이름에서 시작한다. 고른 파일에 지금 텍스트를 쓰고, 그 파일 에디터가
  같은 자리에 들어선다. 원래 파일은 디스크에 있던 대로 돌아간다(고친 것은 새 파일에 갔다). 고른 파일이 이미 열려 있으면 그
  텍스트가 바뀌고 저장된다.
- **Save All**: 고친 것 가운데 저장할 수 있는 것(읽기 전용이 아닌 것)만, 한 번씩 저장한다. 파일을 먼저, 그다음 제목 없는
  탭을 하나씩 경로를 물어 저장한다. 경로 물음을 취소하면 거기서 멈춘다.
- **Revert File**: 활성 파일 에디터의 고친 것을 버리고 파일을 다시 읽는다. 제목 없는 탭에서는 쓸 수 없다.

### 제목 없는 탭 저장

- Save, Save As..., 닫기 확인의 Save가 모두 경로를 묻는다. 대화상자는 기본 폴더(활성 파일의 폴더, 없으면 워크스페이스
  폴더)에서 `Untitled-N` + 언어의 첫 확장자(평문은 `.txt`)를 이름으로 제안한다.
- Save와 Save As...로 저장하면 파일 에디터가 같은 그룹의 같은 자리(탭 순서)에 들어서고, 커서와 스크롤이 그대로이며, 제목
  없는 탭은 남지 않는다. 제목 없는 탭이 여러 그룹에 있었으면 모든 그룹에서 바뀐다. 실행 취소 기록은 이어지지 않는다.

## 경로 대화상자

파일을 고르는 대화상자는 브라우저의 것이 아니라 퀵 인풋이다(VS Code의 simple file dialog).

- 목록: 지금 폴더의 내용이다. 맨 위에 저장 대화상자는 **Save**(제안한 이름의 경로가 설명에 있다), 폴더를 고르는 열기
  대화상자는 **Open**(그 폴더를 고른다)이 오고, 그다음 **Type a Path...**(저장은 **Type a Name or Path...**), 맨 위
  폴더가 아니면 `..`, 폴더(`이름/`), 파일 순이다. 폴더를 고르면 그 안으로 들어간다. 입력 칸에 친 글자는 목록을 거른다.
- 경로 입력: **Type a ...** 항목이 입력 칸을 연다. 절대 경로(`/workspace/docs/a.md`)나 지금 폴더 기준 상대 경로를 받는다.
  `.`과 `..`을 풀고 겹친 `/`를 정리한 뒤 판단한다. 폴더면 그 안으로 들어가고, 파일이면 고른다. 칠 때마다 확인해 이유를
  입력 칸 아래에 보이고, 이유가 있는 동안 Enter는 받지 않는다:
  - 워크스페이스 폴더 밖: `The path must be inside the workspace folder.`
  - `\`나 제어 문자: `A path cannot hold "\" or control characters.`
  - 255자를 넘는 이름: `A name in the path is longer than 255 characters.`
  - 저장할 이름이 `.`, `..`이거나 `/`, `\`, 제어 문자를 담음: `This name is not valid as a file or folder name: ...`
  - 없는 폴더 안의 경로, 열기에서 없는 파일: `Please enter a path that exists.`
- 저장할 곳에 파일이 있으면 퀵 픽으로 묻는다: `<제목>: <이름> already exists. Do you want to replace it?`, **Replace** /
  **Cancel**. Cancel은 목록으로 돌아간다.
- 키보드만으로 쓸 수 있다: 위아래 화살표와 Enter, 입력 칸의 글자. 어느 물음에서든 Esc, 바깥 클릭, 다른 퀵 인풋이 뜨는 것은
  대화상자 전체의 취소이며 아무것도 바꾸지 않는다.
- 워크스페이스 폴더 밖으로는 `..`도, 친 경로도 나가지 못한다.

## 대화상자 API

`window.showOpenDialog(options?)`와 `window.showSaveDialog(options?)`는 위의 경로 대화상자를 연다.

| 옵션 | 열기 | 저장 | 동작 |
| --- | --- | --- | --- |
| `defaultUri` | ✓ | ✓ | 시작 폴더. 파일이면 그 폴더에서 시작하고 저장은 그 이름을 제안한다. 워크스페이스 밖이면 기본 폴더에서 시작하고 이름만 제안한다 |
| `title` | ✓ | ✓ | 대화상자 제목. 기본은 `Open File`, `Open Folder`, `Open`, `Save As` |
| `openLabel` / `saveLabel` | ✓ | ✓ | 지금 폴더를 고르는 항목 / 제안한 이름으로 저장하는 항목의 이름 |
| `canSelectFiles`, `canSelectFolders` | ✓ | | 둘 다 없으면 파일을 고른다(VS Code와 같다). 폴더만 고르면 파일을 보이지 않는다 |
| `canSelectMany` | ✓ | | 받지만 한 번에 하나를 고른다. 결과는 언제나 배열이다 |
| `filters` | ✓ | ✓ | 모든 필터의 확장자 합집합에 맞는 파일만 목록에 보인다. `*`가 있으면 모두 |

- 결과는 워크스페이스 스킴(`vscode-vfs`)의 URI다. 메인 스레드는 옵션의 모양(불리언, 1,024자까지의 문자열, 필터 100개와
  확장자 100개까지, `defaultUri`는 `Uri`)을 검사해 틀리면 호출을 거부하고, 돌려줄 URI가 정규화된 경로로 워크스페이스 폴더
  안에 있는지 다시 확인한다. 아니면 `undefined`다. 취소도 `undefined`다.

## Deviations from VS Code

- 텍스트 파일은 UTF-8만 읽고 쓴다. 인코딩 선택, 추측, 다시 열기가 없다 (wr-jrhv.q50).
- 자동 저장, 비교 보기(충돌 물음의 Compare), 파일 기록(Timeline)이 없다 (wr-jrhv.q50).
- 저장 충돌은 알림의 버튼이 아니라 퀵 픽으로 묻고, 저장은 답을 기다린다. Revert가 퀵 픽에
  있다 (wr-jrhv.q50).
- 바이너리와 큰 파일은 이유만 보이고 "Open Anyway"가 없다 (wr-jrhv.q50).
- 지워진 파일의 탭은 취소선 대신 툴팁의 `(deleted)`로 알린다 (wr-jrhv.q50).
- 초안은 VS Code의 작업 사본 백업 서비스가 아니라 텍스트 파일 서비스가 직접 쓰며, 탭 사이에
  Web Locks로 쓰는 중임을 알린다 (wr-jrhv.q50).
- 저장 실패 알림은 확장 메시지와 같은 토스트이며 Retry 같은 동작 버튼이 없다 (wr-jrhv.q50).
- 텍스트 파일 에디터는 텍스트 에디터 페인과 오류 페인을 안에 둔 페인이다. VS Code의
  `TextFileEditor`는 텍스트 에디터를 상속한다 (wr-jrhv.q50).
- 닫기 확인, 덮어쓰기 확인, 경로 대화상자는 모달 대화상자가 아니라 퀵 인풋이다. 여러 에디터를 닫을 때 한 번에 묻지 않고
  하나씩 묻는다 (wr-jrhv.r4v).
- 경로 대화상자의 목록은 친 경로를 따라 바뀌지 않는다. 경로는 **Type a Path...** 항목의 입력 칸에서 받고, 목록의 입력 칸은
  거르기만 한다 — 퀵 인풋에 값이 바뀔 때 항목을 바꾸는 기능이 없다. `canSelectMany`로 여러 개를 고를 수 없고, 필터를 고르는
  칸과 숨김 파일 토글, 없는 폴더를 만드는 물음이 없다 (wr-jrhv.r4v).
- File > New File...은 파일 종류를 고르는 퀵 픽(`welcome.showNewFileEntries`)을 거치지 않고 바로 경로 대화상자를 연다. 키는
  VS Code가 그 퀵 픽에 단 것이다 (wr-jrhv.r4v).
- 다른 이름으로 저장이 열려 있지 않은 파일에 쓸 때는 저장 전 참여자(`onWillSave`)를 부르지 않고 바로 쓴다. 대상 파일이 열려
  있으면 그 모델이 저장하므로 참여자가 돈다. 쓴 파일은 BOM 없는 UTF-8이다 (wr-jrhv.r4v).
- 제목 없는 텍스트의 제안 이름은 첫 줄이 아니라 `Untitled-N`과 언어의 확장자다 (wr-jrhv.r4v).
- 폴더를 독립 레코드로 저장해 빈 폴더를 새로고침 뒤에도 유지한다 (wr-lv5h.123).
  [VS Code의 웹 파일 제공자 초기화](vscode-web-build.md#24-webfactoryts의-create와-webmaints의-browsermain)
- 만들기, 삭제, 이동, 복사의 작업 전후 이벤트는 파일 서비스가 전달한다.
  작업 전 참여자는 `waitUntil`로 비동기 작업을 등록할 수 있다 (wr-lv5h.mag).

- `normalizePath`는 끝 슬래시를 제거해 파일 키를 하나로 유지한다. glob 패턴의
  명시적인 `.` 세그먼트도 정리한다 (wr-lv5h.rly).
- HTTP(S) 파일 요청은 URI의 구조화 직렬화에 기록한 원문 경로와 쿼리를 사용한다.
  기본 `URI.toString()`은 VS Code 방식으로 쿼리 전체를 인코딩하므로, 파일을
  읽는 소비자는 원문 URL 또는 URI 구성 요소를 전달해 HTTP 쿼리 구분자를 보존한다
  (wr-lv5h.gi4, wr-40ba).
- 사용자 데이터 제공자의 `/User/settings.json`은 기존 설정 서비스 전용이다.
  제공자 사이의 이동은 대상과 원본에 걸치는 순서 있는 작업으로 처리한다
  (wr-lv5h.gi4).

Decided in: wr-efqx.n9k, wr-lv5h, wr-jrhv.q50, wr-jrhv.r4v
