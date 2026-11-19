# 에디터 이음매: 모델, 에디터, 해석기, 컨텍스트 키

v0.2.0의 흐름 에픽(문서 API, 파일 편집, Webview, Custom Editor, 언어, 테마)이 서로를 기다리지 않고 만나는 자리다. 이 페이지는 그 자리를 쓰는 사람, 곧 다음 에픽의 일꾼과 확장 기여를 읽는 사람을 위한 것이다. 화면에 보이는 변화는 없다. wr-h23m이 만들었다.

## 서비스와 기본 구현

`editor.contribution.ts`가 아래 서비스를 등록한다. 실제 구현을 가진 에픽은 같은 식별자로 다시 `registerSingleton`한다. 마지막 등록이 이기므로, 그 모듈은 `editor.contribution.ts`보다 뒤에 가져와야 한다(가져오기 목록은 `workbench.web.main.ts`). 값을 들고 있는 소비자는 한 번 읽고 끝내지 말고 서비스의 변경 이벤트를 듣는다.

| 서비스 | 파일 | 기본 구현 | 실제 구현 |
|---|---|---|---|
| `IModelService` | `src/editor/common/services/model.ts` | Monaco 모델(`ModelService`) | 그대로 |
| `ICodeEditorService` | `src/editor/browser/services/codeEditorService.ts` | 그대로 | 그대로 |
| `ITextModelService` | `src/editor/common/services/resolverService.ts` | 참조 세기(`TextModelResolverService`) | 그대로 |
| `ILanguageService` | `src/editor/common/languages/language.ts` | `plaintext`만 아는 `PlaintextLanguageService` | 언어 기여 에픽 |
| `IThemeService` | `src/platform/theme/common/themeService.ts` | v0.1.0의 어두운 팔레트(`DefaultThemeService`) | 테마 에픽 |
| `ITextFileService` | `src/workbench/services/textfile/common/textfiles.ts` | 제목 없는 문서만 아는 `UntitledTextFileService` | 파일 편집 에픽 |
| `IEditorResolverService` | `src/workbench/services/editor/common/editorResolverService.ts` | 제목 없는 문서와 settings.json 등록 | 파일 편집, Custom Editor 에픽이 등록을 더한다 |
| `IOpenerService` | `src/platform/opener/common/opener.ts` | 그대로 | 그대로 |

## 모델과 코드 에디터

- `IModelService`는 자기가 만든 모델만 센다. `onModelAdded`는 모델이 `getModels()`에 든 뒤에, `onModelRemoved`는 목록에서 빠진 뒤 모델이 지워지기 전에 한 번씩 난다. 두 그룹이 한 입력을 보여도 모델은 하나다.
- 리소스로 입력을 만드는 곳은 먼저 열린 같은 리소스의 입력을 찾아 쓴다(제목 없는 문서의 해석기 등록이 그렇게 한다). 입력이 모델의 주인이라 한 모델에 입력이 둘이면 한쪽을 닫을 때 다른 탭의 텍스트가 사라진다 — [교훈](lessons/reuse-open-input-that-owns-its-model.md).
- `createModel(value, languageId, resource)`는 비동기다. 언어 id를 주지 않으면 `ILanguageService`에 경로로 묻고, 답이 없으면 `plaintext`다. 언어를 바꾸려면 `setModelLanguage`를 부르고 `onModelLanguageChanged`(이전 id와 새 id)를 듣는다.
- `ITextModel`(`src/editor/common/model.ts`)에는 문서 동기화가 쓰는 버전, 줄, 범위, 위치와 오프셋 변환, `applyEdits`, 변경 목록이 든 `onDidChangeContent`, `onDidChangeLanguage`, `onWillDispose`가 있다. 50 MiB를 넘는 모델은 `isTooLargeForSyncing(model)`이 참이고 확장 호스트로 보내지 않는다.
- 텍스트 에디터 페인은 Monaco 에디터를 만들 때 `ICodeEditorService`에 등록하고 해제하기 전에 뺀다. 페인은 재사용되므로 탭을 바꿔도 등록은 그대로이고 에디터의 `onDidChangeModel`이 "보는 모델"의 변화를 알린다. 그룹을 나누면 에디터가 하나 늘고, 그룹이 사라지면 하나 준다.

## 모델 참조

`ITextModelService.createModelReference(resource)`는 참조를 센다.

