# 에디터 이음매: 모델, 에디터, 해석기, 컨텍스트 키

v0.2.0의 흐름 에픽(문서 API, 파일 편집, Webview, Custom Editor, 언어, 테마)이 서로를 기다리지 않고 만나는 자리다. 이 페이지는 그 자리를 쓰는 사람, 곧 다음 에픽의 일꾼과 확장 기여를 읽는 사람을 위한 것이다. 화면에 보이는 UI 변화는 없다. wr-h23m이 작성했다.

## 서비스와 기본 구현

`editor.contribution.ts`에서 아래 서비스를 등록한다. 실제 구현을 포함한 에픽은 동일한 식별자로 `registerSingleton`을 다시 호출한다. 마지막 등록이 이기므로, 그 모듈은 `editor.contribution.ts`보다 뒤에 가져와야 한다(가져오기 목록은 `workbench.web.main.ts`). 값을 들고 있는 소비자는 한 번 읽고 끝내지 말고 서비스의 변경 이벤트를 듣는다.

| 서비스 | 파일 | 기본 구현 | 실제 구현 |
|---|---|---|---|
| `IModelService` | `src/editor/common/services/model.ts` | Monaco 모델(`ModelService`) | 그대로 |
| `ICodeEditorService` | `src/editor/browser/services/codeEditorService.ts` | 그대로 | 그대로 |
| `ITextModelService` | `src/editor/common/services/resolverService.ts` | 참조 세기(`TextModelResolverService`). Monaco 독립 실행형의 같은 자리도 이것에 맡긴다(아래 「Monaco 기능의 모델 참조」) | 그대로 |
| `ILanguageService` | `src/editor/common/languages/language.ts` | `plaintext`만 아는 `PlaintextLanguageService` | 언어 기여 에픽 |
| `IThemeService` | `src/platform/theme/common/themeService.ts` | v0.1.0의 어두운 팔레트(`DefaultThemeService`) | 테마 에픽 |
| `ITextFileService` | `src/workbench/services/textfile/common/textfiles.ts` | 제목 없는 문서만 아는 `UntitledTextFileService` | `BrowserTextFileService`(`services/textfile/browser/textFileService.ts`, 파일 편집 에픽): 제목 없는 문서와 파일 |
| `IEditorResolverService` | `src/workbench/services/editor/common/editorResolverService.ts` | 제목 없는 문서와 settings.json 등록 | 파일 편집 에픽이 파일 제공자가 있는 스킴의 기본 텍스트 에디터를 등록했다(`contrib/files/browser/editors/fileEditorHandler.ts`). Custom Editor 에픽이 등록을 더한다 |
| `IOpenerService` | `src/platform/opener/common/opener.ts` | 그대로 | 그대로 |

## 모델과 코드 에디터

- `IModelService`는 자기가 만든 모델만 센다. `onModelAdded`는 모델이 `getModels()`에 포함된 뒤에, `onModelRemoved`는 목록에서 제외된 뒤 모델이 폐기되기 전에 각각 한 번씩 발생한다. 두 그룹이 하나의 입력을 표시하더라도 모델은 하나만 유지된다.
- 리소스로 입력을 생성할 때는 먼저 열려 있는 동일 리소스의 입력을 찾아 재사용한다(제목 없는 문서의 해석기 등록도 이 방식을 따른다). 입력이 모델의 소유권을 가지므로 한 모델에 입력이 둘 이상 연결되면, 한쪽을 닫을 때 다른 탭의 텍스트가 사라진다 — [교훈](lessons/reuse-open-input-that-owns-its-model.md).
- `createModel(value, languageId, resource)`는 비동기로 동작한다. 언어 id를 생략하면 `ILanguageService`에 초기 경로와 첫 줄을 전달해 확인하며, 일치하는 항목이 없으면 `plaintext`로 지정된다. 이렇게 생성된 모델은 언어 등록이 바뀔 때마다 동일한 기준으로 언어를 다시 판별한다. `setModelLanguage`를 호출하면 해당 모델의 언어가 고정된다. 실제 언어가 변경되면 `onModelLanguageChanged`로 이전 id와 새 id를 전달한다.
- `ITextModel`(`src/editor/common/model.ts`)은 문서 동기화에 사용되는 버전, 줄, 범위, 위치 및 오프셋 변환, `applyEdits`, 변경 목록을 담은 `onDidChangeContent`, `onDidChangeLanguage`, `onWillDispose`를 제공한다. 50 MiB를 초과하는 모델은 `isTooLargeForSyncing(model)`이 참이 되며 확장 호스트로 전송하지 않는다.
- 텍스트 에디터 페인은 Monaco 에디터를 생성할 때 `ICodeEditorService`에 등록하고, 인스턴스를 해제하기 전에 등록을 해제한다. 페인은 재사용되므로 탭을 바꿔도 등록은 그대로이고 에디터의 `onDidChangeModel`이 "보는 모델"의 변화를 알린다. 그룹을 나누면 에디터가 하나 늘고, 그룹이 사라지면 하나 준다.

