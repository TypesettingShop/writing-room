# VS Code 메뉴, 커맨드, 키바인딩

고정한 커밋(`41004e061e582855eb1e99b6a6e5d52994f661be`)의 VS Code가 커맨드, 메뉴, 컨텍스트 키, 키바인딩, 커맨드 팔레트를 어떻게 엮는지 정리한다. 경로는 모두 `src/vs/...` 전체 경로이며 이 워크벤치에서는 `src/...`로 대응한다([architecture.md](architecture.md)). 홈은 [README.md](README.md).

범위는 v0.1.0이 따르는 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄)에 걸친 메커니즘이다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 범위 밖이라 이름만 적는다.

## 한눈에 보는 흐름

| 단계 | 하는 일 | 결정하는 심볼 |
|---|---|---|
| 1. 커맨드 등록 | id 에서 핸들러로의 전역 맵 | `CommandsRegistry` |
| 2. 메뉴 항목 등록 | MenuId 별로 커맨드 참조 + `when`/`group`/`order` | `MenuRegistry.appendMenuItem` |
| 3. 한 번에 등록 | 위 둘과 키바인딩, 팔레트 노출을 한 선언에서 | `Action2`, `registerAction2` |
| 4. 컨텍스트 평가 | `when` 절이 지금 참인가 | `ContextKeyExpr`, `IContextKeyService.contextMatchesRules` |
| 5. 메뉴 구체화 | 레지스트리 + 컨텍스트에서 보이는 액션 목록 | `MenuService`, `MenuInfo.compareMenuItems` |
| 6. 키 입력 해석 | 눌린 키 + 컨텍스트에서 커맨드 id | `KeybindingResolver.resolve` |
| 7. 실행 | id 로 핸들러 호출 | `CommandService.executeCommand` |

메뉴 항목 클릭(`MenuItemAction.run`), 키바인딩(`AbstractKeybindingService._doDispatch`), 팔레트 선택(`AbstractCommandsQuickAccessProvider`의 `accept`)은 모두 마지막에 `ICommandService.executeCommand(id, ...args)`로 모인다.

## 1. 커맨드 레지스트리와 서비스

### 1.1 `CommandsRegistry`

파일: `src/vs/platform/commands/common/commands.ts`

| 심볼 | 역할 |
|---|---|
| `CommandsRegistry` (`ICommandRegistry`) | 모듈 전역 싱글턴. 서비스가 아니라 import 시점에 존재한다. |
| `registerCommand(id \| ICommand, handler?)` | id 당 `LinkedList`에 `unshift`한다. 같은 id 를 다시 등록하면 새 것이 앞에 오고 `getCommand`는 첫 항목을 돌려주므로 마지막 등록이 이긴다. 반환된 `IDisposable`로 해제하면 리스트가 비었을 때 id 가 사라진다. |
| `getCommand(id)`, `getCommands()` | 조회. 팔레트나 키바인딩 스키마가 전체 목록을 읽는다. |
| `onDidRegisterCommand` | 등록 때마다 id 를 발행한다. `CommandService`가 "아직 없는 커맨드"를 기다릴 때 쓴다. |
| `registerCommandAlias(oldId, newId)` | 옛 id 를 새 id 로 포워딩하는 커맨드를 등록한다. |
| `ICommand.metadata` (`ICommandMetadata`) | `description`, `args`, `returns`. `args[].constraint`가 있으면 `registerCommand`가 핸들러를 감싸 `validateConstraints`로 인자를 검증한다. |
| `ICommandHandler` | 첫 인자가 `ServicesAccessor`다. 핸들러는 생성자 주입 대신 `accessor.get(IFoo)`로 서비스를 얻는다. |

- 파일 끝의 `CommandsRegistry.registerCommand('noop', ...)`는 아무것도 하지 않는 기본 커맨드다.
- `ICommandService`(같은 파일의 `createDecorator('commandService')`)는 `executeCommand`, `onWillExecuteCommand`, `onDidExecuteCommand`만 갖는다. 레지스트리 접근은 서비스가 아니라 `CommandsRegistry` 직접 참조다.

### 1.2 `CommandService.executeCommand`

파일: `src/vs/workbench/services/commands/common/commandService.ts`. 등록은 파일 끝의 `registerSingleton(ICommandService, CommandService, InstantiationType.Delayed)`.