1. `ITextFileService.canHandleResource`가 참이면(제목 없는 문서, 나중에 파일) 그 서비스의 모델을 빌려 준다. 참조를 놓아도 지우지 않는다. 입력이 주인이다.
2. 이미 있는 모델(예: settings.json)도 빌려 준다.
3. 스킴에 등록한 내용 제공자(`registerTextModelContentProvider`)가 만든 모델은 이 서비스가 주인이다. 마지막 참조가 가면 지운다. 그 사이에 새 참조가 오면 지우지 않는다.
4. 아무도 못 만들면 바로 거부한다.

## 리소스로 에디터 열기

- `IEditorService.openEditor({ resource, options })`가 에디터 해석기로 입력을 만든다. 옵션은 `preserveFocus`, `selection`(1부터 세는 줄과 열), `override`(에디터 id)다.
- 해석기 등록: `registerEditor(glob, { id, label, priority }, { canSupportResource }, factory)`. 우선순위는 `exclusive` > `default` > `builtin` > `option`이고 같으면 긴 glob이 이긴다. 사용자의 `workbench.editorAssociations`(파일 이름 패턴 → 에디터 id)는 `exclusive`가 아닌 한 우선한다. `override`는 glob과 관계없이 그 id를 쓴다. id `default`는 텍스트 에디터이며 다른 후보가 없을 때의 대체다.
- glob에 `/`가 있으면 `scheme:path`에, 없으면 파일 이름에 대소문자 없이 맞춘다. `**`, `*`, `?`, `{a,b}`, `[...]`를 읽는다.
- 맞는 등록이 없으면 빈 페인이 아니라 이유를 적은 오류 에디터가 열린다(`role="alert"`).
- 보이는 에디터: `visibleEditors`, `visibleEditorPanes`, `onDidVisibleEditorsChange`(바뀔 때마다 한 번). `findEditors(resource)`는 모든 그룹에서 찾는다. `onDidCloseEditor`는 에디터가 그룹을 떠날 때 난다.
- 뷰 열 번호는 `editorGroupColumn.ts`가 바꾼다: 0이 화면 순서의 첫 그룹이다(API의 `ViewColumn.One`). 그룹 수를 넘는 열(아홉째까지)은 마지막 그룹 오른쪽에 그룹 하나를 만든다. `ACTIVE_GROUP`, `SIDE_GROUP`은 그대로 간다.

## 저장과 닫기

- `EditorInput`은 `save`, `saveAs`, `revert`, `isReadonly`, `getDescription`, `closeHandler`를 가진다. `save`는 저장한 입력을, 실패나 취소면 `undefined`를 돌려준다. 실패 안내는 입력이 한다.
- `workbench.action.files.save`(Ctrl+S, macOS Cmd+S)는 `src/workbench/contrib/files/browser/fileCommands.ts`에 있고 활성 입력(탭 컨텍스트면 그 탭)의 `save`를 부른다.
- `closeEditor`, `closeEditors`, `closeAllEditors`는 `Promise<boolean>`이다. `closeHandler.showConfirm()`이 참인 입력만, 그리고 다른 그룹이 그 입력을 보여 주지 않을 때만 묻는다. `CANCEL`이면 아무것도 바뀌지 않는다. 한 번의 닫기에서 하나라도 취소하면 모두 남는다. `SAVE`는 저장이 성공해야 닫고, `DONT_SAVE`는 되돌린 뒤 닫는다.
- 묻는 동안 같은 에디터를 또 닫으면 같은 답을 기다린다(두 번 묻지 않는다). 답이 온 뒤 그룹이 사라졌거나 에디터가 옮겨졌으면 닫지 않는다.
- 물을 것이 없으면 v0.1.0처럼 호출이 돌아오기 전에 닫힌다. 지금 묻는 입력은 없다. 내용이 있는 제목 없는 에디터의 확인은 파일 편집 에픽이 `closeHandler`로 단다.
- `ITextFileService`의 `onWillSave`(`waitUntil`), `onDidSave`, `onDidChangeDirty`가 문서 API가 확장으로 넘기는 저장 이벤트다. 기본 구현은 저장하지 않는다.

## 링크 열기

`IOpenerService.open(target, options)`가 링크를 여는 길 하나다.

- `http`, `https`, `mailto`는 전체 주소를 보여 주고 사용자가 **Open**을 고르면 새 탭으로 연다(`noopener,noreferrer`).
- `command:id?인자`는 `options.allowCommands`가 `true`이거나 그 id를 담을 때만 실행한다. 인자는 퍼센트 인코딩한 JSON 배열(또는 값 하나)이다.
- 에디터 해석기가 `option`이 아닌 우선순위로 받는 리소스는 에디터로 연다(`openToSide`면 옆 그룹). `option` 에디터만 받는 리소스는 다음 오프너로 넘긴다.
- `javascript`, `vbscript`, `data`, `blob`, `file`, `about`과 아무도 받지 않는 스킴은 묻지 않고 거부한다(`false`).

