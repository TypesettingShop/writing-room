# Webview

Webview는 확장이 만든 HTML을 에디터나 뷰에 표시한다. 브라우저는 워크벤치와 다른 오리진에서 HTML을 실행한다. [확장 API](extension-api.md)

## 포워딩 주소에서 실행하기

워크벤치는 브라우저 탭에서 연다. 앱과 웹뷰 셸의 두 포트를 포워딩한다. 앱의 포트가 5173이고 웹뷰의 포트가 5174라면 다음 명령으로 개발 서버를 연다.

```sh
WRITING_ROOM_WEBVIEW_PORT=5174 npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

프리뷰는 `npm run build` 뒤 같은 환경 변수와 인자로 `npm run preview`를 실행한다. 포트는 시작할 때 읽으므로 포트를 바꾼 뒤 프리뷰를 다시 빌드할 필요가 없다. 앱과 같은 포트 또는 이미 쓰는 포트를 주면 서버 시작이 실패한다.

1. Coder에서 5173과 5174를 각각 포워딩한다. 워크벤치의 주소에 `5173--`처럼 앱 포트 숫자가 한 번만 나타나는지 확인한다.
2. 워크벤치의 같은 주소에서 `/webview/config.json`을 열어 `appPort`와 `webviewPort`가 실제 포트와 맞는지 확인한다.
3. 웹뷰 셸 주소 `https://5174--<나머지>/webview/index.html`을 새 탭에서 한 번 열어 포워딩 서비스에 로그인한다. 셸만 직접 열면 빈 페이지가 보인다.
4. 워크벤치로 돌아가 웹뷰를 여는 확장 명령을 실행한다. 웹뷰의 외부 iframe이 5174 포워딩 주소를 쓰며 확장의 스크립트나 CSS가 적용됐는지 확인한다.
5. 포트가 다른 호스트에서 `/`와 `/webview/config.json`을 열어 모두 404인지 확인한다. 그 호스트는 셸 HTML과 서비스 워커 파일을 제공한다.

워크벤치는 웹뷰가 필요해질 때 자기 오리진의 설정을 읽으며, Coder처럼 인증이 필요한 포워딩 서비스의 세션 쿠키도 같은 오리진 요청으로 보낸다. 설정 읽기가 실패하면 다음 웹뷰 요청에서 다시 읽는다. 포워딩 셸은 둘째 리스너가 셸 HTML에 넣은 실제 포트 쌍으로 워크벤치의 오리진을 확인한다.

안내가 보이면 서버 실행 시 `WRITING_ROOM_WEBVIEW_PORT`를 주었는지, 포트 두 개를 포워딩했는지, 브라우저에서 두 번째 주소에 로그인했는지 확인한다. 셸과 연결할 수 없으면 10초 뒤에 안내를 표시한다. 포워딩 주소와 루프백 주소의 설치 확장, 파일, 설정은 브라우저 오리진에 따라 별도로 저장된다.

## 오리진 선택

Vite 제품 설정 `VITE_WRITING_ROOM_PRODUCT`의 `webviewContentExternalBaseUrlTemplate`가 있으면 먼저 사용한다. 정적 배포는 그 HTTPS 오리진의 `/webview/`에 배포 빌드의 셸과 서비스 워커를 둔다. `{{uuid}}`를 호스트 이름에 넣으면 웹뷰마다 별도 오리진을 쓸 수 있다. 배포하는 `webview/index.html`에서 `writing-room-webview-parent-origin` 메타 태그의 `content`에 워크벤치의 정확한 HTTPS 오리진을 적는다. 예를 들어 앱이 `https://workbench.example.com`이면 그 문자열을 그대로 사용한다. 경로나 끝 슬래시는 두지 않는다. 셸은 워크벤치 주소가 지정된 경우에만 연결을 연다.

