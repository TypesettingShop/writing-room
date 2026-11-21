# writing-room 시작하기

writing-room은 브라우저에서 실행하는 편집 워크벤치다(v0.2.0). 텍스트를 Monaco에서 편집하고 탭과 뷰 컨테이너를 배치한 뒤, 새로고침해서 같은 작업을 이어갈 수 있다. 브라우저 저장소에 파일과 폴더를 두고 Explorer로 다루며, VS Code용 웹 확장을 설치해 언어, 미리보기, 진단 같은 기능을 더할 수 있다. 확장이 쓸 수 있는 API와 지원 범위는 [확장 API](extension-api.md)의 호환 표에 있다.

## 실행하기

Node.js와 npm을 설치한다. 지원하는 Node.js 버전 범위는 `^22.22.2 || ^24.15.0 || >=26.0.0`이다. 저장소 디렉터리에서 다음을 실행하고 Vite가 출력하는 주소를 Chromium 브라우저에서 연다.

```sh
npm ci
npm run dev
```

배포할 파일을 로컬에서 확인하려면 `npm run build`로 `dist/`를 새로 만들고 `npm run preview`로 연다. 개발 서버와 프리뷰의 주소가 다르면 브라우저는 각각의 오리진에 상태를 저장한다. 확장의 Webview는 앱과 다른 오리진에서 열린다. `127.0.0.1`로 연 개발 서버와 프리뷰는 같은 포트의 `localhost`를 Webview 오리진으로 쓰므로 설정이 필요 없다. coder 같은 포워딩 주소로 열 때는 [포워딩 주소에서 실행하기](#포워딩-주소에서-실행하기)를 따른다.

## 편집하고 배치하기

- 위쪽 메뉴 바의 **File → New Text File**로 Monaco 편집기를 연다. 에디터 툴바의 **Split Editor Right**는 같은 문서를 두 그룹에서 보여 준다. 한쪽에서 편집한 내용은 다른 쪽에도 반영된다.
- 탭을 같은 탭 줄에서 끌어 순서를 바꾸거나 다른 그룹의 중앙에 놓아 옮긴다. 본문의 가장자리에 놓으면 그룹을 그 방향으로 나눈다. 탭 줄의 빈 공간을 잡으면 그룹 전체가 이동한다.
- 왼쪽 액티비티 바에서 **Explorer**나 **Hello World**를 열면 사이드바에 해당 뷰가 표시된다. 아이콘을 아래 패널의 탭 줄로 끌거나 컨텍스트 메뉴의 **Move to Panel**을 선택하면 컨테이너의 뷰가 함께 이동한다. **View: Reset View Locations**는 컨테이너를 기본 위치로 돌린다. 새시를 끌어 사이드바와 패널 크기를 조절할 수 있다.
- 하단 상태 표시줄에 워크벤치와 확장의 상태 항목이 표시된다. **Hello World**의 **Greetings** 트리를 펼치고 뷰 툴바의 **Say Hello**를 실행하면 메시지와 상태 항목을 확인할 수 있다.

## 팔레트와 키

**F1**, **Ctrl+Shift+P**(macOS에서는 **Cmd+Shift+P**) 또는 **View → Command Palette**로 커맨드 팔레트를 연다. 커맨드 이름의 일부를 입력하고 **Enter**로 선택한다. 키가 연결된 커맨드는 메뉴와 팔레트에 키를 표시한다. WYSIWYG 편집면 밖에서는 **Ctrl+B**로 사이드바를 표시하거나 숨긴다. **Ctrl+J**로는 패널을 표시하거나 숨긴다. macOS에서는 두 키의 **Ctrl** 대신 **Cmd**를 쓴다.

새 텍스트 파일은 **Ctrl+Alt+N**으로 연다. Windows에서는 **Ctrl+K**를 누른 뒤 **N**을 누르고, macOS에서는 **Cmd+Option+N**을 쓴다. **File → New Text File**이나 팔레트의 **File: New Untitled Text File**로도 열 수 있다.

브라우저는 **Ctrl+N**, **Ctrl+W**, **Ctrl+T**와 macOS의 대응 키를 자체 창이나 탭에 사용할 수 있다. 워크벤치의 에디터를 닫으려면 탭의 닫기 버튼이나 팔레트의 **View: Close All Editors**를 사용한다.

**Go to Symbol in Workspace**는 확장이 제공한 워크스페이스 기호를 검색한다. 키는 **Ctrl+T**(macOS에서는 **Cmd+T**)이다. 검색 화면은 입력이 `#`로 시작한 채 열리고, `#` 뒤에 기호 이름을 입력한다. 커맨드 팔레트에 `#`를 입력해서는 열리지 않는다. 브라우저 탭이 이 키를 가져가면 팔레트에서 **Go to Symbol in Workspace...**를 실행한다. 팔레트는 `>` 없이 커맨드만 보여 주는 화면으로 따로 열린다. 이 화면은 기호를 제공하는 확장이 활성화된 뒤에 결과를 낸다. 자세한 동작은 [언어 기능](extension-api-language-features.md#워크스페이스-기호-go-to-symbol-in-workspace)에 있다.

## 파일 다루기

워크스페이스는 브라우저 저장소(IndexedDB)에 있는 폴더 하나(`vscode-vfs://writing-room/workspace`)다. 처음에는 비어 있다. **File → New File...**로 파일을 만들고 Explorer에서 폴더와 파일을 만들고 이름을 바꾸고 지운다. 파일을 올리고 내려받을 수도 있다. **Ctrl+S**로 저장하고 **File → Save As...**로 다른 이름으로 저장한다. 텍스트가 있는 제목 없는 탭과 고친 파일의 탭은 닫기 전에 **Save**, **Don't Save**, **Cancel**을 묻는다. 폴더 열기, 다중 루트, 로컬 디스크 연결은 없다. 같은 사이트 주소의 같은 브라우저 프로필에서만 파일이 보이며 브라우저가 사이트 데이터를 지우면 파일도 사라진다. 자세한 동작은 [파일 편집과 Explorer](files-and-explorer.md)에 있다.

## 마크다운 편집하기

- Explorer에서 `.md`나 `.markdown` 파일을 열면 WYSIWYG 모드로 표시된다. 제목 툴바의 **Switch to Markdown Source** 또는 **Switch to WYSIWYG**, 팔레트의 **Markdown: Toggle Source Mode**, **Ctrl+Shift+M**(macOS는 **Cmd+Shift+M**)으로 같은 탭에서 모드를 바꾼다. 커서는 같은 블록 근처로 이동한다.
- 새 탭을 원문 모드로 열려면 사용자 설정에 `"markdownEditor.defaultMode": "source"`를 추가한다. 기본값은 `wysiwyg`이고, `workbench.editorAssociations`에서 지정한 에디터가 새 탭에 우선한다. 열려 있는 탭은 새로고침 뒤에도 선택했던 모드와 저장하지 않은 초안을 복원한다.
- 원문과 WYSIWYG는 파일 내용과 dirty 표시를 공유한다. WYSIWYG의 **Edit → Undo**와 **Edit → Redo**, **Ctrl+Z**, **Ctrl+Shift+Z**, **Ctrl+Y**(macOS에서는 **Cmd**)는 같은 이력에 적용된다. 500ms 안에 이어서 입력한 글자는 한 번에 되돌아가며, 서식 명령과 외부 편집은 각각 한 단계다.
- 모드를 전환하면 전환 순간의 파일 내용이 새 이력의 시작점이 된다. 그 뒤에 한 첫 편집을 되돌리면 전환 순간의 내용으로 돌아온다. 원문 이력은 같은 파일의 Monaco 창이 공유한다.
- 확장이 제공하는 **Markdown Preview**는 **View: Reopen Editor With...**에서 선택할 수 있다. Monaco의 언어 기능 및 편집기 전용 확장 명령은 원문 모드에서 사용한다. [마크다운 저장 규칙](markdown-editor.md)

### 서식 툴바

- WYSIWYG 본문 위 툴바에서 서식을 바꾼다. **Tab**으로 툴바에 들어가고 좌우 화살표로 버튼을 이동한다. **Enter**로 버튼이나 드롭다운을 열고, 드롭다운 안에서는 위아래 화살표와 **Enter**로 선택한다. **Esc**로 메뉴를 닫는다.
- **Style**에서 본문, 제목 1–6, 부제목, 인용, 코드 블록을 고른다. 부제목은 `{.subtitle}`을 붙인 문단으로 저장하며 개요에 들어가지 않는다. 선택한 블록의 스타일이 서로 다르면 **Style**에 대시가 표시된다. **Ctrl+Alt+0**은 본문, **Ctrl+Alt+1–6**은 해당 단계의 제목을 적용한다. macOS에서는 **Cmd+Option**을 쓴다.
- 정렬 버튼 셋과 **Size**, **Font**는 Markdown 클래스 프리셋을 적용한다. **Align Left**는 정렬 클래스를 지우고 **Align Center**와 **Align Right**는 `{.center}`와 `{.right}`를 붙인다. **Ctrl+Shift+L/E/R**은 왼쪽/가운데/오른쪽 정렬이다. 이미 있는 `{.justify}`는 그대로 읽고 저장하며, 그 블록에서는 세 버튼 모두 눌리지 않는다. **Size**는 8–72pt 중에서 고르고 `{.size-12pt}`처럼 저장한다. **Font**는 Noto Sans KR, Noto Serif KR, 나눔명조, 나눔고딕, monospace 중에서 고르고 `{.font-noto-serif-kr}`처럼 저장한다. 크기와 글꼴은 블록 전체를 선택하면 블록에, 텍스트 일부를 선택하면 해당 범위에 적용된다. 일부 선택에서 **Default**는 인라인 재정의를 지워 블록의 값을 상속한다. 기존 `size-sm`·`size-lg`·`size-xl`은 **Size**에 **Custom**으로, `font-serif`·`font-sans`는 **Font**에 **Serif**·**Sans Serif**로 표시되며 드롭다운에는 없다. 이 두 클래스의 CSS 글꼴 목록은 `markdownEditor.fontFamily`의 `serif`와 `sans`에 설정할 수 있다.
- 본문은 기본으로 가운데에 놓이고 좌우 빈 공간에는 빗금이 그려진다. 빈 공간을 누르면 왼쪽은 그 줄의 시작, 오른쪽은 그 줄의 끝, 본문 아래는 문서 끝에 커서가 간다. 툴바의 **Content Width (characters)** 칸에 20–400 사이의 글자 수를 넣고 **Enter**를 누르거나 칸을 벗어나면 `markdownEditor.contentWidth`(기본 `80`)에 저장되어 열린 모든 Markdown 편집기에 적용된다. **Center Content**와 **Fill Editor Width**는 `markdownEditor.contentLayout`(`center` 또는 `fill`)을 바꾸며, 전체 채우기에서는 폭 칸이 비활성화된다. 집중 모드는 이 두 설정 대신 `markdownEditor.focusMode.width`를 쓴다.
- 굵게는 **Ctrl+B**, 기울임은 **Ctrl+I**, 취소선은 **Ctrl+Shift+X**, 인라인 코드는 **Ctrl+E**, 링크 편집은 **Ctrl+K**다. macOS에서는 **Cmd**를 쓴다. 링크의 기존 URL은 입력창에 채워지며, 빈 값으로 수락하면 링크를 제거한다. 선택 없이 새 링크를 만들면 URL이 링크 텍스트가 된다. 툴바 작업은 **Markdown** 카테고리의 커맨드 팔레트에서도 실행할 수 있다.

#### Deviations from VS Code

- 편집 가능한 WYSIWYG 편집면에서 **Ctrl+B**, **Ctrl+K**, **Ctrl+Shift+E**, **Ctrl+Shift+X**는 Markdown 서식 단축키다. 원문 모드와 편집면 밖에서는 워크벤치의 사이드바, 코드 편집 명령, Explorer, Extensions 단축키를 사용한다.

### 블록 편집과 붙여넣기

- WYSIWYG 툴바에서 글머리 목록, 번호 목록, 작업 목록, 표, 구분선, 이미지를 넣는다. 작업 항목의 체크박스를 눌러 완료 상태를 바꾼다. **Table** 메뉴에서는 행·열을 추가하거나 지우고 열 정렬을 선택한다.
- 일반 문단과 제목에서 **Tab**과 **Shift+Tab**은 포커스 순서를 따른다. 목록에서는 들여쓰기와 내어쓰기에, 표에서는 다음·이전 셀 이동에 쓰며 편집기에 포커스가 남는다. 코드 블록에서는 커서 줄이나 선택된 줄을 **Tab**으로 네 칸 들여쓰고, **Shift+Tab**으로 줄 시작의 탭 하나 또는 공백 네 칸까지 뺀다.
- 줄 첫머리에 제목, 목록, 작업 항목, 인용, 코드 펜스, 구분선의 Markdown 표기를 입력하면 블록으로 바뀐다. 굵게·기울임·취소선·인라인 코드도 닫는 기호를 입력하면 적용된다. 직후 **Backspace**로 변환을 되돌린다.
- 웹에서 복사한 HTML은 제목·목록·링크 등의 문서 구조와 지원하는 서식을 가져온다. 일반 텍스트 클립보드는 Markdown으로 읽는다. **Ctrl+Shift+V**(macOS는 **Cmd+Shift+V**)는 입력한 표기를 그대로 붙인다. 편집기에서 복사하면 Markdown 텍스트와 렌더된 HTML이 함께 클립보드에 들어간다.
- **Image**에서 주소와 대체 텍스트를 입력한다. 작업 폴더에 있는 이미지는 문서의 폴더를 기준으로 찾는다. 원격 HTTPS 이미지는 **Load image**를 눌러 불러온다. [이미지 표시와 저장 규칙](markdown-editor.md#편집-모드와-실행-취소)

### 분량과 집중 모드

- 상태 표시줄은 전체 문서 또는 선택 범위의 단어 수와 공백 포함·제외 글자 수를 보여 준다. 두 모드에서 표시 텍스트를 기준으로 센다. 언어에 관계없이 줄바꿈을 포함한 공백으로 나뉜 부분을 각각 한 단어로 세며, 글자 수는 Unicode 코드 포인트 단위로 센다.
- Explorer의 **Outline**은 제목 1–6을 계층으로 표시하고 현재 절을 강조한다. 제목을 선택하면 두 모드 모두 해당 위치로 이동한다.
- WYSIWYG에서 **View → Appearance → Markdown Focus Mode** 또는 **Markdown: Toggle Focus Mode**를 실행하면 본문을 가운데 놓고 사이드바·패널·액티비티 바·상태 표시줄을 숨긴다. 커맨드를 다시 실행하거나 본문에서 **Esc**를 누르면 원래 레이아웃으로 돌아온다.
- `markdownEditor.focusMode.width`의 기본값은 `72ch`다. `markdownEditor.focusMode.dimOthers`를 끄면 집중 모드에서도 모든 문단이 선명하다. `markdownEditor.typewriterScroll`을 켜면 WYSIWYG에서 타이핑하거나 키보드로 이동할 때 커서 줄을 세로 가운데에 둔다. 타자기 스크롤은 기본으로 꺼져 있다.

## 사용자 설정 편집하기

**File → Preferences → Open User Settings (JSON)** 또는 팔레트의 **Preferences: Open User Settings (JSON)**으로 `settings.json`을 연다. 예를 들어 `{"editor.fontSize": 24}`를 쓰고 **Ctrl+S**(macOS에서는 **Cmd+S**)를 누르면 열린 편집기에 적용한다. Monaco에서 키를 자동 완성하고 값의 오류를 표시한다. 주석과 후행 쉼표를 쓸 수 있다. 지원하는 키와 기본값은 [아키텍처의 Settings 절](architecture.md#settings)에 있다.

## 확장 추가하기

- **Open VSX에서 찾기**: 액티비티 바의 **Extensions**(Ctrl+Shift+X, macOS에서는 Cmd+Shift+X)에서 **Search Open VSX**에 이름을 입력하고 **Install**을 선택한다. 내려받은 뒤 확인 화면이 식별자, 버전, 라이선스, 크기, SHA-256, 서명 상태를 보여 준다. Microsoft 마켓플레이스는 지원하지 않는다.
- **VSIX 파일**: 팔레트의 **Install from VSIX...**로 `.vsix`를 고르거나 **Extensions**의 검색 영역에 끌어다 놓는다. 팔레트의 **Install Extension from Location...**에 `.vsix`로 끝나는 주소를 입력해도 된다. VSIX는 크기 한도와 내용을 검사하고, 받은 바이트의 SHA-256을 확인 화면에 보여 준다. 비교할 갤러리 값과 서명이 없어 아래 「서명의 뜻」의 확인은 하지 않는다.
- **폴더 URL**: **Install Extension from Location...**에 `package.json`을 제공하는 폴더 주소를 입력하고, 표시된 출판자·버전·오리진을 확인한 뒤 설치 항목을 선택한다. 원격 서버는 HTTPS와 CORS를 지원해야 하며 로컬 개발용 루프백 주소에는 HTTP를 쓸 수 있다.
- **내장 확장**: 매니페스트 `package.json`과 필요한 웹 진입 파일을 `extensions/` 아래의 한 폴더에 둔다. 개발 서버를 다시 시작하거나 프리뷰 빌드를 새로 만든다. `extensions/hello-world/`를 예제로 사용할 수 있다.
- **제거**: **Extensions**의 **Installed**에서 **Uninstall**을 선택하거나 팔레트의 **Uninstall Extension...**에서 해당 확장을 고른다.
- 지원하는 매니페스트 항목, Worker에서 사용할 수 있는 API와 격리 경계는 [확장 API](extension-api.md)에 있다. 확장은 `browser` 진입점이 있는 웹 확장이어야 코드가 동작한다. `main`만 있는 데스크톱 확장은 기여만 적용된다. 실제 Open VSX 확장으로 확인한 범위는 [인수한 확장](extension-api.md#인수한-확장)에 있다.

### 서명의 뜻

Open VSX에서 받은 패키지는 설치할 때 화면에 표시된 Open VSX에서 공개 키를 받아 Ed25519 서명을 확인한다. 서명은 전송 경로나 CDN에서 패키지가 바뀌지 않았음을 확인한다. 갤러리 자체가 침해되면 막지 못한다. 이 확인에는 규칙이 셋 있다.

- SHA-256은 서명과 관계없이 늘 확인한다. 설치할 바이트에서 계산한 값이 갤러리가 준 값과 다르면 설치하지 않는다.
- 서명이 있는데 검증에 실패하면 설치하지 않는다.
- 서명이 없는 패키지는 경고(**This package has no signature**)를 보이고 확인을 받은 뒤 설치한다. 브라우저가 Ed25519를 지원하지 않아 서명을 확인하지 못한 패키지도 경고(**This browser could not verify the Ed25519 signature**)와 확인을 거친다. 두 경고의 기본 선택은 **Cancel**이다.

VSIX 파일과 `.vsix` 주소로 설치하는 패키지에는 이 규칙이 적용되지 않는다. 서명을 확인하지 않으므로 확인 화면의 서명 상태는 늘 `unsigned`이지만 위 경고는 표시되지 않고, 같은 확인 화면(기본 선택 **Cancel**)을 거친다. SHA-256은 비교할 값이 없어 계산해 보여 주기만 한다.

설치 한도와 확인 화면의 선택지는 [확장 설치](extension-installation.md)에 있다.

## 포워딩 주소에서 실행하기

coder처럼 포트를 포워딩하는 환경에서 앱을 열 때 확장의 Webview(Markdown 미리보기 등)를 쓰려면 둘째 포트가 필요하다. Webview는 앱과 다른 오리진에서 열려야 하는데 포워딩 주소에서는 `localhost` 교차를 쓸 수 없기 때문이다. 앱의 포트가 5173이고 Webview의 포트가 5174라면 다음과 같이 한다. 명령과 환경 변수 이름은 [Webview의 같은 절](extension-api-webview.md#포워딩-주소에서-실행하기)과 같다.

1. 두 포트를 띄운다. `WRITING_ROOM_WEBVIEW_PORT`가 둘째 포트를 연다.
   - 개발:

     ```sh
     WRITING_ROOM_WEBVIEW_PORT=5174 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
     ```

   - 프리뷰: `npm run build`를 한 뒤 다음을 실행한다.

     ```sh
     WRITING_ROOM_WEBVIEW_PORT=5174 npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
     ```

     프리뷰의 앱 포트는 4173이므로 아래의 앱 포트는 4173으로 읽는다.
2. 두 포트(5173과 5174, 프리뷰는 4173과 5174)를 각각 포워딩한다.
3. 앱 포트의 포워딩 주소로 워크벤치를 연다. 주소에 앱 포트 숫자(`5173--…`)가 한 번만 나타나야 한다.
4. 같은 주소에서 `/webview/config.json`을 열어 `{"appPort":5173,"webviewPort":5174}`처럼 두 포트가 실제와 맞는지 확인한다.
5. 처음 한 번 Webview 포트의 주소 `https://5174--<나머지>/webview/index.html`을 새 탭에서 열어 포워딩 서비스에 로그인한다. 셸만 직접 열면 빈 페이지가 보이는 것이 정상이다.
6. 워크벤치로 돌아가 Webview를 여는 확장 명령을 실행한다. 예를 들어 `vscode.markdown-language-features`를 설치하고 Markdown 파일을 원문 모드로 전환한 뒤 **Ctrl+Shift+V**를 누른다.

`WRITING_ROOM_WEBVIEW_PORT` 없이 포워딩 주소로 열면 Webview 대신 "Webviews need a separate origin. Set WRITING_ROOM_WEBVIEW_PORT for forwarded addresses."로 시작하는 안내가 보인다. 같은 오리진으로 물러서서 열지 않는다. 안내가 보이면 변수를 주었는지, 두 포트를 포워딩했는지, 둘째 주소에 로그인했는지 확인한다. 포워딩 주소와 `127.0.0.1` 주소는 오리진이 달라서 설치한 확장, 파일, 설정이 따로 저장된다. v0.2.0은 담당자가 coder 포워딩 주소(앱 5173, Webview 5174)로 띄워 실행해 보고 잘 동작함을 확인했다(2026-11-20). 이 확인이 이 절의 수동 확인 절차를 대신한다. 포트 설정의 세부와 오리진을 고르는 순서는 [Webview](extension-api-webview.md)에 있다.

## 새로고침 뒤 이어서 작업하기

같은 브라우저 프로필에서 같은 사이트 주소를 열면 파트 크기·표시 여부, 뷰 컨테이너의 위치·선택, 에디터 그룹과 탭, 저장한 사용자 설정, 설치한 확장을 복원한다. 열려 있던 설정 탭은 편집 중이던 초안 내용까지 복원하며, 실제 설정 반영은 저장할 때 이루어진다. 제목 없는 문서의 텍스트는 최근 사용 순으로 합계 UTF-16 코드 유닛 1,000,000개까지 저장한다. 이 용량 한도로 제외되는 텍스트가 있으면 페이지를 벗어날 때 브라우저 확인 대화상자가 나타난다. 복원된 에디터는 문서 맨 첫 줄에서 열린다. 파일을 수정하던 중 저장하지 않은 채 새로고침하더라도 파일의 초안이 복원된다. 탭 목록에서 빠진 파일의 초안도 시작할 때 열 수 있다. 초안 데이터는 페이지 세션 단위로 보존된다. 열려 있는 세션의 초안은 그 탭에 남고, 종료된 세션의 초안은 새로 시작한 탭에서 복구한다. 같은 파일을 다른 탭에서 이미 저장했다면 덮어쓰기 전에 사용자 확인을 거친다. 세부 복구 경로는 [초안 백업과 새로고침](files-and-explorer.md#초안-백업과-새로고침)에서 확인할 수 있다.

v0.2.0은 탭 편집, 도킹, 설정 JSON, 브라우저 저장소의 파일, 웹 확장에 집중한다. 터미널, 디버그, 노트북, 설정 UI, 로컬 디스크 연결은 범위 밖이다. 색 테마는 내장 테마 **Writing Room Dark**(기본)와 **Writing Room Light**, 확장이 기여한 테마 가운데에서 팔레트의 **Preferences: Color Theme**으로 고른다.

## 검증하기

- `npm run typecheck`는 TypeScript를 확인하고, `npm test`는 Vitest 단위 테스트를 실행한다. 단위 테스트가 쓰는 jsdom에는 레이아웃이 없어 `getBoundingClientRect()`가 크기 0의 사각형을 돌려준다.
- 처음 브라우저 테스트를 실행하기 전에 `npx playwright install chromium`으로 Chromium을 설치한다. `npm run test:e2e -- --workers=2`는 개발 서버에서 브라우저 스위트를 실행한다. `E2E_TARGET=preview npm run test:e2e -- --workers=2`는 새 프로덕션 빌드를 만든 뒤 같은 스위트를 실행한다. 앱과 원격 확장 픽스처 서버는 Playwright가 각각 시작한다. 프리뷰 대상은 타입 검사와 빌드를 먼저 하므로 앱 서버를 기다리는 제한이 300초다(`playwright.config.ts`). 부하가 큰 컴퓨터에서는 빌드가 1분을 넘겨 개발 서버용 60초 제한에 걸렸다.
- 실제 확장(Open VSX의 Markdown 확장 셋과 바닥 후보 셋)으로 하는 테스트는 `node scripts/fetch-real-extensions.mjs`가 채우는 캐시 `test/fixtures/real-extensions/cache/`(git이 무시한다)를 쓴다. 스크립트는 `test/fixtures/real-extensions/pins.json`의 sha256과 Open VSX의 Ed25519 서명을 확인하고, 고정값과 다른 캐시 파일은 덮어쓰지 않고 실패한다(그 파일을 지우고 다시 돌린다). `--offline`은 네트워크 없이 캐시만 검사한다. 캐시가 없거나 맞지 않으면 브라우저 스위트는 사유를 출력하고 실제 확장 테스트만 건너뛴다. `E2E_REQUIRE_REAL_EXTENSIONS=1`이면 대신 실행이 실패한다.
- `node scripts/probe-extension.mjs [<확장 id>...]`는 고정한 확장을 지금 확장 호스트에 올려, 로드·활성화·첫 문서 단계별로 읽은·부른·없는 API 멤버와 오류를 `test/fixtures/real-extensions/cache/probe-results/<id>.json`에 쓴다. 브라우저는 127.0.0.1 밖의 호스트를 풀지 못하게 띄운다.
- 포워딩 주소에서의 Webview는 자동 테스트가 포워딩 주소를 흉내 내는 프록시로 확인하고(`test/e2e/webview-forwarded.spec.ts`, 미리보기는 `test/e2e/real-markdown-preview.spec.ts`), 실제 coder 포워딩 주소에서의 수동 확인은 담당자가 2026-11-20에 마쳤다([포워딩 주소에서 실행하기](#포워딩-주소에서-실행하기)).
- `npm run test:e2e -- test/e2e/acceptance.spec.ts`는 도킹, 설정, 확장 설치 및 새로고침을 한 번에 확인하는 인수 시나리오만 실행한다. `moai wiki ls`로 위키 페이지와 링크를 확인할 수 있다.

Decided in: wr-cla6, wr-jbmd, wr-ndsy, wr-hbrm, wr-h2sa
