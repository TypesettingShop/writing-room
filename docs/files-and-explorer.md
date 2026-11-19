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

### Deviations from VS Code

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

Decided in: wr-efqx.n9k, wr-lv5h