## `when` 절과 컨텍스트 키

`when`은 VS Code의 연산자를 모두 읽는다: `==`, `!=`, `!`, `&&`, `||`, 괄호, `=~ /정규식/플래그`, `in`, `not in`, `<`, `<=`, `>`, `>=`, 공백이 든 따옴표 문자열. 비교 연산자 앞에는 공백이 필요하다(`n<1`은 키 이름이다). 틀린 정규식은 구문 오류이고 그 기여만 건너뛴다.

| 키 | 범위 | 뜻 |
|---|---|---|
| `editorLangId`, `editorReadonly`, `editorHasSelection` | 텍스트 에디터 페인 | 페인이 보이는 모델의 언어, 입력이 읽기 전용인가, 선택이 있는가. 모델을 떼면 비운다 |
| `activeEditorIsReadonly`, `activeEditorIsDirty` | 워크벤치, 그리고 각 그룹 | 워크벤치 범위는 활성 그룹의 활성 에디터, 그룹 범위는 그 그룹의 활성 에디터 |
| `resource`, `resourceScheme`, `resourceFilename`, `resourceExtname`, `resourceDirname`, `resourcePath`, `resourceLangId`, `resourceSet` | 워크벤치, 그리고 각 그룹 | 그 에디터의 리소스. `resourceLangId`는 열린 모델의 언어, 없으면 경로로 짐작한 언어다. 그룹의 에디터에 리소스가 없으면 그룹 범위의 키는 `null`이 되어 바깥 값을 가린다 |
| `isWeb`(늘 참), `isMac`, `isLinux`, `isWindows` | 워크벤치 | 플랫폼 |

- 페인의 범위는 그룹 범위의 자식이다. 그래서 비활성 그룹의 제목 메뉴도 활성 그룹이 아니라 자기 에디터로 평가된다. 그룹 제목 메뉴(`editor/title`)는 활성 페인의 범위로 평가하므로 `editorLangId == markdown`인 버튼은 markdown 에디터 위에만 나온다.
- 탭 컨텍스트 메뉴(`editor/title/context`)는 누른 탭의 리소스 키로 평가한다.
- `setContext(key, value)` 커맨드는 문자열, 수, 불리언, `null`과 그것들의 배열과 평범한 객체만 받아 복사해 건다. 확장이 건 키는 확장을 제거해도 남는다(VS Code와 같다).
- `workbenchState`는 파일·워크스페이스 에픽이, `config.*`는 설정 에픽이, 뷰와 Webview의 키는 각 에픽이 자기 파일에서 만든다. `platform/contextkey/**`와 `workbench/common/contextkeys.ts`는 이 에픽 뒤로 아무도 고치지 않는다.

## Deviations from VS Code

- 테마 색은 `Color` 객체가 아니라 CSS 색 문자열이다(`getColor`). 파일 아이콘 테마와 제품 아이콘 테마는 없다 (wr-h23m.6ti)
- `IModelService.createModel`은 비동기이고 `setModelLanguage`를 서비스에 둔다. Monaco 독립 실행형의 모델에는 `setLanguage`가 공개되어 있지 않다 (wr-h23m.6ti)
- 에디터 해석기의 glob 매처는 이 서비스 안에 있다. URI·glob 에픽의 `glob.ts`가 머지되면 그것으로 바꾼다. `explicit` 우선순위, 차이·병합 에디터 연관은 없다 (wr-h23m.4hq)
- 뷰 열 번호가 그룹 수를 넘으면 그룹을 하나만 만든다. VS Code는 그 열까지 채운다 (wr-h23m.4hq)
- 닫을 때 묻는 것은 `closeHandler`가 있는 입력뿐이다. VS Code는 dirty한 입력이면 기본 저장 대화상자를 연다 — 저장할 곳(파일)이 아직 없다 (wr-h23m.4hq)
- 외부 주소의 확인은 모달 대화상자가 아니라 퀵 픽이다(마스터 본문의 확인 대화상자 규칙) (wr-h23m.4hq)
- 제목 없는 탭의 언어는 아직 저장되지 않아 새로고침하면 plaintext로 돌아온다 (wr-2bi0)
- `when`의 `==`는 지금처럼 느슨한 비교이고 `!!a`를 받는다. 알 수 없는 문자는 건너뛰지 않고 구문 오류다. 정규식 복구에서 이스케이프하거나 문자 클래스 안의 괄호는 그룹으로 세지 않는다 (wr-h23m.gek)