| 상황 | 동작 |
|---|---|
| 커맨드가 등록되어 있고 `activationEvent`(`onCommand:<id>`)가 이미 완료 | `_tryExecuteCommand`를 즉시 호출 |
| 등록되어 있고 확장 호스트가 아직 준비 안 됨(`_extensionHostIsReady` false) | `activateByEvent`를 기다리지 않고 보낸 뒤 즉시 실행 |
| 등록되어 있고 호스트 준비됨 | `activateByEvent(onCommand:<id>)`를 await 한 뒤 실행(확장이 덮어쓸 기회를 준다) |
| 등록되어 있지 않음 | `onCommand:<id>` 활성화 + `*` 활성화(`_activateStar`, 최대 30초) 와 `onDidRegisterCommand` 중 먼저 오는 것을 경주시키고, 끝나면 실행 |
| `_tryExecuteCommand` | 없으면 `command '<id>' not found`로 reject. 있으면 `onWillExecuteCommand`, `instantiationService.invokeFunction(command.handler, ...args)`, `onDidExecuteCommand` 순. 동기 예외는 reject 로 바뀐다. |

- 이 서비스는 생성자에서 `IExtensionService`를 주입받아 `whenInstalledExtensionsRegistered`, `activationEventIsDone`, `activateByEvent`를 호출한다(확장 호스트 쪽은 [vscode-extensions.md](vscode-extensions.md)).
- `IInstantiationService.invokeFunction`이 `ServicesAccessor`를 만들어 핸들러에 넘긴다.

## 2. 메뉴: `MenuId`, `MenuRegistry`, `Action2`

파일: `src/vs/platform/actions/common/actions.ts`

### 2.1 데이터 모델

| 심볼 | 의미 |
|---|---|
| `MenuId` | 메뉴 위치의 이름표. 정적 인스턴스(`MenuId.CommandPalette`, `MenuId.EditorTitle` 등) 또는 `MenuId.for(ident)`. 생성자는 같은 식별자가 있으면 `TypeError`를 던진다(`_instances` 맵). |
| `IMenuItem` | `command`(`ICommandAction`), `alt`, `when`, `group`, `order`, `isHiddenByDefault`. |
| `ISubmenuItem` | `submenu`(다른 `MenuId`), `title`, `icon`, `when`, `toggled`, `group`, `order`, `isSelection`, `isSplitButton`. |
| `ICommandAction` | 메뉴가 보여 주는 커맨드의 표시 정보: `id`, `title`, `category`, `icon`, `precondition`(활성 조건), `toggled`. 핸들러는 없다. |
| `MenuRegistry` (`IMenuRegistry`) | `addCommand`(표시 정보만 `_commands` 맵에), `appendMenuItem`/`appendMenuItems`(`_menuItems`의 MenuId 별 `LinkedList`), `getMenuItems`, `appendMenuGroup`/`getMenuGroup`(그룹 제목), `onDidChangeMenu`. 변경 이벤트는 `MicrotaskEmitter`로 합쳐진다. |
| `MenuRegistry.getMenuItems(MenuId.CommandPalette)` | 특수 처리. `_appendImplicitItems`가 `addCommand`로 등록된 모든 커맨드 중 아직 메뉴에 없는 것을 암묵적으로 덧붙인다. 즉 팔레트는 기본이 "전부 보임"이다. |

핸들러(`CommandsRegistry`)와 표시 정보(`MenuRegistry._commands`)가 별개 맵이라는 점이 중요하다. 확장은 `commands` 기여 지점으로 후자만 채우고 핸들러는 확장 호스트가 등록한다([vscode-extensions.md](vscode-extensions.md)).

### 2.2 `Action2`와 `registerAction2`

- `Action2`는 `desc: IAction2Options`와 추상 `run(accessor, ...args)`를 가진 클래스다. `IAction2Options` = `ICommandPaletteOptions`(`f1: true`, `title`이 `ILocalizedString`) 또는 `f1?: false`인 변형.
- `registerAction2(ctor)`가 한 번에 하는 일:
  - 같은 id 가 이미 `CommandsRegistry`에 있으면 `Cannot register two commands with the same id`로 throw.
  - `CommandsRegistry.registerCommand`로 핸들러 등록. `metadata`가 없으면 `{ description: title }`.
  - `menu`(단일 또는 배열)마다 `MenuRegistry.appendMenuItem`.
  - `f1: true`이면 `MenuId.CommandPalette`에 항목을 추가하고 `MenuRegistry.addCommand`.
  - `keybinding`(단일 또는 배열)마다 `KeybindingsRegistry.registerKeybindingRule`. `precondition`이 있으면 `ContextKeyExpr.and(precondition, keybinding.when)`으로 합친다. 즉 `precondition`은 키바인딩 활성 조건도 겸한다.
