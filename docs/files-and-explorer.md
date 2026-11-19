# 파일과 탐색기

브라우저 워크스페이스 파일의 저장 위치와 저장이 제한될 때의 동작을 설명한다.

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
| `vscode-userdata` | 확장 패키지 `/extensions/`, 확장별 `/User/globalStorage/`와 `/User/workspaceStorage/`, `/logs/` |

설정 원문 `vscode-userdata:/User/settings.json`은 기존 사용자 설정 저장 방식을
사용한다. [VS Code 웹의 설정 저장 방식](vscode-state-settings.md#33-웹-환경에서-settingsjson의-물리적-저장-위치)

### 저장 형식과 동시 편집

- 키는 정규화한 절대 경로다. 겹친 슬래시, 끝 슬래시, `.`과 `..`을 정리한
  뒤 저장 위치를 결정한다. 인코딩된 구분자, 역슬래시, 제어 문자는 거부한다.
- 값에는 종류, 생성 시각, 수정 시각, 크기가 있다. 파일 값에는 바이트를 담은
  Blob도 있다. 읽기 한도가 있으면 Blob을 읽기 전에 크기를 검사한다.
- 읽기 결과의 etag는 수정 시각과 크기를 담는다. 같은 etag로 두 탭이 쓰면
  처음 커밋한 탭의 쓰기가 적용되고 두 번째 쓰기는 `FILE_MODIFIED_SINCE`를
  받는다. 폴더 이동과 재귀 삭제도 트랜잭션 단위로 적용한다.
- 트랜잭션이 커밋되면 같은 주소의 다른 탭에 변경을 알린다. 열린 탭은 변경
  이벤트 이후 저장소에서 최신 값을 읽을 수 있다.

### 브라우저가 저장소를 열 수 없을 때

브라우저가 IndexedDB를 차단했거나 저장 형식이 앱보다 새 버전이면 현재 페이지에서
메모리 저장소를 사용한다. 개발자 콘솔에 `Workbench file storage switched to memory`
경고가 한 번 나온다. 이 상태에서 저장한 파일은 페이지를 새로고침하거나 닫으면
사라진다. 새 버전의 데이터베이스는 브라우저에 보존된다.

### Deviations from VS Code

- 폴더를 독립 레코드로 저장해 빈 폴더를 새로고침 뒤에도 유지한다 (wr-lv5h.123).
  [VS Code의 웹 파일 제공자 초기화](vscode-web-build.md#24-webfactoryts의-create와-webmaints의-browsermain)
- 만들기, 삭제, 이동, 복사의 작업 전후 이벤트는 파일 서비스가 전달한다.
  작업 전 참여자는 `waitUntil`로 비동기 작업을 등록할 수 있다 (wr-lv5h.mag).

Decided in: wr-lv5h
