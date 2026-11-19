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

- 워크스페이스 `vscode-vfs`와 확장이 등록한 파일 시스템의 리소스는 텍스트 파일 에디터
  (`workbench.editors.files.textFileEditor`)로 열린다. 해석기의 기본 텍스트 에디터(`default`)
  등록이며, 더 높은 우선순위의 에디터(설정 JSON, 확장의 Custom Editor)가 있으면 그쪽이 연다.
  사용자 데이터 `vscode-userdata`(확장 패키지, 확장 저장 폴더, 초안 백업)와 읽기 전용 `http`·`https`는
  텍스트 파일로 열지 않고 텍스트 모델도 만들지 않는다. 저장된 탭 목록이 그런 리소스를 가리켜도
  복원하지 않는다 (wr-jrhv.qap #18).
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
  위치는 `vscode-userdata:/User/workspaceStorage/<워크스페이스 id>/backups/<세션 id>/<해시>`다.
  워크스페이스 id는 `writing-room`이고, 페이지가 시작할 때 16진수 32자리의 세션 id를 만든다.
  파일 이름은 리소스 문자열의 64비트 FNV-1a 해시(16진수 16자리)다. 첫 줄은 JSON 머리
  (형식 버전, 리소스, 읽을 때의 etag, BOM 여부)이고 그 뒤가 본문이다.
- 저장, 되돌리기, 닫기 확인의 **Don't Save**, 실행 취소로 저장한 상태에 돌아가기, Explorer에서
  파일 지우기가 성공하면 이 탭의 해당 초안을 지운다.
- 새로고침하면 열린 파일 탭이 돌아온다. 탭 상태에는 리소스와 "초안 있음" 표시만 남고,
  내용은 탭이 보일 때 읽는다. 초안이 있으면 그 내용으로 dirty하게 열린다. 뒤에 있는 탭도 시작할
  때 초안을 읽어 점을 보인다. 파일의 텍스트를 보이는 Custom Editor 탭도 같다. 초안이 있는 파일을 저장하면 초안을 만들 때의 etag로 확인하므로,
  그 사이 다른 탭이 저장했으면 덮어쓰기 전에 묻는다.
- 시작할 때 그 파일의 탭이 없으면 활성 그룹 끝에 dirty한 텍스트 탭을 뒤에서 연다. 기존 활성 탭과
  포커스는 유지된다. 파일이 지워졌어도 탭에서 초안을 볼 수 있고, 탭의 툴팁에 `(deleted)`가 붙는다.
  읽을 수 없는 초안은 콘솔에 경고를 남기고 보관한다. 앱보다 새 형식의 초안도 저장소에 남는다
  (wr-a5tr.x5x).
- 페이지가 열려 있는 동안 Web Locks로 세션을 표시한다. 새로 시작한 탭은 잠금이 풀린 세션의
  초안을 자기 폴더로 옮긴다. 같은 파일의 초안이 여러 개면 시작한 탭마다 하나씩 가져올 수 있다.
  나머지는 다음 시작을 위해 원래 폴더에 남는다. 빈 이전 세션 폴더는 시작 때 치운다.
  세션 폴더 없이 저장된 버전 1 초안도 옮겨서 읽으며, 해당 파일의 이전 형식 잠금도 확인한다
  (wr-a5tr.505).
- Web Locks를 지원하지 않는 브라우저에서는 다른 세션의 초안을 시작 때 옮길 수 있다. 여러 탭을
  열어 두었다면 새로 시작한 탭이 먼저 열린 탭의 초안을 가져갈 수 있다. 먼저 열린 탭의 글은
  화면에 남으며 다음에 고치면 그 탭의 초안으로 다시 기록된다.
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

## Explorer

사이드바의 Explorer 컨테이너(`workbench.view.explorer`)의 첫 뷰가 워크스페이스 폴더의 파일 트리다. 뷰 id는
`workbench.explorer.fileView`이고 뷰 머리글은 폴더 이름(`workspace`)이다. v0.1.0의 자리표시자(`workbench.explorer.emptyView`,
"No folder opened")를 같은 컨테이너에서 바꾼 것이라 컨테이너를 패널로 옮기거나 숨긴 저장 배치는 그대로 유효하다. 확장이
`views.explorer`에 기여한 뷰는 파일 트리 아래에 그대로 나온다.

### 트리

- 워크스페이스 폴더 자체는 행이 아니다. 그 안의 항목이 1단계(`aria-level="1"`)다.
- 폴더가 먼저, 그다음 파일이다. 각각 이름순이며 대소문자와 악센트를 가리지 않고 숫자는 값으로 비교한다(`file2` 다음
  `file10`). VS Code의 기본 정렬(`explorer.sortOrder: default`)과 같다.
- 폴더는 처음 펼칠 때 읽는다. 한 폴더에 보이는 항목은 10,000개까지이고, 넘으면 마지막에 `N more items are not shown`
  행이 나온다(이 행은 고를 수 없다).
- 파일 변경(이 탭의 저장·만들기·지우기와 다른 탭의 변경)이 오면 화면에 보이는 폴더만 다시 읽는다. 읽어 둔 폴더가 접혀
  있으면 그 목록을 버렸다가 다음에 펼칠 때 읽는다. 같은 폴더의 읽기가 겹치면 마지막 것만 받아들인다.
- 활성 에디터가 바뀌면 그 파일을 트리에서 고르고 위의 폴더를 펼친다(VS Code의 `explorer.autoReveal` 기본값). 포커스는
  옮기지 않는다.

### 조작과 키

트리 역할은 `tree`(이름 `Files Explorer`), 행은 `treeitem`이고 `aria-level`, `aria-selected`, 폴더는 `aria-expanded`를
가진다. 고른 행이 탭 순서에 들어간다.

| 조작 | 마우스 | 키 |
| --- | --- | --- |
| Explorer로 포커스 | 활동 표시줄의 Explorer | Ctrl+Shift+E (macOS ⇧⌘E), `View: Show Explorer` |
| 위아래로 옮기기, 처음과 끝 | | ↑ ↓ Home End |
| 폴더 펼치기 / 첫 자식으로 | 폴더 행 누르기 | → |
| 폴더 접기 / 부모 폴더로 | 폴더 행 누르기 | ← |
| 파일 열기 | 파일 행 누르기(포커스는 트리에 남는다) | Enter(포커스가 에디터로 간다), Space(트리에 남는다) |
| 새 파일, 새 폴더 | 뷰 제목의 버튼, 컨텍스트 메뉴 | 컨텍스트 메뉴(Shift+F10, 메뉴 키) |
| 이름 바꾸기 | 컨텍스트 메뉴 **Rename...** | F2 |
| 지우기 | 컨텍스트 메뉴 **Delete** | Delete |
| 새로 고침, 모두 접기 | 뷰 제목의 버튼 | 팔레트 `File: Refresh Explorer`, `File: Collapse Folders in Explorer` |
| 컴퓨터의 파일 올리기 | 뷰 제목의 **More Actions**(…) > **Upload...**, 폴더의 컨텍스트 메뉴, 파일을 끌어다 놓기 | 컨텍스트 메뉴 **Upload...** |
| 파일 내려받기 | 파일의 컨텍스트 메뉴 **Download** | 컨텍스트 메뉴 **Download** |

| 커맨드 | 하는 일 |
| --- | --- |
| `explorer.newFile`, `explorer.newFolder` | 인자 URI(없으면 고른 항목)가 폴더면 그 안, 파일이면 그 폴더에 줄 안의 입력을 연다 |
| `renameFile`, `deleteFile` | 인자 URI(없으면 고른 항목)의 이름을 바꾸거나 지운다 |
| `workbench.files.action.refreshFilesExplorer` | 보이는 폴더를 모두 다시 읽는다 |
| `workbench.files.action.collapseExplorerFolders` | 모든 폴더를 접는다 |
| `revealInExplorer` | 인자 URI(없으면 활성 에디터의 파일)를 드러낸다: Explorer 컨테이너를 연다(사이드바가 닫혀 있거나 패널로 옮겨졌어도), 접힌 폴더를 펼치고, 고르고, 보이게 하고, 포커스를 준다 |
| `workbench.view.explorer` | Explorer 뷰를 열고 트리에 포커스를 준다 |
| `explorer.upload` | 파일 고르기 창을 열고 고른 파일을 인자 URI(없으면 고른 항목)의 폴더(파일이면 그 폴더, 없으면 워크스페이스 폴더)에 올린다 |
| `explorer.download` | 인자 URI(없으면 고른 항목)인 워크스페이스 폴더 안의 파일 하나를 내려받는다 |

### 줄 안의 입력

- 새 파일과 새 폴더는 그 폴더 안에(폴더는 맨 위, 파일은 첫 파일 자리) 입력 칸이 생긴다. 이름 바꾸기는 그 행이 입력
  칸이 되고 확장자 앞까지 골라 둔다. 입력 칸의 이름은 `Type file name. Press Enter to confirm or Escape to cancel.`이다.
- 칠 때마다 검사하고, 받을 수 없으면 입력 칸 아래에 이유를 보이며 입력 칸이 `aria-invalid="true"`가 되고 이유가 그
  설명(`aria-describedby`)이 된다. 이유가 있는 동안 Enter는 아무것도 하지 않는다.
  - 빈 이름: `A file or folder name must be provided.`(새 이름은 빈 채로는 이유를 보이지 않고 Enter만 막는다)
  - `/`, `\`, 제어 문자를 담거나 `.`, `..`인 이름: `This name is not valid as a file or folder name: ...`
  - 255자를 넘는 이름: `The name is longer than 255 characters.`
  - 같은 폴더에 같은 이름(대소문자까지 같음)이 있음: `A file or folder <이름> already exists at this location. Please choose a different name.`
    이름 바꾸기에서 자기 이름은 괜찮고 아무 일도 하지 않는다.
- Enter는 받고, Escape는 취소한다. 입력 칸을 떠나면 받을 수 있는 이름은 받고 아니면 취소한다(VS Code와 같다).
- 입력 도중 다른 탭의 변경으로 트리가 다시 그려져도 친 글자, 커서, 포커스가 그대로다. 입력 중에 다른 탭이 같은 이름을
  만들면 그 이름도 거부된다. 입력 칸이 있던 폴더가 사라지면 입력은 닫힌다.
- 새 파일은 만든 뒤 에디터로 열리고(포커스가 에디터로 간다), 새 폴더는 트리에서 골라지고 포커스를 받는다. 만들지 못하면
  (이미 있음, 저장소가 가득 참) 오른쪽 아래에 `Unable to create '<이름>': <이유>` 알림이 뜬다.

### 이름 바꾸기와 지우기

- 이름 바꾸기: 바꿀 파일(폴더면 그 아래 전부) 가운데 고치고 저장하지 않은 것이 있으면 먼저 퀵 픽으로 묻는다: 제목
  `'<파일>' has unsaved changes. Save them before renaming '<이름>'?`, 항목 **Save and Rename** / **Cancel**. Cancel(Esc)이면
  이름도 고친 내용도 그대로이고, 저장이 실패해도 이름을 바꾸지 않는다. 그다음 파일 서비스의 `move`(작업 전 참여자
  `onWillRunOperation`을 거친다)로 옮기고, 옛 경로를 보던 에디터는 같은 그룹, 같은 자리에 새 경로로 다시 열린다(커서와
  스크롤이 그대로다). 펼친 폴더 상태도 새 경로로 옮겨진다.
- 지우기: 퀵 픽으로 확인한다: `Are you sure you want to permanently delete '<이름>'?`(폴더는 `... '<이름>' and its contents?`),
  항목 **Delete**(`This action is irreversible!`) / **Cancel**. 브라우저 저장소에는 휴지통이 없어 늘 영구 삭제다. 확인하면
  그 파일(폴더면 그 아래 전부)을 보는 에디터를 그룹마다 닫는데, 고친 에디터는 [닫기 전 확인](#닫기-전-확인)을 거친다.
  거기서 취소하면 아무것도 지우지 않는다(앞 그룹에서 이미 닫힌 탭은 닫힌 채다). 그다음 파일 서비스의
  `del`(재귀)로 지운다. 탭 없이 남은 모델의 글과 초안은 파일 삭제가 성공한 뒤에 정리한다. 저장소 오류로
  삭제가 실패하면 파일과 그 글과 초안이 남는다. 삭제가 진행 중일 때 더 고친 글도 남는다.
  성공하면 다음 항목(없으면 앞 항목, 그것도 없으면 부모)을 고른다. 파일 삭제와 초안 정리 사이에
  페이지가 종료되면 다음 시작에서 `(deleted)` 탭으로 글을 볼 수 있다 (wr-a5tr.ihv).
- 이름 바꾸기와 지우기가 실패하면 `Unable to rename '<이름>': <이유>`, `Unable to delete '<이름>': <이유>` 알림이 뜬다.
- 워크스페이스 폴더 자체는 이름을 바꾸거나 지울 수 없다.

### 컨텍스트 메뉴

- 행에서 오른쪽 클릭, Shift+F10, 메뉴 키로 연다. 빈 곳에서 열면 워크스페이스 폴더의 메뉴다.
- 내장 항목: **New File...**, **New Folder...**(`navigation`), **Download**(파일만)와 **Upload...**(폴더와 빈 곳만,
  `5b_importexport`), **Rename...**, **Delete**(`7_modification`, 워크스페이스 폴더에는 없다). 확장이 `menus`의 `explorer/context`에 기여한 항목이 그룹 순서대로 함께 나온다.
- 메뉴의 `when`은 그 항목의 키로 평가한다: `resource`, `resourceScheme`, `resourceFilename`, `resourceExtname`,
  `resourceDirname`, `resourcePath`, `resourceLangId`, `resourceSet`, 그리고 `explorerResourceIsFolder`,
  `explorerResourceIsRoot`. 확장 커맨드는 첫 인자로 그 항목의 `Uri`를 받는다.

### 올리기와 내려받기

컴퓨터와 워크스페이스 사이에 파일을 옮기는 길이다. 코드는 `src/workbench/contrib/files/browser/fileImportExport.ts`
(VS Code의 같은 파일의 `BrowserFileUpload`, `FileDownload`)이고 커맨드는 `explorerActions.ts`, 드롭 대상은 `views/explorerView.ts`에 있다.

- **Upload...**는 `<input type="file" multiple>`의 파일 고르기 창을 연다. 고르지 않고 닫으면 아무 일도 없다.
- 파일을 운영체제에서 Explorer 뷰로 끌어 오면 놓일 폴더가 표시된다: 폴더 행이면 그 행, 파일 행이면 그 파일의 폴더 행,
  빈 곳이면 트리 전체(워크스페이스 폴더). 표시는 `data-explorer-drop-target` 속성이다. 놓기, 뷰 밖으로 나가기,
  `dragend`, Escape, 창의 blur, 페이지 숨김 가운데 먼저 오는 것에서 지운다. 놓은 파일이 브라우저에서 열리지 않도록
  뷰가 그 드래그를 받는다(`preventDefault`). 파일이 아닌 드래그(글자, 링크, 탭과 뷰 컨테이너)는 건드리지 않는다.
- 에디터 영역은 v0.1.0처럼 파일 드롭을 거절한다(`dropEffect = 'none'`). 에디터 영역에 놓은 파일은 열리지도 쓰이지도 않는다.
- 쓰기 전에 모두 검사하고, 하나라도 걸리면 아무것도 쓰지 않고 오른쪽 아래에 이유를 알린다(`... Nothing was uploaded.`):
  - 폴더가 섞여 있다(파일만 받는다).
  - 이름이 Explorer의 이름 검증(`validateFileName`: 빈 이름, `.`, `..`, `/`, `\`, 제어 문자, 255자 초과)에 걸린다.
  - 같은 이름이 둘 있다.
  - 파일 하나가 50 MiB를 넘거나, 합계가 200 MiB를 넘는다.
  - 대상 폴더에 같은 이름의 폴더가 있다(폴더는 바꾸지 않는다).
- 같은 이름의 파일이 있으면 파일마다 퀵 픽으로 묻는다: 제목 `A file named '<이름>' already exists in '<폴더>'. Do you want to
  replace it?`, 항목 **Replace**(`This action is irreversible!`) / **Skip**. 물음은 모두 쓰기 전에 끝나며, Escape는 올리기
  전체를 취소한다(아무것도 쓰지 않는다).
- 그다음 고른 순서대로 한 파일씩 끝까지 읽은 뒤 한 번에 쓴다(새 파일은 `createFile`, 바꾸는 파일은 `writeFile`).
  브라우저 저장소의 쓰기는 레코드 하나라 반쯤 쓴 파일이 남지 않는다. 하나가 실패하면(읽을 수 없음, 저장소가 가득 참, 물은 뒤
  다른 탭이 같은 이름을 만듦) 거기서 멈추고 `Uploaded N of M files (<이름들>), then stopped. Unable to upload '<이름>': <이유>`로
  이미 쓴 것을 알린다.
- 다 쓰면 폴더를 다시 읽고 첫 파일을 고르고 에디터로 연다(VS Code와 같다). 열려 있던 파일을 바꾸면 그 에디터는 저장소의
  새 내용을 읽는다(고친 채인 에디터는 저장할 때 충돌을 묻는다).
- **Download**는 파일을 저장소의 바이트 그대로 읽어 Blob URL을 만들고 `<a download="<이름>">`을 눌러 브라우저의
  내려받기로 넘긴다. 링크는 바로 떼고 URL은 다음 태스크에서 `URL.revokeObjectURL`로 놓는다(VS Code의 `triggerDownload`와 같다).
  워크스페이스 폴더 밖의 URI와 폴더는 받지 않는다.

### 펼침 저장

- 펼친 폴더 목록은 워크스페이스 범위 저장소의 `workbench.explorer.treeViewState`(VS Code의 키)에
  `{"expanded": ["<폴더 URI>", ...]}`로 둔다. 펼치거나 접을 때마다 쓴다. 새로고침하면 그 폴더들을 다시 읽어 펼친다.
- 읽을 때 검사한다. JSON이 아니거나 모양이 다르면 모두 접힌 채로 시작하고, 워크스페이스 폴더 밖이나 폴더 자체를 가리키는
  항목은 버린다. 10,000개까지만 읽고 쓴다. 지워진 폴더는 목록에서 빠진다.
- **Collapse Folders in Explorer**는 목록을 비운다.

## Deviations from VS Code

- 텍스트 파일은 UTF-8만 읽고 쓴다. 인코딩 선택, 추측, 다시 열기가 없다 (wr-jrhv.q50).
- 자동 저장, 비교 보기(충돌 물음의 Compare), 파일 기록(Timeline)이 없다 (wr-jrhv.q50).
- 저장 충돌은 알림의 버튼이 아니라 퀵 픽으로 묻고, 저장은 답을 기다린다. Revert가 퀵 픽에
  있다 (wr-jrhv.q50).
- 바이너리와 큰 파일은 이유만 보이고 "Open Anyway"가 없다 (wr-jrhv.q50).
- 지워진 파일의 탭은 취소선 대신 툴팁의 `(deleted)`로 알린다 (wr-jrhv.q50).
- 브라우저의 여러 탭이 한 저장소를 쓰므로 텍스트 파일 서비스가 세션별로 초안을 기록한다.
  Web Locks로 열려 있는 세션을 구분하고, 새 탭은 종료된 세션에서 초안을 옮겨 온다
  (wr-jrhv.q50, wr-a5tr.505).
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
- Explorer 트리는 가상화 목록이 아니라 보이는 행을 모두 DOM에 그린다. 그래서 한 폴더에 10,000개까지만 보이고 나머지는
  "more" 행으로 센다(VS Code에는 이 한도가 없다). 여러 개 고르기, 끌어서 옮기기, 잘라내기·복사·붙여넣기, 찾기(타이핑 필터),
  압축 폴더(`explorer.compactFolders`), 파일 아이콘 테마와 장식, 열린 에디터 뷰, 실행 취소가 없다 (wr-jrhv.02j).
- 지우기는 늘 영구 삭제이고 확인은 퀵 픽이다. 지우는 파일을 보는 에디터는 닫기 확인을 거친다.
  탭 없는 dirty 모델은 파일 삭제가 성공한 다음 정리한다. VS Code는 삭제 전에 정리한다. 순서를
  바꾸면 저장소가 삭제를 거부했을 때 사용자의 글이 남는다 (wr-a5tr.ihv).
  VS Code는 고친 파일이 있으면 "unsaved changes" 경고를 한 번 묻고 에디터를 (설정에 따라) 남긴다 (wr-jrhv.02j).
- 고친 파일의 이름을 바꿀 때 먼저 저장할지 묻는다. VS Code는 작업 사본을 새 경로로 옮겨 고친 채로 둔다 (wr-jrhv.02j).
- 뷰 머리글은 폴더 이름이고 뷰 설명자의 이름도 그것이다. VS Code의 설명자 이름은 `Folders`이고 머리글만 작업 영역 이름이다.
  폴더가 `workspace` 하나로 고정이라 모듈을 읽을 때 이름을 정한다 (wr-jrhv.02j).
- 새 이름 검사는 경로가 든 이름(`a/b`)을 거부한다. VS Code는 그것으로 중간 폴더를 만든다. 앞뒤 공백 경고는 없다 (wr-jrhv.02j).
- 올리기는 파일만 받는다. VS Code는 폴더도 통째로 올리고, 드롭한 폴더를 작업 영역에 더할지도 묻는다. 한도(파일 50 MiB,
  합계 200 MiB)는 VS Code에 없다. 진행 표시와 취소, 동시 20개 올리기, 실행 취소가 없다. 덮어쓰기 확인은 모달 대화상자가
  아니라 퀵 픽이고 Skip이 있으며, 모든 물음을 쓰기 전에 끝낸다. 같은 이름의 폴더는 바꾸지 않는다 (wr-jrhv.y8q).
- **Upload...**는 VS Code처럼 폴더의 컨텍스트 메뉴에 있고, 더해서 뷰 제목의 More Actions에도 있다 (wr-jrhv.y8q).
- 내려받기는 파일 하나를 Blob으로만 한다. VS Code 웹은 폴더와 32 MB를 넘는 파일을 File System Access API
  (`showDirectoryPicker`)로 받는다. 그래서 메뉴 이름은 고를 것이 없어 `Download...`가 아니라 **Download**다 (wr-jrhv.y8q).
- 파일을 끌어 폴더 위에 머물러도 폴더가 저절로 펼쳐지지 않고, 드롭 표시는 폴더 행 하나만 칠한다(VS Code는 그 아래 행도
  칠한다) (wr-jrhv.y8q).
- F2, Delete, Enter, Space는 키 바인딩이 아니라 트리가 직접 받는다(VS Code는 `filesExplorerFocus` 조건의 키 바인딩). 그래서 키
  바인딩 편집으로 바꿀 수 없다 (wr-jrhv.02j).

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

## 기술 부채

- Explorer 트리(`src/workbench/contrib/files/browser/views/explorerView.ts`)와 확장 트리 뷰
  (`src/workbench/browser/parts/views/treeView.ts`)는 따로 그린다. 키보드 처리, 행 그리기, 컨텍스트 메뉴가 겹친다. VS Code는
  둘 다 `WorkbenchAsyncDataTree`(가상화 목록)를 쓴다. 트리 위젯 하나로 합치는 일은 확장 트리 뷰가 테마 에픽에서 안정된 뒤로
  미뤘다 (wr-jrhv.02j).
- 뷰 레지스트리는 본문에 요소만 주므로 Explorer 본문은 모듈 변수에 담긴 인스턴스화 서비스를 기다린다(`explorerViewlet.ts`의
  `ExplorerViewletContribution`이 시작할 때 채운다). 사이드바가 기여보다 먼저 그려지기 때문이다. 뷰 설명자가 생성자 서술자를
  받게 되면 없앤다 (wr-jrhv.02j).

Decided in: wr-efqx.n9k, wr-lv5h, wr-jrhv.q50, wr-jrhv.r4v, wr-jrhv.02j, wr-jrhv.y8q, wr-a5tr