- 반환 `IDisposable`이 위 등록을 모두 해제한다.
- 용례: `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts`의 `ShowAllCommandsAction`이 `Action2`를 상속하고 `keybinding`과 `f1: true`를 함께 선언한다.

## 3. `MenuService`와 정렬 순서

파일: `src/vs/platform/actions/common/menuService.ts`. 등록은 `src/vs/platform/actions/common/actions.contribution.ts`의 `registerSingleton(IMenuService, MenuService, InstantiationType.Delayed)`.

### 3.1 API

| 호출 | 의미 |
|---|---|
| `MenuService.createMenu(id, contextKeyService, options?)` | 살아 있는 `IMenu`(`MenuImpl`). `onDidChange`를 발행한다. 기본 옵션 `eventDebounceDelay: 50`, `emitEventsForSubmenuChanges: false`. |
| `MenuService.getMenuActions(id, contextKeyService, options?)` | 일회성 스냅샷. `createMenuActionGroups`를 직접 호출. |
| `MenuService.getMenuContexts(id)` | 그 메뉴 평가에 쓰이는 컨텍스트 키 이름 집합(`MenuInfoSnapshot`). |
| `MenuService.resetHiddenStates(ids?)` | 사용자가 숨긴 항목 복원. |

`IMenu.getActions()`는 `[groupId, (MenuItemAction | SubmenuItemAction)[]][]`을 돌려준다.

### 3.2 구체화 단계

1. `MenuRegistry.getMenuItems(id)` 로 항목을 모은다.
2. `MenuInfo.compareMenuItems`로 정렬한다(아래 표).
3. `groupAdjacentBy`로 인접한 같은 `group` 끼리 묶는다(`groupMenuItems`). 빈 그룹 이름은 `''`.
4. `MenuInfo.createActionGroups`가 `contextKeyService.contextMatchesRules(item.when)`으로 거른다.
5. `createActionGroups`가 `MenuItemAction`/`SubmenuItemAction`을 만든다. 서브메뉴는 재귀로 구체화하고, 보이는 액션이 0개이면 서브메뉴 항목 자체를 만들지 않는다. 액션이 없는 그룹도 결과에서 빠진다.
6. `MenuItemAction`의 `enabled`는 `precondition`을 컨텍스트로 평가한 값이다(숨김과 비활성은 다르다: `when`은 숨김, `precondition`은 비활성). `run`은 `commandService.executeCommand(this.id, ...args)`.

### 3.3 정렬 순서 (`MenuInfo.compareMenuItems`)

| 우선순위 | 규칙 |
|---|---|
| 1 | `group`이 다르면: 빈 그룹은 맨 뒤 |
| 2 | `'navigation'` 그룹이 맨 앞 |
| 3 | 나머지 그룹은 `localeCompare`로 사전순(그래서 `1_open`, `2_save`처럼 숫자 접두사를 쓴다) |
| 4 | 같은 그룹 안에서는 `order`(기본 0) 오름차순 |
| 5 | 같으면 제목(`ILocalizedString`이면 `original`)의 `localeCompare` |

- 확장 기여의 `group: "name@5"`는 `menusExtensionPoint.ts`가 마지막 `@`에서 잘라 `group`과 `order`로 만든다.
- 사용자가 숨긴 항목은 `PersistedMenuHideState`가 `IStorageService`의 키 `menu.hiddenCommands`(`StorageScope.PROFILE`)에 저장한다. `IMenuItem.isHiddenByDefault`가 기본값. 저장소는 [vscode-state-settings.md](vscode-state-settings.md).

## 4. 컨텍스트 키와 `when` 절

### 4.1 표현식: `ContextKeyExpr`, `Parser`

파일: `src/vs/platform/contextkey/common/contextkey.ts` (토큰화는 같은 디렉터리의 `scanner.ts`의 `Scanner`)