## 모델 참조

`ITextModelService.createModelReference(resource)`는 모델 참조 횟수를 관리한다.

1. `ITextFileService.canHandleResource`가 참이면(제목 없는 문서 또는 파일 제공자가 존재하는 스킴의 리소스) 해당 서비스의 모델을 반환한다. 마지막 참조가 해제되면 서비스에 이를 알린다(`resolve`가 반환한 객체의 `dispose`). 제목 없는 문서는 입력이 소유권을 가지므로 유지된다. 파일 모델은 변경 사항이 없으면 폐기되고, dirty 상태이거나 저장 중인 경우에는 저장이나 되돌리기가 끝난 뒤 폐기된다. 그 사이에 새로운 참조가 요청되면 모델은 유지된다. 이미 별도로 생성된 모델(예: settings.json)이 존재하는 리소스는 이 서비스가 처리하지 않는다.
2. 이미 존재하는 모델(예: settings.json)에 대한 참조도 제공한다.
3. 특정 스킴에 등록된 내용 제공자(`registerTextModelContentProvider`)가 생성한 모델은 이 서비스가 소유권을 갖는다. 마지막 참조가 해제되면 폐기하며, 그 사이에 새로운 참조가 추가되면 폐기하지 않는다.
4. 아무도 못 만들면 바로 거부한다.

### Monaco 기능의 모델 참조

Monaco 내장 기능(Ctrl+호버 정의 미리보기, 참조 미리보기 등)은 독립 실행형 Monaco 서비스의 `ITextModelService`를 통해 대상 모델을 가져온다. 기본 서비스인 `InMemoryTextModelService`는 이미 로드된 모델만 반환하며, 모델이 없으면 "Model not found" 예외를 발생시킨다. 이에 따라 `src/editor/browser/monaco.ts`의 로더는 Monaco가 서비스를 처음 초기화하기 전(테마 알림 이전)에 해당 서비스 구현을 덮어쓴다. Monaco는 최초 서비스 초기화 시점에만 재정의를 허용하며, 이후의 재정의 호출(`editor.create`의 세 번째 인자)은 경고 없이 무시한다.

- 재정의된 서비스는 호출될 때마다 `src/editor/browser/textModelServiceHook.ts`의 훅을 확인한다. 워크벤치는 시작할 때(`EditorTextModelResolverContribution`, `src/workbench/services/textmodelResolver/browser/editorTextModelResolver.ts`) 자기 리졸버를 훅에 넣는다. 그래서 Monaco가 언제 로드되든 순서가 상관없다.
- 워크벤치가 처리하는 리소스는 F12(정의로 이동에 쓰이는 Monaco 편집기 오프너, `mainThreadLanguageFeaturesNavigation.ts`의 `EditorOpenerContribution`)가 여는 대상과 동일하다(동일한 `canOpenInEditor` 사용): 파일 제공자가 있거나 모델이 존재하며 위의 `ITextModelService`가 다룰 수 있는 리소스다. 참조는 앞서 설명한 규칙에 따라 관리되므로, 아직 열지 않은 작업 폴더 파일이라도 미리보기 중에 로드되어 확장 호스트에 문서로 열렸다가 참조가 해제되면 닫힌다. 탭이나 초안에 연결된 모델은 그대로 유지된다. `vscode-userdata`(다른 확장의 저장 폴더 포함)는 텍스트 파일 스킴이 아니므로 열리지 않는다.
- 워크벤치가 맡지 않는 것(워크벤치가 없는 편집기 하니스, `inmemory` 합성 문서)은 Monaco의 기본 서비스 그대로다 (wr-v108.qc2).