제품 설정이 없으면 개발 서버와 프리뷰는 같은 포트의 `127.0.0.1`과 `localhost`를 서로 바꾼다. 두 루프백 호스트는 같은 Vite 서버에서 파일을 가져오지만 브라우저 저장소를 오리진별로 사용한다. 포워딩은 페이지의 호스트 이름에 있는 앱 포트 표식을 교체한다. 설정을 검증할 수 없거나 같은 오리진이 나오면 웹뷰를 열기 전에 안내를 표시한다.

## 패널의 콘텐츠와 메시지

`window.createWebviewPanel(viewType, title, showOptions, options)`으로 에디터 탭을 연다. `viewType`은 복원과 메뉴에 쓰는 고정 식별자다. `webview.html`에 전체 문서를 넣고, `enableScripts: true`를 설정한 패널에서 `acquireVsCodeApi()`를 한 번 호출한다.

아래 예에서 스크립트는 확장의 `media` 폴더에 있다. 로컬 파일의 주소는 `asWebviewUri`로 바꾸고, CSP에 그 파일을 제공하는 웹뷰 오리진을 명시한다.

```js
const media = vscode.Uri.joinPath(context.extensionUri, 'media')
const panel = vscode.window.createWebviewPanel('example.preview', 'Preview', vscode.ViewColumn.Beside, {
  enableScripts: true,
  localResourceRoots: [media],
})
const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'preview.js'))
panel.webview.html = `<!doctype html>
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src ${panel.webview.cspSource}">
  <main id="preview"></main>
  <script src="${script}"></script>`
```

`localResourceRoots`의 기본값은 현재 워크스페이스와 그 확장의 설치 폴더다. 읽기는 정규화된 루트 안에서 파일마다 50 MiB까지 허용된다. HTTP(S) 링크를 누르면 워크벤치가 주소를 보여 주고 확인을 거쳐 열어 준다.

확장과 화면의 양방향 메시지는 `Webview.postMessage` 및 `onDidReceiveMessage`, 화면의 `acquireVsCodeApi().postMessage` 및 `message` 이벤트를 사용한다. 패널을 숨기면 기본값으로 HTML 문서를 버리며, 이 동안 확장에서 보낸 메시지의 결과는 `false`다. `retainContextWhenHidden`을 지정한 패널은 화면 바깥에 있을 때에도 문서를 유지한다.

`webview/context` 메뉴의 `webviewId`는 패널의 `viewType` 또는 뷰의 ID다. 콘텐츠 안에서 `data-vscode-context='{"webviewSection":"preview"}'`와 같이 요소별 컨텍스트를 제공할 수 있다.

## 탭 아이콘

`panel.iconPath`에 `ThemeIcon`, 이미지 URI 하나, 또는 밝은 테마와 어두운 테마에 쓸 `{ light, dark }` URI 쌍을 지정한다. 워크벤치는 현재 테마에 맞는 이미지를 탭 제목 옆에 표시한다. 밝은 고대비 테마는 `light`, 어두운 고대비 테마는 `dark`를 사용한다.

```js
panel.iconPath = {
  light: vscode.Uri.joinPath(context.extensionUri, 'media', 'preview-light.png'),
  dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'preview-dark.png'),
}
```

이미지 URI는 확장 자신의 설치 폴더 안을 가리켜야 한다. URI 쌍이면 두 주소가 모두 이 조건을 충족해야 하며, 선택한 이미지 파일을 최대 256 KiB까지 읽는다. `iconPath`에 `undefined`를 지정하면 아이콘이 사라진다. 새로고침 뒤 복원하는 탭의 저장된 아이콘은 해당 탭이 처음 보일 때 현재 설치 위치를 기준으로 다시 검증한다.

## 새로고침 후 상태 복원

패널의 `viewType`에 해당하는 `onWebviewPanel:<viewType>`을 매니페스트에 적고, 활성화에서 `window.registerWebviewPanelSerializer`를 호출한다. 새로고침 후 해당 탭이 처음 보일 때 확장을 활성화하고 `deserializeWebviewPanel(panel, state)`를 호출한다. 직렬화기는 `panel.webview.html`과 이벤트 구독을 다시 설정한다.