| 심볼 | 역할 |
|---|---|
| `ContextKeyExpr` | 정적 팩토리: `has`, `equals`, `regex`, `in`, `not`, `and`, `or`, `greater` 등. 반환은 `ContextKeyExpression`(정규화된 불변 노드). |
| `ContextKeyExpr.deserialize(str)` | 정적 `Parser` 인스턴스(`regexParsingWithErrorRecovery: false`)로 문자열을 파싱. `null`/`undefined`는 `undefined`를, 빈 문자열은 파서가 오류로 보고한다. 확장 `when`이 이 경로로 들어온다. |
| `Parser` | `Scanner`로 토큰을 만들고 재귀 하강으로 파싱한다. 주석대로 노드 생성자가 정규화를 하므로 정확한 구문 트리가 아니라 정규화된 트리를 얻는다. `lexingErrors`, `parsingErrors`로 진단을 노출한다. |
| 각 노드 | `evaluate(context)`, `serialize()`, `keys()`(이 식이 읽는 키 목록), `negate()`. `keys()`가 메뉴가 어떤 키 변화에 반응할지 정하는 근거다(`MenuInfoSnapshot._fillInKbExprKeys`). |
| `RawContextKey<T>` | `ContextKeyDefinedExpr`를 상속. 키 이름 + 기본값 + 설명을 가진 타입 있는 키 선언. `bindTo(service)`로 `IContextKey<T>`(`set`/`reset`/`get`)를 얻고, `isEqualTo`, `toNegated`로 식을 만든다. `RawContextKey.all()`은 선언된 키를 열거한다. |

문법 자체(연산자 종류 등)는 `Parser`와 `scanner.ts`가 정의한다. 여기서 옮겨 적지 않는다.

### 4.2 서비스와 스코프

파일: `src/vs/platform/contextkey/browser/contextKeyService.ts`. 등록은 `src/vs/workbench/workbench.common.main.ts`의 `registerSingleton(IContextKeyService, ContextKeyService, ...)`.

| 심볼 | 역할 |
|---|---|
| `Context` | 키-값 레코드 + `_parent`. 값 조회는 부모 사슬을 따라 올라간다. `updateParent`는 부모가 바뀔 때 영향받는 키 목록을 계산한다. |
| `ContextKeyService` | 루트(`_myContextId` 0). `ConfigAwareContextValuesContainer`를 써서 `config.<설정키>` 형태의 키를 설정 서비스에서 읽는다. |
| `createScoped(domNode)` → `ScopedContextKeyService` | DOM 노드에 컨텍스트를 붙이고(`data-keybinding-context` 속성에 컨텍스트 id 기록) 부모 컨텍스트를 상속한다. 자식에서 `setContext`하면 그 노드 아래에서만 보인다. |
| `getContext(target)` | DOM 대상에서 위로 올라가며 `findContextAttr`로 가장 가까운 `data-keybinding-context`를 찾아 그 컨텍스트를 반환. 키바인딩 디스패치가 포커스된 요소를 `target`으로 넘기는 이유다. |
| `createOverlay(entries)` | 읽기 전용 덧씌움. 메뉴를 열 때 항목별 값을 임시로 주입한다. |
| `contextMatchesRules(expr)` | `expr.evaluate(컨텍스트)`. `expr`이 `undefined`면 참. |
| `onDidChangeContext`, `bufferChangeEvents` | 변경 이벤트(`PauseableEmitter`로 합쳐짐). |

스코프 서비스를 만드는 곳(워크벤치):

- 에디터 파트: `src/vs/workbench/browser/parts/editor/editorPart.ts`(`createScoped(this.container)`)
- 에디터 그룹: `src/vs/workbench/browser/parts/editor/editorGroupView.ts`
- 사이드바/패널 같은 pane composite: `src/vs/workbench/browser/parts/paneCompositePart.ts`

전역 상태 키는 `src/vs/workbench/browser/contextkeys.ts`의 `WorkbenchContextKeysHandler`가 레이아웃/에디터 상태에 맞춰 갱신한다. 키 선언은 `src/vs/workbench/common/contextkeys.ts`:

| 키 선언 | 키 이름 | 의미 |
|---|---|---|
| `TitleBarVisibleContext` | `titleBarVisible` | 제목 표시줄 표시 |
| `SideBarVisibleContext` | `sideBarVisible` | 사이드바 표시 |
| `EditorsVisibleContext` | `editorIsOpen` | 열린 에디터 있음 |
| `PanelVisibleContext` | `panelVisible` | 패널 표시 |
| `PanelFocusContext` | `panelFocus` | 패널에 포커스 |
| `StatusBarFocused` | `statusBarFocused` | 상태 표시줄에 포커스 |
| `ActiveEditorContext` | `activeEditor` | 활성 에디터 종류 id |
| `ActiveEditorGroupEmptyContext` | `activeEditorGroupEmpty` | 활성 그룹이 비었는가 |