## 리소스로 에디터 열기

- `IEditorService.openEditor({ resource, options })`가 에디터 해석기로 입력을 만든다. 옵션은 `preserveFocus`, `selection`(1부터 세는 줄과 열), `override`(에디터 id)다.
- 해석기 등록: `registerEditor(glob, { id, label, priority }, { canSupportResource }, factory)`. 우선순위는 `exclusive` > `default` > `builtin` > `option` 순이며, 동일한 우선순위에서는 더 긴 glob 패턴이 우선한다. 사용자의 `workbench.editorAssociations`(파일 이름 패턴 → 에디터 id)는 `exclusive`가 아닌 한 기본 우선순위보다 앞선다. `override`는 glob과 관계없이 지정한 id를 직접 적용한다. id가 `default`인 에디터는 텍스트 에디터이며 다른 후보가 없을 때 기본 대체재로 사용된다.
- glob에 `/`가 있으면 `scheme:path`에, 없으면 파일 이름에 대소문자 없이 맞춘다. 매처는 공용 `base/common/glob.ts`이고 `**`, `*`, `?`, 겹친 `{a,{b,c}}`, `[...]`/`[!...]`를 읽는다.
- 맞는 등록이 없으면 빈 페인이 아니라 이유를 적은 오류 에디터가 열린다(`role="alert"`).
- 화면에 표시 중인 에디터: `visibleEditors`, `visibleEditorPanes`, `onDidVisibleEditorsChange`(변경 시마다 한 번 발생). `findEditors(resource)`는 모든 그룹을 대상으로 검색한다. `onDidCloseEditor`는 에디터가 그룹을 떠날 때 난다.
- 뷰 열 번호는 `editorGroupColumn.ts`가 바꾼다: 0이 화면 순서의 첫 그룹이다(API의 `ViewColumn.One`). 그룹 수를 넘는 열(아홉째까지)은 마지막 그룹 오른쪽에 그룹 하나를 만든다. `ACTIVE_GROUP`, `SIDE_GROUP`은 그대로 간다.

## 저장과 닫기