레이아웃에는 탭 제목, 확장 ID, 표시 옵션과 리소스 루트 등 입력 메타데이터를 저장한다. 웹뷰의 `setState`가 넘긴 JSON은 워크스페이스의 별도 키에 저장하며 웹뷰당 256 KiB, 워크스페이스당 전체 1 MiB까지 허용한다. 숨겼다가 다시 연 문서의 `getState`와 새로고침 뒤 직렬화기에 이 상태가 전달된다. 한도를 넘긴 업데이트는 마지막으로 저장한 상태를 유지하고 한 번 경고한다.

## 확장 호스트 재시작

명령 팔레트에서 **Restart Extension Host**를 실행하면, 정상 종료 경로에서 기존 Worker가 살아 있는 패널 객체마다 `onDidDispose`를 한 번 전달한다. 직렬화할 수 있는 탭은 배치와 저장 상태를 보존하며 새 Worker에서 새 핸들로 복원된다. 다른 WebviewPanel 탭은 닫힌다. Worker가 이미 응답하지 않는 경우에는 종료 시한에 맞춰 교체된다 (wr-drjj).

## 사이드바와 패널의 WebviewView

매니페스트의 `contributes.views`에 `"type": "webview"`를 지정한다. 확장은 같은 ID로 `window.registerWebviewViewProvider`를 호출하고, `resolveWebviewView(view, context, token)`에서 `view.webview.html`을 설정한다. 상태는 `context.state`로 전달된다. 사이드바와 패널 사이에서 컨테이너를 옮길 때 브라우저 프레임은 유지된다.

## Deviations from VS Code

- wr-cpnc.hs9, wr-cpnc.hmr. 개발과 프리뷰의 루프백 경로와 포워딩 모드는 워크벤치와 웹뷰의 오리진을 분리한다. 같은 웹뷰 오리진에 여러 문서가 뜨는 모드에서는 그 문서들이 브라우저의 같은 오리진 권한을 공유한다. 웹뷰마다 다른 오리진이 필요한 배포는 호스트 이름에 `{{uuid}}`가 들어간 HTTPS 주소 틀을 사용한다.
- wr-cpnc.flj. 찾기와 `portMapping`은 옵션을 받되 동작하지 않는다. `enableCommandUris`도 옵션을 받으며 링크 처리는 HTTP와 HTTPS를 지원한다.
- wr-cpnc.flj. 로컬 파일과 확장 리소스는 메인 스레드의 파일 서비스를 통해 읽는다. `asWebviewUri`는 `http(s)` 주소도 웹뷰 리소스 주소로 바꾼다. VS Code는 이런 주소를 그대로 돌려준다. 바뀐 주소는 `localResourceRoots` 안에 있을 때만 읽히므로 CDN 같은 외부 주소는 `asWebviewUri`를 거치지 않고 그대로 쓴다.
- wr-cpnc.flj. `localResourceRoots`에는 워크스페이스 폴더와 그 확장의 설치 폴더 안쪽 루트만 남는다. 다른 확장의 폴더나 `globalStorageUri` 같은 사용자 저장소 루트는 경고 없이 빠진다.
- wr-cpnc.flj. `TabInputWebview.viewType`은 확장이 패널을 만들 때 전달한 식별자다. VS Code의 탭 API는 `mainThreadWebview-` 접두사를 붙인다.
- wr-ob6x. Writing Room은 탭 아이콘 이미지의 URI를 소유 확장의 설치 폴더로 제한한다. VS Code의 탭 아이콘 설정 경로에는 같은 설치 폴더 검사가 없다. [VS Code의 탭 아이콘 설정 구현](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/browser/mainThreadWebviewPanels.ts)
- wr-cpnc.6ly. 뷰 배지는 이 에픽의 범위 밖이다.

Decided in: wr-efqx.n9k, wr-cpnc