플랫폼 키(`IsMacContext`, `IsWebContext`, `IsMacNativeContext`, `InputFocusedContext` 등)는 `src/vs/platform/contextkey/common/contextkeys.ts`에 있다.

## 5. 메뉴 바

### 5.1 구성 요소

| 파일 | 심볼 | 역할 |
|---|---|---|
| `src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts` | `MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, ...)` | 최상위 메뉴 정의. 각 항목은 `submenu`(`MenuId.MenubarFileMenu` 등) + `title`(`value`, `original`, `mnemonicTitle`) + `order`. |
| `src/vs/workbench/browser/parts/titlebar/menubarControl.ts` | `MenubarControl`(추상) | `MenuId.MenubarMainMenu`를 `createMenu`해 `setupMainMenu`에서 최상위 서브메뉴마다 `IMenu`를 만든다. 설정, 키바인딩, 최근 항목, 업데이트 상태 변화에 `menuUpdater`(`RunOnceScheduler` 200ms)로 갱신. 열기 최근 목록(`getOpenRecentActions`) 담당. |
| 같은 파일 | `CustomMenubarControl` | `MenuBar` 위젯을 DOM 에 설치하는 구현. `setupCustomMenubar`가 `new MenuBar(container, getMenuBarOptions(), defaultMenuStyles)`. 웹용 `MenuId.MenubarHomeMenu`도 만든다. |
| `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` | `installMenubar` | `CustomMenubarControl`을 만들어 왼쪽 콘텐츠의 `div.menubar`(`role="menubar"`)에 넣는다. |
| `src/vs/base/browser/ui/menu/menubar.ts` | `MenuBar` | 가로 막대와 최상위 항목, 마우스/키보드/니모닉 처리. |
| `src/vs/base/browser/ui/menu/menu.ts` | `Menu`(`ActionBar` 상속), `BaseMenuActionViewItem`, `SubmenuMenuActionViewItem`, `MenuSeparatorActionViewItem` | 드롭다운 메뉴 위젯. `IMenuStyles`로 테마. 니모닉 정규식 `MENU_MNEMONIC_REGEX`. |

- 네이티브 구현 `NativeMenubarControl`은 `src/vs/workbench/electron-browser/parts/titlebar/menubarControl.ts`에 있고 데스크톱 빌드 범위라 설명하지 않는다. 이 커밋의 브라우저 경로에서 `MenubarControl`의 구체 구현은 `CustomMenubarControl` 하나다.
- 가시성은 설정 `MenuSettings.MenuBarVisibility`(`src/vs/platform/window/common/window.ts`)를 `getMenuBarVisibility`가 해석한다(`default`, 네이티브 메뉴가 있는 `compact`, 맥 네이티브는 `classic`으로 바뀌고, 그 밖에는 설정값 `classic`/`visible`/`toggle`/`hidden`/`compact` 그대로. `compact`는 `CustomMenubarControl`이 압축 메뉴로 그린다).

### 5.2 최상위 메뉴 목록 (이 커밋)

`menubar.contribution.ts`와 `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`가 `MenuId.MenubarMainMenu`에 넣는 항목:

| order | 제목 | 서브메뉴 `MenuId` | 정의 위치 |
|---|---|---|---|
| 1 | File | `MenubarFileMenu` | `menubar.contribution.ts` |
| 2 | Edit | `MenubarEditMenu` | 〃 |
| 3 | Selection | `MenubarSelectionMenu` | 〃 |
| 4 | View | `MenubarViewMenu` | 〃 |
| 5 | Go | `MenubarGoMenu` | 〃 |
| 6 | Run | `MenubarDebugMenu` | `debug.contribution.ts` (`when`: `IsSessionsWindowContext.negate()`) |
| 7 | Terminal | `MenubarTerminalMenu` | `menubar.contribution.ts` |
| 8 | Help | `MenubarHelpMenu` | 〃 |
| 9 | Preferences | `MenubarPreferencesMenu` | 〃 (`when`: `IsMacNativeContext`) |

Run 과 Terminal 은 이 워크벤치 범위 밖이므로 어떤 최상위 메뉴를 따를지는 [architecture.md](architecture.md)의 차이 항목에서 정한다. 최상위 목록이 "메뉴 구조 + 순서" 데이터일 뿐 코드가 아니라는 점이 시사점이다.

### 5.3 확장은 최상위 메뉴를 기여할 수 없다

