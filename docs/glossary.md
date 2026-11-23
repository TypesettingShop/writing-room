# 용어집: VS Code와 writing-room의 이름

화면과 코드를 가리킬 때 쓰는 이름을 모은 페이지다. VS Code에서 이어받은 이름은 화면 위치, 이 저장소의 코드, VS Code 원본을 함께 적는다. writing-room에서 붙인 이름에는 화면과 이 저장소의 코드 위치를 적는다. 화면 라벨은 실제 UI 문자열의 영어 그대로 적고 한국어 이름은 괄호에 둔다. 제품의 메뉴 라벨은 영어로만 둔다.

- 설명은 옮겨 적지 않고 마지막 열의 페이지로 링크한다. 이 페이지는 이름과 위치만 정한다.
- 우리 코드 경로는 `src/` 기준이며, `server/`로 시작하는 경로는 저장소 루트 기준이다. VS Code 경로는 `src/vs/` 기준이다. 두 소스 경로는 대개 [대응 규칙](architecture.md#대응-규칙)에 따라 `vs/`만 다르다. 구현 위치나 심볼이 다른 행은 두 열에 각자의 실제 위치를 적는다. VS Code 경로와 심볼은 [기준 커밋](README.md#기준-vs-code-커밋)에서 확인했다. 줄 번호는 적지 않는다.
- 같은 개념에 이름이 둘이면 하나를 고르고 나머지는 "다른 이름"으로 적는다.
- 용어를 더하거나 고치면 이 표의 한 줄만 바꾼다.

## 창과 파트

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| Workbench (워크벤치) | 창 전체. 파트 여섯 개를 한 그리드에 조립한다. | `workbench/browser/workbench.ts`, `Workbench` | `workbench/browser/workbench.ts`, `Workbench` | [레이아웃](vscode-workbench-layout.md) |
| Title Bar (제목 표시줄) | 창 맨 위. Menu Bar를 품는다. | `workbench/browser/parts/titlebar/titlebarPart.ts` | `workbench/browser/parts/titlebar/titlebarPart.ts`, `BrowserTitlebarPart` | [레이아웃](vscode-workbench-layout.md) |
| Menu Bar (메뉴 바) | Title Bar 왼쪽의 File, Edit, View 같은 최상위 메뉴. | `workbench/browser/parts/titlebar/menubarControl.ts` | `workbench/browser/parts/titlebar/menubarControl.ts` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Activity Bar (액티비티 바) | 맨 왼쪽의 아이콘 줄. 아이콘이 View Container를 고른다. | `workbench/browser/parts/activitybar/activitybarPart.ts` | `workbench/browser/parts/activitybar/activitybarPart.ts`, `ActivitybarPart` | [레이아웃](vscode-workbench-layout.md) |
| Primary Side Bar (사이드바) | Activity Bar 오른쪽의 넓은 영역. Explorer 같은 View Container를 보인다. 다른 이름은 Side Bar다. | `workbench/browser/parts/sidebar/sidebarPart.ts` | `workbench/browser/parts/sidebar/sidebarPart.ts`, `SidebarPart` | [레이아웃](vscode-workbench-layout.md) |
| Panel (패널) | 에디터 영역 아래. Output과 Problems 같은 View Container를 보인다. | `workbench/browser/parts/panel/panelPart.ts` | `workbench/browser/parts/panel/panelPart.ts`, `PanelPart` | [레이아웃](vscode-workbench-layout.md) |
| Status Bar (상태 표시줄) | 창 맨 아래 줄. | `workbench/browser/parts/statusbar/statusbarPart.ts` | `workbench/browser/parts/statusbar/statusbarPart.ts`, `StatusbarPart` | [레이아웃](vscode-workbench-layout.md) |
| Sash (새시) | 파트와 파트 사이의 경계선. 끌어서 크기를 바꾼다. | `base/browser/ui/sash/sash.ts`, `Sash` | `base/browser/ui/sash/sash.ts`, `Sash` | [레이아웃](vscode-workbench-layout.md) |
| Grid (그리드) | 파트를 배치하는 화면 분할 엔진. 에디터 그룹의 배치에도 쓴다. | `base/browser/ui/grid/grid.ts`, `SerializableGrid` | `base/browser/ui/grid/grid.ts`, `SerializableGrid` | [레이아웃](vscode-workbench-layout.md) |

## 뷰

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| View Container (뷰 컨테이너) | Activity Bar 아이콘 하나가 여는 묶음. Primary Side Bar나 Panel에 놓인다. | `workbench/common/views.ts`, `IViewContainersRegistry` | `workbench/common/views.ts`, `IViewContainersRegistry` | [레이아웃](vscode-workbench-layout.md) |
| View (뷰) | View Container 안의 접히는 구역 하나. Explorer 안의 파일 트리가 그렇다. | `workbench/common/views.ts` | `workbench/common/views.ts` | [레이아웃](vscode-workbench-layout.md) |
| View Pane (뷰 페인) | View를 그리는 위젯. 제목 줄과 본문을 갖는다. | `workbench/browser/parts/views/viewPane.ts`, `ViewPane` | `workbench/browser/parts/views/viewPane.ts`, `ViewPane` | [레이아웃](vscode-workbench-layout.md) |
| View Pane Container | View Pane 여러 개를 세로로 쌓는 그릇. | `workbench/browser/parts/views/viewPaneContainer.ts`, `ViewPaneContainer` | `workbench/browser/parts/views/viewPaneContainer.ts`, `ViewPaneContainer` | [레이아웃](vscode-workbench-layout.md) |
| Tree View (트리 뷰) | 항목을 트리로 보이는 View. 확장이 `window.createTreeView`로 만든다. | `workbench/browser/parts/views/treeView.ts`, `TreeViewPane` | `workbench/browser/parts/views/treeView.ts`, `TreeViewPane`, `TreeView` | [테마와 뷰](extension-api-theming-and-views.md) |
| Webview View (웹뷰 뷰) | 확장의 Webview를 담는 View. | `workbench/api/browser/mainThreadWebviewViews.ts`, `MainThreadWebviewViews` | `workbench/api/browser/mainThreadWebviewViews.ts`, `MainThreadWebviewsViews` | [Webview](extension-api-webview.md) |
| Welcome View (환영 뷰) | 트리가 비었을 때 보이는 안내 문구. 확장은 `contributes.viewsWelcome`으로 기여한다. | `workbench/browser/parts/views/treeViewWelcome.ts`, `workbench/api/browser/viewsExtensionPoint.ts` | `workbench/contrib/welcomeViews/common/viewsWelcomeContribution.ts` | [테마와 뷰](extension-api-theming-and-views.md) |

## 에디터

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| Editor Area (에디터 영역) | 가운데의 에디터 그룹이 모인 곳. 코드에서는 Editor Part라 부른다. | `workbench/browser/parts/editor/editorPart.ts`, `EditorPart` | `workbench/browser/parts/editor/editorPart.ts`, `MainEditorPart` | [에디터 그룹](vscode-editor-groups.md) |
| Editor Group (에디터 그룹) | 탭 줄과 에디터 하나를 가진 칸. 나누면 칸이 늘어난다. | `workbench/browser/parts/editor/editorGroupView.ts`, `EditorGroupView` | `workbench/browser/parts/editor/editorGroupView.ts`, `EditorGroupView` | [에디터 그룹](vscode-editor-groups.md) |
| Tab (탭) | 에디터 그룹의 탭 줄에 한 칸씩 놓이는, 열린 에디터 하나. | `workbench/browser/parts/editor/multiEditorTabsControl.ts`, `MultiEditorTabsControl` | `workbench/browser/parts/editor/multiEditorTabsControl.ts`, `MultiEditorTabsControl` | [에디터 그룹](vscode-editor-groups.md) |
| Editor Input (에디터 입력) | 탭이 가리키는 "무엇을 연 것인가". 저장·복원의 단위이며 `typeId`가 종류를 가른다. | `workbench/common/editor/editorInput.ts`, `EditorInput` | `workbench/common/editor/editorInput.ts`, `EditorInput` | [에디터 그룹](vscode-editor-groups.md) |
| Editor Pane (에디터 페인) | 입력을 그려 주는 화면. 한 입력은 해석기가 고른 페인 하나로 열린다. | `workbench/browser/parts/editor/editorPane.ts`, `EditorPane` | `workbench/browser/parts/editor/editorPane.ts`, `EditorPane` | [에디터 그룹](vscode-editor-groups.md) |
| Editor Resolver (에디터 해석기) | 파일을 어느 에디터로 열지 정한다. `workbench.editorAssociations` 설정이 우선한다. | `workbench/services/editor/browser/editorResolverService.ts`, `EditorResolverService` | `workbench/services/editor/browser/editorResolverService.ts`, `EditorResolverService` | [에디터 이음매](editor-services.md) |
| Reopen Editor With... (다시 열기) | 커맨드 팔레트의 **View: Reopen Editor With...**. 같은 파일을 열 수 있는 에디터를 목록으로 보이고 지금 것을 `Active`로 표시한다. | `workbench/contrib/customEditor/browser/customEditor.contribution.ts`, `REOPEN_WITH_COMMAND_ID` | `workbench/browser/parts/editor/editorCommands.ts`, `REOPEN_WITH_COMMAND_ID` | [Custom Editor](extension-api-custom-editors.md) |
| Custom Editor (커스텀 에디터) | 확장이 Webview로 파일을 여는 에디터. | `workbench/contrib/customEditor/browser/customEditorInput.ts`, `CustomEditorInput` | `workbench/contrib/customEditor/browser/customEditorInput.ts`, `CustomEditorInput` | [Custom Editor](extension-api-custom-editors.md) |
| Text File Model (텍스트 파일 모델) | 파일 내용, 저장, dirty를 가진 모델. 원문 모드와 WYSIWYG가 같은 것을 쓴다. | `workbench/services/textfile/common/textFileEditorModel.ts`, `TextFileEditorModel` | `workbench/services/textfile/common/textFileEditorModel.ts`, `TextFileEditorModel` | [에디터 이음매](editor-services.md), [파일 편집](files-and-explorer.md) |
| Dirty (고침 표시) | 저장하지 않은 변경. 탭에 점으로 보인다. | `workbench/common/editor/editorInput.ts`, `isDirty` | `workbench/common/editor/editorInput.ts`, `isDirty` | [파일 편집](files-and-explorer.md) |
| 초안 (Backup, hot exit) | 저장하지 않은 내용을 브라우저에 보관했다가 새로고침 뒤 되살리는 것. | `workbench/services/textfile/common/textFileBackup.ts`, `TextFileBackups` | `workbench/services/workingCopy/common/workingCopyBackup.ts`, `IWorkingCopyBackupService` | [초안 백업과 새로고침](files-and-explorer.md#초안-백업과-새로고침) |

## 명령

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| Command (커맨드) | id로 부르는 동작 하나. 메뉴, 키, 팔레트가 모두 이 id를 부른다. | `platform/commands/common/commands.ts`, `CommandsRegistry` | `platform/commands/common/commands.ts`, `CommandsRegistry` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Command Palette (커맨드 팔레트) | **Ctrl+Shift+P**로 여는 입력창. 커맨드를 이름으로 고른다. Quick Input의 한 모드다. | `workbench/contrib/quickaccess/browser/commandsQuickAccess.ts`, `CommandsQuickAccessProvider` | `workbench/contrib/quickaccess/browser/commandsQuickAccess.ts`, `CommandsQuickAccessProvider` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Quick Input (퀵 입력) | 화면 위쪽에 뜨는 입력창의 총칭. Quick Pick(고르기)과 Input Box(글자 받기)가 있다. | `platform/quickinput/common/quickInput.ts`, `IQuickInputService` | `platform/quickinput/common/quickInput.ts`, `IQuickInputService` | [메뉴와 커맨드](vscode-menus-commands.md), [창 UI](extension-api-window-ui.md) |
| Keybinding (키바인딩) | 키 조합과 커맨드의 짝. | `platform/keybinding/common/keybindingsRegistry.ts`, `KeybindingsRegistry` | `platform/keybinding/common/keybindingsRegistry.ts`, `KeybindingsRegistry` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Context Key (컨텍스트 키) | 지금 상태(에디터 포커스, 모드 등)를 나타내는 이름 붙은 값. | `platform/contextkey/common/contextkey.ts`, `RawContextKey` | `platform/contextkey/common/contextkey.ts`, `RawContextKey` | [메뉴와 커맨드](vscode-menus-commands.md), [에디터 이음매](editor-services.md) |
| when 절 | 메뉴 항목과 키바인딩이 켜질 조건. Context Key를 식으로 쓴다. | `platform/contextkey/common/contextkey.ts`, `ContextKeyExpr` | `platform/contextkey/common/contextkey.ts`, `ContextKeyExpr` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Menu (메뉴) | 메뉴 자리 하나(`MenuId`)와 거기 놓인 항목들. 메뉴 바, 툴바, 문맥 메뉴가 모두 그렇다. | `platform/actions/common/actions.ts`, `MenuId` | `platform/actions/common/actions.ts`, `MenuId` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Toolbar (툴바) | 메뉴 항목을 아이콘 버튼 줄로 보이는 것. 에디터 제목 줄에 있다. | `platform/actions/browser/toolbar.ts`, `MenuWorkbenchToolBar` | `platform/actions/browser/toolbar.ts`, `MenuWorkbenchToolBar` | [메뉴와 커맨드](vscode-menus-commands.md) |
| Context Menu (문맥 메뉴) | 오른쪽 클릭으로 뜨는 메뉴. | `platform/contextview/browser/contextMenuService.ts`, `ContextMenuService` | `platform/contextview/browser/contextMenuService.ts`, `ContextMenuService` | [메뉴와 커맨드](vscode-menus-commands.md), [WYSIWYG 문맥 메뉴](getting-started.md#wysiwyg-문맥-메뉴) |

## 확장

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| Extension (확장) | 매니페스트와 코드를 묶은 꾸러미. Extensions 뷰에서 설치한다. | `workbench/contrib/extensions/browser/extensionsViews.ts` | `workbench/contrib/extensions/browser/extensionsViews.ts` | [확장](vscode-extensions.md), [설치](extension-installation.md) |
| Built-in Extension (내장 확장) | 설치 없이 함께 오는 확장. 저장소의 `extensions/` 디렉터리에 있다. | `workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts` | `workbench/services/extensionManagement/browser/builtinExtensionsScannerService.ts`, `BuiltinExtensionsScannerService` | [웹 빌드](vscode-web-build.md) |
| Manifest (매니페스트) | 확장의 `package.json`. `contributes`에 기여를 적는다. | `platform/extensions/common/extensions.ts` | `platform/extensions/common/extensions.ts` | [확장](vscode-extensions.md) |
| Contribution Point (기여 지점) | `contributes` 아래 키 하나(`commands`, `menus`, `viewsWelcome` 등). | `workbench/services/extensions/common/extensionsRegistry.ts`, `ExtensionsRegistry` | `workbench/services/extensions/common/extensionsRegistry.ts`, `ExtensionsRegistry` | [확장](vscode-extensions.md), [확장 API](extension-api.md) |
| Activation Event (활성화 이벤트) | 확장 코드를 실제로 켜는 계기(`onCommand:...` 등). | `workbench/services/extensions/common/extensions.ts` | `workbench/services/extensions/common/extensions.ts` | [확장](vscode-extensions.md) |
| Extension Host (확장 호스트) | 확장 코드가 도는 웹 워커. 메인과 RPC로 말한다. | `workbench/services/extensions/browser/webWorkerExtensionHost.ts` | `workbench/services/extensions/browser/webWorkerExtensionHost.ts` | [확장](vscode-extensions.md) |
| Workbench Contribution (워크벤치 기여) | 워크벤치가 시작할 때 만들어지는 코어 쪽 부품. 확장의 기여와 다르다. | `workbench/common/contributions.ts`, `registerWorkbenchContribution2` | `workbench/common/contributions.ts`, `registerWorkbenchContribution2` | [유지보수](maintainability.md) |
| Service (서비스) | 인터페이스 id(`createDecorator`)로 주입받는 부품. | `platform/instantiation/common/instantiation.ts`, `createDecorator` | `platform/instantiation/common/instantiation.ts`, `createDecorator` | [유지보수](maintainability.md) |

## 저장

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | VS Code | 자세히 |
| --- | --- | --- | --- | --- |
| Workspace (워크스페이스) | 지금 열린 작업 공간. 이 제품에서는 브라우저 저장소의 파일 트리다. | `platform/workspace/common/workspace.ts`, `IWorkspaceContextService` | `platform/workspace/common/workspace.ts`, `IWorkspaceContextService` | [파일 편집](files-and-explorer.md) |
| Workspace Folder (워크스페이스 폴더) | Explorer 맨 위에 놓이는 최상위 폴더. | `platform/workspace/common/workspace.ts`, `IWorkspaceFolder` | `platform/workspace/common/workspace.ts`, `IWorkspaceFolder` | [파일 편집](files-and-explorer.md) |
| File System Provider (파일 시스템 제공자) | 한 scheme의 파일을 읽고 쓰는 구현. | `platform/files/common/files.ts`, `IFileSystemProvider` | `platform/files/common/files.ts`, `IFileSystemProvider` | [파일 시스템 API](extension-api-file-system.md) |
| Scheme (스킴) | URI 맨 앞(`file:`, `untitled:` 등). 어느 제공자가 맡을지 가른다. | `base/common/network.ts`, `Schemas` | `base/common/network.ts`, `Schemas` | [파일 시스템 API](extension-api-file-system.md) |
| Storage Scope (저장 범위) | 값이 어디에 속하는가. `APPLICATION`, `PROFILE`, `WORKSPACE`. | `platform/storage/common/storage.ts`, `StorageScope` | `platform/storage/common/storage.ts`, `StorageScope` | [상태와 설정](vscode-state-settings.md) |
| User Settings (사용자 설정) | `settings.json`. **Preferences: Open User Settings (JSON)** 커맨드로 연다. | `platform/configuration/common/configuration.ts` | `platform/configuration/common/configuration.ts` | [상태와 설정](vscode-state-settings.md), [사용자 설정 편집하기](getting-started.md#사용자-설정-편집하기) |
| Memento (메멘토) | 컴포넌트가 자기 상태를 스토리지에 맡기는 도구. 탭 복원이 이것을 쓴다. | `workbench/common/memento.ts`, `Memento` | `workbench/common/memento.ts`, `Memento` | [상태와 설정](vscode-state-settings.md) |

## 작품

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | 자세히 |
| --- | --- | --- | --- |
| Work (작품) | 원고 트리를 담는 단위. Welcome의 Works에서 작품 제목을 고른다. | `platform/manuscript/common/manuscript.ts`, `ManuscriptWork` | [작품 열기와 닫기](getting-started.md#작품-열기와-닫기) |
| Work 메뉴 | Menu Bar 맨 앞의 최상위 메뉴. **New Work...**, **Open Work...**, **Close Work**가 있다. | `workbench/browser/parts/titlebar/menubar.contribution.ts`, `MenubarWorkMenu` 및 `workbench/contrib/work/browser/work.contribution.ts` | [작품 열기와 닫기](getting-started.md#작품-열기와-닫기) |
| Works (작품 목록) | Welcome 에디터에서 최근 작품을 보여 주는 절. | `workbench/browser/parts/editor/welcomeEditor.ts`, `WelcomeEditorPane` | [작품 열기와 닫기](getting-started.md#작품-열기와-닫기) |
| 작품 창 | 주소에 `?work=<uuid>`로 열린 작품을 지정한 창. | `workbench/services/work/common/work.ts`, `WindowWork`, `readWindowWork` | [작품 열기와 닫기](getting-started.md#작품-열기와-닫기) |
| `workOpen` (작품 열림) | 작품 창에서 Manuscript 컨테이너와 **Close Work** 등을 표시하거나 활성화할 때 쓰는 컨텍스트 키. | `workbench/services/work/common/work.ts`, `WorkOpenContext` | [작품 열기와 닫기](getting-started.md#작품-열기와-닫기) |

## 원고 구조와 뷰

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | 자세히 |
| --- | --- | --- | --- |
| Manuscript (원고) | 작품 창의 Activity Bar에서 책 아이콘으로 여는 View Container. Navigator와 Properties가 들어 있다. | `workbench/contrib/manuscript/browser/manuscript.contribution.ts`, `MANUSCRIPT_CONTAINER_ID` | [원고 탐색창](manuscript.md) |
| Navigator (탐색창) | Manuscript에서 부·장·문서를 보고 선택하는 뷰. | `workbench/contrib/manuscript/browser/navigatorView.ts`, `NavigatorView` | [원고 탐색창](manuscript.md) |
| Properties (메타데이터창) | Navigator에서 고른 항목의 제목과 메타데이터를 보여 주는 뷰. | `workbench/contrib/manuscript/browser/propertiesView.ts`, `PropertiesView` | [Properties에서 제목 고치기](manuscript.md#properties에서-제목-고치기) |
| Part (부) | 원고 최상위에서 장과 문서를 담는 폴더. | `platform/manuscript/common/manuscript.ts`, `manuscriptNodeTypes.part` | [원고 구조 만들기](manuscript.md#원고-구조-만들기) |
| Chapter (장) | 원고 최상위나 부 안에서 문서를 담는 폴더. | `platform/manuscript/common/manuscript.ts`, `manuscriptNodeTypes.chapter` | [원고 구조 만들기](manuscript.md#원고-구조-만들기) |
| Document (문서) | Navigator에서 에디터 탭으로 여는 마크다운 원고 항목. | `platform/manuscript/common/manuscript.ts`, `manuscriptNodeTypes.document` | [문서 열기](manuscript.md#문서-열기) |
| 현재 폴더와 `..` | Navigator가 목록의 기준으로 삼는 폴더와 상위 폴더로 돌아가는 맨 위 행. | `workbench/contrib/manuscript/common/manuscriptTree.ts`, `UP_KEY` 및 `workbench/contrib/manuscript/browser/manuscriptViewState.ts`, `ManuscriptViewState` | [원고 구조 만들기](manuscript.md#원고-구조-만들기) |
| 번호 라벨 | Navigator와 Properties에서 부·장의 순서를 나타내는 `1부`, `1장` 같은 표시. 같은 부모 아래에서 종류별로 1부터 세며 문서에는 번호를 붙이지 않는다. | `workbench/contrib/manuscript/common/manuscriptTree.ts`, `buildIndex` | [원고 구조 만들기](manuscript.md#원고-구조-만들기) |
| Open All Documents | Navigator 폴더의 문맥 메뉴에서 하위 문서를 여는 명령. | `workbench/contrib/manuscript/browser/manuscript.contribution.ts` 및 `workbench/contrib/manuscript/browser/manuscriptOpener.ts`, `ManuscriptOpener` | [문서 열기](manuscript.md#문서-열기) |

## 편집기

이 절에는 Manuscript Editor의 화면과 동작을 설명할 때 쓰는 용어를 모았다.

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | 자세히 |
| --- | --- | --- | --- |
| Manuscript Editor (원고 편집기) | `.md` 파일을 서식 그대로 보며 쓰는 기본 에디터. **Reopen Editor With...** 목록에 이 이름으로 보인다. | `workbench/contrib/markdownEditor/browser/markdownEditorPane.ts`, `MarkdownEditorPane` | [마크다운 편집하기](getting-started.md#마크다운-편집하기), [저장 형식](markdown-editor.md) |
| WYSIWYG 모드 / Source 모드 | 같은 탭의 두 모드. WYSIWYG는 Manuscript Editor이고 Source는 Monaco 원문 편집기(`TextFileEditor`)다. 탭 제목 툴바와 **Markdown: Toggle Source Mode**로 오간다. | `workbench/contrib/markdownEditor/browser/markdownEditor.contribution.ts` | [편집 모드와 실행 취소](markdown-editor.md#편집-모드와-실행-취소) |
| Focus Mode (집중 모드) | 본문만 가운데 남기고 다른 파트를 숨긴다. **View → Appearance → Markdown Focus Mode** 또는 **Markdown: Toggle Focus Mode**. | `workbench/contrib/markdownEditor/browser/markdownFocusMode.contribution.ts` | [분량과 집중 모드](getting-started.md#분량과-집중-모드) |
| Typewriter Scroll (타자기 스크롤) | 쓰는 줄을 화면 가운데에 붙들어 두는 설정 `markdownEditor.typewriterScroll`. | `workbench/contrib/markdownEditor/common/markdownEditor.ts`, `MARKDOWN_EDITOR_TYPEWRITER` | [분량과 집중 모드](getting-started.md#분량과-집중-모드) |
| Formatting Toolbar (서식 툴바) | Manuscript Editor 본문 위의 툴바. Style, Size, Font, 정렬, 굵게 같은 버튼이 있다. | `workbench/contrib/markdownEditor/browser/markdownEditorToolbar.contribution.ts`, `MenuId.MarkdownEditorToolbar` | [서식 툴바](getting-started.md#서식-툴바) |
| Gutter (본문 옆 여백) | 본문 좌우의 빈 영역. 눌러서 줄의 시작과 끝, 블록 앞뒤로 커서를 옮긴다. | `workbench/contrib/markdownEditor/browser/markdownEditorGutter.ts` | [마크다운 편집하기](getting-started.md#마크다운-편집하기) |
| Section (절) | 문서 본문에서 절 구분선으로 나뉘는 구간. | `workbench/contrib/markdownEditor/browser/markdownEditorSections.ts` | [절 구분선과 절 번호](markdown-editor.md#절-구분선과-절-번호) |
| Section Break (절 구분선) | Manuscript Editor에서 절 경계를 표시하는 최상위 가로 구분선. 삽입 명령의 표시 이름은 **Horizontal Rule**이다. | `workbench/contrib/markdownEditor/browser/markdownEditorSections.ts` 및 `workbench/contrib/markdownEditor/browser/markdownEditorToolbar.contribution.ts` | [절 구분선과 절 번호](markdown-editor.md#절-구분선과-절-번호) |
| Section Numbers (절 번호) | **View → Appearance → Section Numbers**로 켜는 절의 윗첨자 번호. 설정은 `markdownEditor.sectionNumbers`다. | `workbench/contrib/markdownEditor/common/markdownEditor.ts`, `MARKDOWN_EDITOR_SECTION_NUMBERS` 및 `workbench/contrib/markdownEditor/browser/markdownEditorPresentation.contribution.ts` | [절 구분선과 절 번호](markdown-editor.md#절-구분선과-절-번호) |
| Footnotes Panel (각주 패널) | Manuscript Editor 하단의 **Footnotes** 영역. 팔레트의 명령 이름은 **Markdown: Toggle Footnotes Panel**이다. | `workbench/contrib/markdownEditor/browser/markdownEditorFootnotes.ts` 및 `workbench/contrib/markdownEditor/browser/markdownEditorPresentation.contribution.ts` | [각주 패널](markdown-editor.md#각주-패널) |
| IME (입력기), IME 리셋 | 한글 입력기의 조합과 조합 중 발생하는 입력기 리셋을 가리킨다. | `workbench/contrib/markdownEditor/browser/markdownCompositionRecovery.ts`, `MarkdownCompositionRecovery` | [마크다운 편집하기](getting-started.md#마크다운-편집하기) |

### 이름의 내력

2026-11-22에 사람이 "이렇게 계속 부를 수는 없다"고 하여 Manuscript Editor(원고 편집기)로 정했다. VS Code의 내장 확장도 Markdown Editor(`vscode.markdown.editor`)를 등록하므로 같은 이름이 둘이어서 헷갈렸다. `markdownEditor.typewriterScroll`, `markdownEditor.fontSize`, `markdownEditor.fontFamily`의 설정 설명에 **Manuscript Editor**라는 이름을 쓴다. 본문 컨텍스트 메뉴의 접근 이름은 `Manuscript Editor`이고, 본문 textbox의 접근 이름은 `Markdown editor`다. 에디터 입력의 `typeId`, `markdownEditor.*` 설정 키, 커맨드 category `Markdown`은 기존 이름을 쓴다. 두 모드는 같은 `TextFileEditorModel`을 쓴다. [아키텍처](architecture.md#markdown-editor)

## 원고 저장과 로그인

| 용어 | 화면에서의 위치와 뜻 | 우리 코드 | 자세히 |
| --- | --- | --- | --- |
| Manuscript Store (원고 저장 계약) | 작품, 원고 트리, 문서 본문의 읽기와 쓰기를 정의하는 `ManuscriptStore` 인터페이스. | `platform/manuscript/common/manuscriptStore.ts`, `ManuscriptStore` | [원고 저장소](architecture.md#원고-저장소) |
| `manuscript:` 스킴 | 원고 문서를 편집기에서 여는 URI의 스킴. 형식은 `manuscript://<workId>/<nodeId>.md`다. | `workbench/services/manuscript/browser/manuscriptFileSystemProvider.ts`, `manuscriptScheme`, `manuscriptDocumentUri` | [원고 저장소](architecture.md#원고-저장소) |
| revision 충돌 | 같은 작품의 원고 트리를 바꿀 때 보낸 revision이 저장소의 현재 값과 다르면 생기는 충돌. 다른 이름은 저장 충돌이다. | `platform/manuscript/common/manuscript.ts`, `checkRevision` 및 `workbench/contrib/manuscript/browser/manuscriptViewState.ts`, `ManuscriptViewState` | [다른 창의 변경 가져오기](manuscript.md#다른-창의-변경-가져오기) |
| API 서버 | 브라우저에서 보낸 원고 저장과 로그인 `/api` 요청을 처리하는 Node 서버. | `server/apiServer.ts`, `createApiServer` | [API 서버 실행](getting-started.md#api-서버-실행) |
| 로그인 API | `/api/auth/signup`, `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`에서 가입, 로그인, 로그아웃, 현재 세션 확인을 처리한다. | `server/auth/authRoutes.ts` | [이메일과 비밀번호로 로그인하기](getting-started.md#이메일과-비밀번호로-로그인하기) |
| Google 로그인 API | `/api/auth/oauth/google/start`와 `/api/auth/oauth/google/callback`에서 Google 로그인을 시작하고 완료한다. | `server/auth/googleRoutes.ts`, `createGoogleRoutes` 및 `server/auth/googleConfig.ts` | [Google 로그인 설정](getting-started.md#개발-환경에서-google-로그인-설정하기) |
| 세션 | 로그인 뒤 계정을 확인하는 단위. 브라우저는 `wr_session` 쿠키로 세션을 전달한다. | `server/auth/session.ts` | [이메일과 비밀번호로 로그인하기](getting-started.md#이메일과-비밀번호로-로그인하기) |
| Sign In / Sign Out (로그인과 로그아웃) | Welcome의 **Sign In**, **Create Account**, **Continue with Google**과 Work 메뉴의 **Sign In...**, **Sign Out**. | `workbench/browser/parts/editor/welcomeAccount.ts` 및 `workbench/contrib/work/browser/work.contribution.ts` | [이메일과 비밀번호로 로그인하기](getting-started.md#이메일과-비밀번호로-로그인하기), [Google 로그인 설정](getting-started.md#개발-환경에서-google-로그인-설정하기) |

Decided in: wr-cbej