- `EditorInput`은 `save`, `saveAs`, `revert`, `isReadonly`, `getDescription`, `closeHandler`를 제공한다. `save`는 저장 후 해당 에디터를 대체할 대상(동일 입력, 대체 입력, 또는 해석기로 열릴 `{ resource }`)을 반환하며, 저장 실패나 취소 시에는 `undefined`를 반환한다. 실패 안내 표시는 입력 구현체에서 담당한다. 제목 없는 입력은 저장 성공 시 `{ resource: 저장한 파일 }`을 반환한다.
- `IEditorService.save(editors, { saveAs?, reason? })`는 각 입력의 `save`(또는 `saveAs`)를 호출하며, 결과가 다른 에디터로 대체되어야 하면 해당 위치에 교체 배치한다. 구체적으로 `IEditorGroup.replaceEditors([{ editor, replacement, options? }])`를 통해 동일한 인덱스, 동일한 활성 상태, 기존 에디터의 뷰 상태(커서, 스크롤 위치)를 유지하며 교체하고 기존 에디터는 확인 없이 닫는다. 제목 없는 입력은 이를 표시하는 모든 그룹에서 일괄 교체된다. 저장이 처음 실패한 에디터 시점에서 처리를 중단하고 `false`를 반환한다.
- 파일 커맨드(`workbench.action.files.save`, `saveAs`, `saveAll`, `workbench.action.files.revert`, `workbench.action.files.newFile`)는 `src/workbench/contrib/files/browser/fileCommands.ts`에 있고 탭 컨텍스트면 그 탭, 아니면 활성 입력에 작용한다. 키와 메뉴는 [파일 편집과 Explorer](files-and-explorer.md#파일-커맨드와-키)에 있다.
- `closeEditor`, `closeEditors`, `closeAllEditors`는 `Promise<boolean>`을 반환한다. `closeHandler.showConfirm()`이 참인 입력에 한해, 그리고 다른 그룹에서 해당 입력을 표시하고 있지 않을 때만 저장 여부를 확인한다. `CANCEL`을 선택하면 아무것도 변경되지 않는다. 다중 닫기 작업 중 하나라도 취소하면 모든 에디터가 그대로 유지된다. `SAVE`는 저장이 성공해야 닫고, `DONT_SAVE`는 되돌린 뒤 닫는다.
- 확인 대화상자가 열려 있는 동안 동일한 에디터의 닫기 요청이 다시 들어오면 기존 확인의 응답을 기다린다(중복 확인을 띄우지 않는다). 사용자의 확인 응답이 전달되었을 때 이미 해당 그룹이 제거되었거나 에디터가 다른 곳으로 이동한 상태라면 닫지 않는다.
- 물을 것이 없으면 v0.1.0처럼 호출이 돌아오기 전에 닫힌다. 확인 대상은 수정된 파일(`FileEditorInput`)과 내용이 입력된 제목 없는 문서다. 두 경우 모두 `IFileDialogService.showSaveConfirm`(퀵 픽)을 통해 확인한다. 제목 없는 입력은 인스턴스화 서비스를 거쳐 생성된 경우에만 확인 및 저장을 진행한다(`new UntitledTextEditorInput(model)`은 테스트용이다).
- `Close All Editors`는 그룹 순서대로 에디터를 닫아가며, 취소나 저장 실패 등으로 닫히지 않은 에디터가 남은 그룹에서 처리를 중단한다.
- 작품 전환은 모든 그룹의 저장 확인을 모은 뒤 사용자가 고른 저장을 진행한다. 공유 텍스트나 공유 커스텀 문서는 한 번만 묻는다. **New Work...**는 확인과 저장이 끝나면 서버에 작품을 만들고, 목적지가 준비되면 버리기로 한 변경을 처리하고 에디터를 닫는다. 취소나 저장 실패는 전환을 멈춘다.
- `ITextFileService`의 `onWillSave`(`waitUntil`), `onDidSave`, `onDidChangeDirty`가 문서 API가 확장으로 넘기는 저장 이벤트다. 기본 구현체는 실제 저장을 수행하지 않는다. 실제 구현은 파일을 저장하고(`save`, `revert`), `saveAs(source, target?)`로 제목 없는 문서나 파일의 텍스트를 다른 파일에 쓴다(대상이 없으면 저장 대화상자로 묻는다). 제목 없는 문서의 `save`는 내부적으로 `saveAs`로 처리된다.
- 경로를 묻는 것은 `IFileDialogService`(`src/workbench/services/dialogs/common/dialogs.ts`)다: `showOpenDialog`, `showSaveDialog`, `pickFileToSave`, `showSaveConfirm`, `defaultFilePath`. 구현은 퀵 인풋으로 만든 `SimpleFileDialog`이고 워크스페이스 폴더 안만 고른다.
- 파일 모델은 `ITextFileService.files`(VS Code의 모델 관리자 형태)에서 관리한다: `get`, `resolve`, `models`, 이벤트 `onDidCreate`, `onDidResolve`, `onDidChangeDirty`, `onDidChangeOrphaned`, `onDidChangeReadonly`, `onDidSave`, `onDidRevert`, `onDidRemove`, 그리고 충돌과 실패를 묻는 `saveErrorHandler`를 제공한다. 개별 모델(`ITextFileEditorModel`)은 `isDirty`, `isOrphaned`, `isReadonly`, `isSaving`, `save`(성공 시 `true`), `revert({ soft })` 메서드를 갖춘다. 사용자 인터랙션 동작은 [파일 편집과 Explorer](files-and-explorer.md#텍스트-파일-편집)를 참조한다.
- 파일 탭의 입력은 `FileEditorInput`(`workbench.editors.files.fileEditorInput`)이고 `save`, `revert`, `isDirty`, `isReadonly`를 텍스트 파일 서비스로 넘긴다. 입력은 `getTitle()`(툴팁)을 가진다.

## 링크 열기

`IOpenerService.open(target, options)`는 링크를 여는 단일 진입점이다.

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

- 페인의 컨텍스트 범위는 해당 그룹 범위의 하위 스코프다. 따라서 비활성 그룹의 제목 메뉴도 활성 그룹이 아닌 해당 그룹 자체의 에디터 컨텍스트에 따라 평가된다. 그룹 제목 메뉴(`editor/title`)는 활성 페인의 범위로 평가하므로 `editorLangId == markdown`인 버튼은 markdown 에디터 위에만 나온다.
- 탭 컨텍스트 메뉴(`editor/title/context`)는 누른 탭의 리소스 키로 평가한다.
- `setContext(key, value)` 커맨드는 문자열, 수, 불리언, `null`과 그것들의 배열과 평범한 객체만 받아 복사해 건다. 확장이 건 키는 확장을 제거해도 남는다(VS Code와 같다).
- `workbenchState`는 파일·워크스페이스 에픽이, `config.*`는 설정 에픽이, 뷰와 Webview의 키는 각 에픽이 자기 파일에서 만든다. `platform/contextkey/**`와 `workbench/common/contextkeys.ts`는 이 에픽 뒤로 아무도 고치지 않는다.

## Deviations from VS Code

- 테마 색은 `Color` 객체가 아니라 CSS 색 문자열이다(`getColor`). 파일 아이콘 테마와 제품 아이콘 테마는 없다 (wr-h23m.6ti)
- `IModelService.createModel`은 비동기이고 `setModelLanguage`를 서비스에 둔다. Monaco 독립 실행형의 모델에는 `setLanguage`가 공개되어 있지 않다 (wr-h23m.6ti)
- `explicit` 우선순위, 차이·병합 에디터 연관은 없다 (wr-h23m.4hq). 에디터 해석기의 glob은 공용 `base/common/glob.ts`로 맞추고(VS Code처럼 패턴과 대상을 소문자로 바꾼다), 그 매처가 거부하는 패턴(4 KiB 초과, 대안 100개 초과)은 아무것도 받지 않는다 (wr-jrhv)
- 뷰 열 번호가 그룹 수를 넘으면 그룹을 하나만 만든다. VS Code는 그 열까지 채운다 (wr-h23m.4hq)
- 닫을 때 묻는 것은 `closeHandler`가 있는 입력뿐이다(고친 파일과 텍스트가 있는 제목 없는 입력이 가진다). VS Code는 `closeHandler`가 없어도 dirty한 입력이면 저장 확인을 연다 (wr-h23m.4hq, wr-jrhv.r4v)
- 외부 주소의 확인은 모달 대화상자가 아니라 퀵 픽이다(마스터 본문의 확인 대화상자 규칙) (wr-h23m.4hq)
- 제목 없는 탭의 언어는 plaintext가 아닐 때만 저장한다. 직렬화 문자열은 `이름\n텍스트\n언어`이고, 언어가 없는 v0.1.0 형식도 그대로 읽는다. 저장된 언어가 공백이나 제어 문자를 담거나 256자를 넘으면 버리고 텍스트로 짐작한다 (wr-2bi0)
- Monaco 기능의 모델 참조는 Monaco 독립 실행형 서비스 위치를 재정의해 워크벤치에 위임한다. VS Code의 편집기는 처음부터 워크벤치 서비스 기반으로 구성된다 (wr-v108.qc2)
- `when`의 `==`는 지금처럼 느슨한 비교이고 `!!a`를 받는다. 알 수 없는 문자는 건너뛰지 않고 구문 오류다. 정규식 복구에서 이스케이프하거나 문자 클래스 안의 괄호는 그룹으로 세지 않는다 (wr-h23m.gek)

Decided in: wr-qd31, wr-88fi