파일: `src/vs/workbench/services/actions/common/menusExtensionPoint.ts`

- `apiMenus: IAPIMenu[]`(`key`, `id: MenuId`, `description`, 선택적 `proposed`, `supportsSubmenus`)가 `menus` 기여 지점이 허용하는 키의 전체 목록이다. 이 커밋에서 98개이다.
- 이 표에 `MenuId.MenubarMainMenu`, `MenubarFileMenu`, `MenubarEditMenu`, `MenubarViewMenu`, `MenubarGoMenu`, `MenubarHelpMenu` 등으로 연결되는 키는 없다. 메뉴 바와 관련된 키는 `menuBar/home`(`MenubarHomeMenu`, 제안 API `contribMenuBarHome`), `menuBar/edit/copy`(`MenubarCopy`), `file/newFile`(`NewFile`), `file/share`(`MenubarShare`, 제안 API `contribShareMenu`)뿐이다. 모두 기존 메뉴 안쪽의 정해진 자리다.
- `menus` 핸들러(`menusExtensionPoint.setHandler`)는 키가 `_apiMenusByKey`에도, 확장이 `submenus`로 선언한 id 에도 없으면 오류 없이 `continue`로 건너뛴다. 최상위에 항목을 추가하려는 시도는 조용히 무시된다.
- `proposed`가 있는 키는 `isProposedApiEnabled`가 거짓이면 `collector.error`로 막는다.
- `supportsSubmenus === false`인 키(`commandPalette`, `touchBar`, `file/newFile` 등)에는 서브메뉴 항목을 넣을 수 없다.
- 확장 서브메뉴는 `submenus` 기여 지점이 `MenuId.for('api:' + id)`로 만든다. `menus` 에서 그 id 를 키로 쓰면 서브메뉴 안에 항목을 넣는다.
- 항목이 참조하는 `command`는 `MenuRegistry.getCommand`로 조회되므로 먼저 `commands` 기여 지점(`commandsExtensionPoint`)에 선언되어 있어야 한다. 없으면 `missing.command` 오류.
- `group`은 `name@order` 형식을 해석한다. `when`은 `ContextKeyExpr.deserialize`.

## 6. 키바인딩

### 6.1 레지스트리

파일: `src/vs/platform/keybinding/common/keybindingsRegistry.ts`

| 심볼 | 역할 |
|---|---|
| `KeybindingsRegistry` (`KeybindingsRegistryImpl`) | 전역 싱글턴. `registerKeybindingRule`, `registerCommandAndKeybindingRule`(커맨드 핸들러까지 함께), `setExtensionKeybindings`, `getDefaultKeybindings`, `getDefaultKeybindingsForOS`. |
| `IKeybindingRule` | `id`(커맨드), `weight`, `args`, `when`, `primary`, `secondary`, `win`/`linux`/`mac`. 플랫폼별 값은 `bindToCurrentPlatform`이 현재 OS 에 맞게 줄인다. `primary`를 `decodeKeybinding`한 결과가 `_coreKeybindings`에 들어간다. |
| `KeybindingWeight` | 우선순위 구간: `EditorCore` 0, `EditorContrib` 100, `WorkbenchContrib` 200, `SessionsContrib` 250, `BuiltinExtension` 300, `ExternalExtension` 400. |
| `getDefaultKeybindings()` | 코어 + 확장 키바인딩을 합쳐 `sorter`로 정렬. `sorter`는 `weight1`, 그다음 커맨드 id 문자열, 그다음 `weight2`. |

- 큰 weight 일수록 나중에 있고, 뒤에 있을수록 이긴다(6.2). 확장 키바인딩은 내장 확장 300 + 인덱스, 외부 확장 400 + 인덱스(`src/vs/workbench/services/keybinding/browser/keybindingService.ts`의 `_asCommandRule`).
- `Action2.desc.keybinding`은 `registerAction2`를 거쳐 여기로 온다.

### 6.2 해석: `KeybindingResolver`

파일: `src/vs/platform/keybinding/common/keybindingResolver.ts`

| 심볼 | 역할 |
|---|---|
| 생성자 | 기본 + 사용자 `overrides`를 이어 붙인 뒤 `handleRemovals`로 `-commandId` 형태의 제거 규칙을 적용하고, 첫 코드(chord) 문자열로 `_map`, 커맨드로 `_lookupMap`을 만든다. |
| `resolve(context, currentChords, keypress)` | 반환 `ResolutionResult`의 `kind`: `NoMatchingKb`, `MoreChordsNeeded`, `KbFound`(`commandId`, `commandArgs`, `isBubble`). 후보를 첫 코드로 찾고, 코드가 둘 이상이면 이미 눌린 코드의 접두를 비교한다. |
| `_findCommand` | 후보를 **뒤에서부터** 훑어 `when`이 참인 첫 항목을 고른다. 그래서 같은 키에 대해 나중 항목(큰 weight, 사용자 정의)이 이긴다. |
| `lookupKeybindings`, `lookupPrimaryKeybinding` | 커맨드에서 키를 역조회. 메뉴와 팔레트가 단축키를 표시할 때 쓴다. |
| `_addKeyPress`, `whenIsEntirelyIncluded` | 첫 코드별 `_map`에 항목을 쌓는다. 뒤 항목의 `when`이 앞 항목(다른 커맨드)의 `when`을 완전히 포함하면 앞 항목은 역조회용 `_lookupMap`에서만 빠진다. `_map`에는 남으므로 실제 해석 순서는 `_findCommand`가 정한다. |
| `applyAliases` | `KeybindingsRegistry.getKeybindingAliases()`로 옛 id 별칭 처리. |

### 6.3 디스패치와 코드

파일: `src/vs/platform/keybinding/common/abstractKeybindingService.ts`의 `AbstractKeybindingService`

| 심볼 | 역할 |
|---|---|
| `_dispatch` / `dispatchEvent` | 키 이벤트를 `resolveKeyboardEvent`로 `ResolvedKeybinding`으로 바꾼 뒤 `_doDispatch`. IME 조합 중에는 무시한다. |
| `_doDispatch` | `_contextKeyService.getContext(target)`으로 포커스 위치의 컨텍스트를 얻고 `_getResolver().resolve(...)`. 결과에 따라: `NoMatchingKb`(코드 중이면 상태 줄에 "...is not a command" 알림, 코드 모드 종료), `MoreChordsNeeded`(`_expectAnotherChord`로 다음 키 대기), `KbFound`(코드 모드 종료 후 `commandService.executeCommand` 호출). 반환값은 `preventDefault` 여부이고 `isBubble`이면 막지 않는다. |
| `_currentChords`, `inChordMode` | 눌린 코드 누적. |
| `_scheduleLeaveChordMode` | 500ms 간격 점검, 문서가 포커스를 잃거나 5초가 지나면 `_leaveChordMode`. |
| 단일 모디파이어 코드(예: shift shift) | `_currentSingleModifier`와 300ms 타이머 경로(`_singleModifierDispatch`). |
| `softDispatch` | 실행 없이 해석만(어떤 결과가 될지 묻는 용도). |

브라우저 서비스: `src/vs/workbench/services/keybinding/browser/keybindingService.ts`

| 심볼 | 역할 |
|---|---|
| `WorkbenchKeybindingService` | `AbstractKeybindingService` 구현. 파일 끝에서 `registerSingleton(IKeybindingService, WorkbenchKeybindingService, InstantiationType.Eager)`. |
| `_registerKeyListeners` | 각 `window`의 `keydown`에서 `_dispatch(keyEvent, keyEvent.target)`를 부르고 결과가 참이면 `preventDefault`. 보조 창에도 리스너를 붙인다(`dom.onDidRegisterWindow`). |
| `_getResolver` | `_cachedResolver`를 지연 생성: `KeybindingsRegistry.getDefaultKeybindings()` + 사용자 키바인딩을 `_keyboardMapper.resolveKeybinding`으로 풀어 `KeybindingResolver`에 전달. 갱신 시 캐시를 null 로 하고 `onDidUpdateKeybindings`를 발행. |
| `_keyboardMapper` | `IKeyboardLayoutService`(웹은 `BrowserKeyboardLayoutService`, 같은 디렉터리의 `keyboardLayoutService.ts`)가 제공하는 자판 배열별 매퍼. 같은 물리 키가 레이아웃마다 다른 문자가 되는 문제를 여기서 푼다. |
| `UserKeybindings` | 사용자 프로필의 `keybindingsResource`(`keybindings.json`)를 `IFileService`로 읽고 감시한다. |
| `keybindingsExtPoint` | `extensionPoint: 'keybindings'`, `deps: [commandsExtensionPoint]`. `_handleKeybindingsExtensionPointUser` → `_asCommandRule`가 `key`, `mac`, `linux`, `win`, `command`, `args`, `when`을 `IExtensionKeybindingRule`로 바꿔 `KeybindingsRegistry.setExtensionKeybindings`에 넣는다. |

## 7. 커맨드 팔레트

| 파일 | 심볼 | 역할 |
|---|---|---|
| `src/vs/platform/quickinput/common/quickInput.ts` | `IQuickInputService` | `pick`, `input`, `createQuickPick`, `createInputBox`, `quickAccess`, `focus`, `toggle`, `navigate`, `accept`, `cancel` 등 서비스 계약. `IQuickPick`/`IInputBox`/`IQuickPickItem` 타입도 여기 있다. |
| `src/vs/platform/quickinput/browser/quickInputService.ts` | `QuickInputService` | `createController`로 컨트롤러를 만들고 `quickAccess`(`QuickAccessController`)를 지연 생성한다. 워크벤치 쪽 등록은 `src/vs/workbench/services/quickinput/browser/quickInputService.ts`의 `registerSingleton(IQuickInputService, ...)`. |
| `src/vs/platform/quickinput/browser/quickInputController.ts` | `QuickInputController` | DOM 을 소유하는 컨트롤러. `pick`, `input`, `createQuickPick`, `show`, `hide`.  |
| `src/vs/platform/quickinput/browser/quickAccess.ts` | `QuickAccessController` | 입력 접두사로 제공자를 고른다. `show(value)`는 레지스트리(`Extensions.Quickaccess`)에서 접두사에 맞는 제공자를 찾아 피커에 연결한다. |
| `src/vs/platform/quickinput/browser/commandsQuickAccess.ts` | `AbstractCommandsQuickAccessProvider` | 접두사 `>`. `_getPicks`가 필터링(`WORD_FILTER`, 필요 시 TF-IDF 관련 정보), 최근 사용 기록(`CommandsHistory`, 키는 `StorageScope.PROFILE`)으로 정렬. 항목 `accept`가 `commandsHistory.push` 후 `commandService.executeCommand`를 호출하고 실패하면 `dialogService.error`. 구체 클래스는 `getCommandPicks`를 구현한다. |
| `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts` | `CommandsQuickAccessProvider` | `getCommandPicks`가 `getCodeEditorCommandPicks()`(활성 에디터 액션)와 `getGlobalCommandPicks()`를 합친다. 후자는 활성 에디터 페인 또는 활성 그룹의 스코프 컨텍스트로 `menuService.getMenuActions(MenuId.CommandPalette, ...)`를 호출하고 `MenuItemAction`이면서 `enabled`인 것만 남긴다. 제목에 `category: title`을 붙인다. |
| 같은 파일 | `ShowAllCommandsAction` | `workbench.action.showCommands`. `Action2`로 `Ctrl/Cmd+Shift+P`(Firefox 제외)와 `F1`, `f1: true`. `run`은 `quickAccess.show(CommandsQuickAccessProvider.PREFIX)`. |
| `src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts` | `quickAccessRegistry.registerQuickAccessProvider` | 제공자를 접두사와 컨텍스트 키(`inCommandsPicker`)로 등록하고 View 메뉴(`MenuId.MenubarViewMenu`)와 Help 메뉴에 팔레트 항목을 추가한다. |

결론: 팔레트는 `MenuId.CommandPalette`라는 메뉴를 렌더링하는 퀵 픽 UI 일 뿐이다. 커맨드가 팔레트에 보이는지는 `Action2`의 `f1: true`, `precondition`, 확장의 `commandPalette` 메뉴 `when`으로 결정된다.

## 8. 이 워크벤치에 주는 시사점

사실(위)과 구분되는 제안이다. 확정이 아니며 차이는 [architecture.md](architecture.md)에 기록한다.

- 커맨드 id 를 문자열 키로 쓰는 레지스트리 하나, 메뉴를 MenuId 단위 레지스트리 하나로 두면 여섯 파트의 UI 를 같은 규칙으로 채울 수 있다.
- 키바인딩과 메뉴가 같은 `when` 평가기를 공유하므로 컨텍스트 키 서비스가 먼저 있어야 한다.
- 확장 기여 지점은 최상위 메뉴를 열지 않는 것이 VS Code 의 결정이므로 이 워크벤치도 같은 제약을 따를 수 있다.
- 키 입력 단계는 "키 이벤트에서 코드로, 코드에서 `resolve`, 그다음 `executeCommand`"로 분리돼 있어 단위 테스트가 쉽다.

Decided in: wr-e8v6
