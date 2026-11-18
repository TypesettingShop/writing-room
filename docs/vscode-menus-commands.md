# VS Code 메뉴, 커맨드, 키바인딩

고정 커밋(`41004e061e582855eb1e99b6a6e5d52994f661be`)의 VS Code가 커맨드, 메뉴, 컨텍스트 키, 키바인딩, 커맨드 팔레트를 어떻게 연계하는지 정리한다. 경로는 모두 `src/vs/...` 전체 경로이며 writing-room에서는 `src/...`로 대응한다([architecture.md](architecture.md)). 개요는 [README.md](README.md)를 참조한다.

범위는 v0.1.0에서 다루는 여섯 파트(제목 표시줄, 액티비티 바, 사이드바, 에디터, 패널, 상태 표시줄) 전반의 동작 메커니즘이다. 채팅, 세션, 노트북, 터미널, 디버그, 설정 에디터 UI, 원격, 데스크톱 빌드는 범위 밖이므로 이름만 표기한다.

## 한눈에 보는 흐름

| 단계 | 하는 일 | 결정하는 심볼 |
|---|---|---|
| 1. 커맨드 등록 | id에서 핸들러로 이어지는 전역 매핑 | `CommandsRegistry` |
| 2. 메뉴 항목 등록 | MenuId별 커맨드 참조 및 `when`/`group`/`order` 지정 | `MenuRegistry.appendMenuItem` |
| 3. 단일 선언 등록 | 커맨드, 메뉴 항목, 키바인딩, 팔레트 노출을 하나의 선언으로 일괄 등록 | `Action2`, `registerAction2` |
| 4. 컨텍스트 평가 | 현재 상태에서 `when` 조건의 참/거짓 평가 | `ContextKeyExpr`, `IContextKeyService.contextMatchesRules` |
| 5. 메뉴 구체화 | 레지스트리와 컨텍스트를 기반으로 실제 표시할 액션 목록 생성 | `MenuService`, `MenuInfo.compareMenuItems` |
| 6. 키 입력 해석 | 입력된 키와 현재 컨텍스트를 조합하여 커맨드 id 해석 | `KeybindingResolver.resolve` |
| 7. 실행 | 결정된 id로 해당 핸들러 실행 | `CommandService.executeCommand` |

메뉴 항목 클릭(`MenuItemAction.run`), 키바인딩 트리거(`AbstractKeybindingService._doDispatch`), 팔레트 선택(`AbstractCommandsQuickAccessProvider`의 `accept`)은 모두 최종적으로 `ICommandService.executeCommand(id, ...args)`를 호출한다.

## 1. 커맨드 레지스트리와 서비스

### 1.1 `CommandsRegistry`

파일: `src/vs/platform/commands/common/commands.ts`

| 심볼 | 역할 |
|---|---|
| `CommandsRegistry` (`ICommandRegistry`) | 모듈 전역 싱글톤 인스턴스. DI 서비스가 아니라 모듈 import 시점에 즉시 생성된다. |
| `registerCommand(id \| ICommand, handler?)` | id별 `LinkedList`의 맨 앞(`unshift`)에 등록한다. 동일한 id를 중복 등록하면 새 핸들러가 앞에 위치하고 `getCommand`는 첫 번째 항목을 반환하므로 가장 마지막에 등록된 핸들러가 우선한다. 반환된 `IDisposable`로 등록을 해제하면 리스트가 비었을 때 해당 id 항목이 완전히 제거된다. |
| `getCommand(id)`, `getCommands()` | 커맨드 조회. 팔레트나 키바인딩 스키마 생성기가 전체 커맨드 목록을 조회할 때 사용한다. |
| `onDidRegisterCommand` | 커맨드가 등록될 때마다 id를 발행하는 이벤트. `CommandService`가 "아직 등록되지 않은 커맨드"의 등록을 기다릴 때 활용한다. |
| `registerCommandAlias(oldId, newId)` | 이전 id를 새 id로 전달하는 별칭(alias) 커맨드를 등록한다. |
| `ICommand.metadata` (`ICommandMetadata`) | `description`, `args`, `returns` 메타데이터 정의. `args[].constraint`가 존재하면 `registerCommand`가 핸들러를 래핑하여 `validateConstraints`로 인자 유효성을 검증한다. |
| `ICommandHandler` | 첫 번째 인자로 `ServicesAccessor`를 전달받는다. 핸들러는 생성자 주입 대신 `accessor.get(IFoo)`를 통해 필요한 서비스를 조회한다. |

- 파일 하단의 `CommandsRegistry.registerCommand('noop', ...)`는 아무 동작도 수행하지 않는 기본 no-op 커맨드다.
- `ICommandService`(동일 파일 내 `createDecorator('commandService')`)는 `executeCommand`, `onWillExecuteCommand`, `onDidExecuteCommand`만을 정의한다. 레지스트리 접근은 서비스 메서드가 아니라 `CommandsRegistry` 전역 싱글톤을 직접 참조하여 이루어진다.

### 1.2 `CommandService.executeCommand`

파일: `src/vs/workbench/services/commands/common/commandService.ts`. 서비스 등록은 파일 하단의 `registerSingleton(ICommandService, CommandService, InstantiationType.Delayed)`에서 수행된다.

| 상황 | 동작 |
|---|---|
| 커맨드가 등록되어 있고 `activationEvent`(`onCommand:<id>`)가 이미 완료 | `_tryExecuteCommand`를 즉시 호출 |
| 커맨드가 등록되어 있으나 확장 호스트가 아직 준비되지 않은 경우(`_extensionHostIsReady` false) | `activateByEvent` 완료를 기다리지 않고 비동기로 요청을 보낸 뒤 즉시 실행한다. |
| 커맨드가 등록되어 있고 확장 호스트가 준비된 경우 | `activateByEvent(onCommand:<id>)` 완료를 대기한 뒤 실행한다(확장이 커맨드를 가로채거나 재정의할 기회를 제공). |
| 커맨드가 등록되어 있지 않은 경우 | `onCommand:<id>` 활성화와, `*` 활성화(`_activateStar`, 최대 30초 대기)와 `onDidRegisterCommand` 이벤트 중 먼저 끝나는 쪽을 `Promise.all`로 함께 기다린 뒤 `_tryExecuteCommand`를 호출한다. 그때도 등록되지 않았으면 `not found` 에러로 거부된다. |
| `_tryExecuteCommand` | 커맨드가 없으면 `command '<id>' not found` 에러로 거부(reject)한다. 존재하면 `onWillExecuteCommand` 발생 -> `instantiationService.invokeFunction(command.handler, ...args)` 실행 -> `onDidExecuteCommand` 발생 순으로 처리한다. 동기 예외는 reject 처리된다. |

- 이 서비스는 생성자에서 `IExtensionService`를 주입받아 `whenInstalledExtensionsRegistered`, `activationEventIsDone`, `activateByEvent`를 호출한다(확장 호스트 세부 내용은 [vscode-extensions.md](vscode-extensions.md) 참조).
- `IInstantiationService.invokeFunction`이 `ServicesAccessor`를 생성하여 핸들러에 전달한다.

## 2. 메뉴: `MenuId`, `MenuRegistry`, `Action2`

파일: `src/vs/platform/actions/common/actions.ts`

### 2.1 데이터 모델

| 심볼 | 의미 |
|---|---|
| `MenuId` | 메뉴 위치 식별자. 정적 인스턴스(`MenuId.CommandPalette`, `MenuId.EditorTitle` 등) 또는 `MenuId.for(ident)`로 생성한다. 생성자는 동일한 식별자가 이미 존재하면 `TypeError`를 던진다(`_instances` 맵 검사). |
| `IMenuItem` | `command`(`ICommandAction`), `alt`, `when`, `group`, `order`, `isHiddenByDefault`. |
| `ISubmenuItem` | `submenu`(대상 `MenuId`), `title`, `icon`, `when`, `toggled`, `group`, `order`, `isSelection`, `isSplitButton`. |
| `ICommandAction` | 메뉴에 노출되는 커맨드의 표시 메타데이터: `id`, `title`, `category`, `icon`, `precondition`(활성화 조건), `toggled`. 핸들러 본체는 포함하지 않는다. |
| `MenuRegistry` (`IMenuRegistry`) | `addCommand`(표시 정보를 `_commands` 맵에 등록), `appendMenuItem`/`appendMenuItems`(`_menuItems` 내 MenuId별 `LinkedList`에 추가), `getMenuItems`, `appendMenuGroup`/`getMenuGroup`(그룹 제목 관리), `onDidChangeMenu`. 변경 이벤트는 `MicrotaskEmitter`로 병합된다. |
| `MenuRegistry.getMenuItems(MenuId.CommandPalette)` | 팔레트 전용 특수 처리. `_appendImplicitItems`가 `addCommand`로 등록된 모든 커맨드 중 아직 메뉴 항목으로 명시 등록되지 않은 항목들을 암묵적으로 추가한다. 즉 팔레트에서는 기본적으로 등록된 모든 커맨드가 노출된다. |

핸들러 관리(`CommandsRegistry`)와 메뉴 표시 정보 관리(`MenuRegistry._commands`)가 분리된 독립 맵이라는 점이 핵심이다. 확장은 `commands` 기여 지점을 통해 표시 메타데이터만 우선 등록하고, 실제 핸들러는 확장 호스트 활성화 시점에 등록된다([vscode-extensions.md](vscode-extensions.md)).

### 2.2 `Action2`와 `registerAction2`

- `Action2`는 `desc: IAction2Options` 메타데이터와 추상 메서드 `run(accessor, ...args)`를 정의하는 기본 클래스다. `IAction2Options`는 `ICommandPaletteOptions`(`f1: true`, `title`이 `ILocalizedString`) 형태이거나 `f1?: false`인 형태를 갖는다.
- `registerAction2(ctor)`는 단일 호출로 다음 작업을 일괄 처리한다:
  - 동일한 id가 이미 `CommandsRegistry`에 등록되어 있으면 `Cannot register two commands with the same id` 예외를 발생시킨다.
  - `CommandsRegistry.registerCommand`를 호출해 핸들러를 등록한다. `metadata`가 없으면 `{ description: title }`을 기본 생성한다.
  - `menu` 선언(단일 또는 배열)에 지정된 각 메뉴 위치마다 `MenuRegistry.appendMenuItem`을 호출한다.
  - `f1: true`로 설정된 경우 `MenuId.CommandPalette`에 메뉴 항목을 추가하고 `MenuRegistry.addCommand`를 호출한다.
  - `keybinding`(단일 또는 배열)마다 `KeybindingsRegistry.registerKeybindingRule`. `precondition`이 있으면 `ContextKeyExpr.and(precondition, keybinding.when)`으로 합친다. 즉 `precondition`은 키바인딩 활성 조건도 겸한다.
- 반환되는 `IDisposable` 객체를 dispose하면 위 등록 항목들이 한 번에 해제된다.
- 적용 예시: `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts`의 `ShowAllCommandsAction`이 `Action2`를 상속하여 `keybinding`과 `f1: true` 설정을 함께 선언한다.

## 3. `MenuService`와 정렬 순서

파일: `src/vs/platform/actions/common/menuService.ts`. 등록은 `src/vs/platform/actions/common/actions.contribution.ts`의 `registerSingleton(IMenuService, MenuService, InstantiationType.Delayed)`에서 수행된다.

### 3.1 API

| 호출 | 의미 |
|---|---|
| `MenuService.createMenu(id, contextKeyService, options?)` | 반응형 라이브 `IMenu`(`MenuImpl`) 인스턴스 생성. `onDidChange` 이벤트를 발생시킨다. 기본 옵션은 `eventDebounceDelay: 50`, `emitEventsForSubmenuChanges: false`이다. |
| `MenuService.getMenuActions(id, contextKeyService, options?)` | 일회성 액션 목록 스냅샷 조회. `createMenuActionGroups`를 직접 호출한다. |
| `MenuService.getMenuContexts(id)` | 해당 메뉴를 평가할 때 참조되는 컨텍스트 키 이름 집합(`MenuInfoSnapshot`) 반환. |
| `MenuService.resetHiddenStates(ids?)` | 사용자가 숨긴 메뉴 항목의 상태를 초기화하여 복원. |

`IMenu.getActions()`는 `[groupId, (MenuItemAction | SubmenuItemAction)[]][]` 형태의 튜플 배열을 반환한다.

### 3.2 구체화 단계

1. `MenuRegistry.getMenuItems(id)`로 해당 위치의 메뉴 항목들을 수집한다.
2. `MenuInfo.compareMenuItems`를 기준으로 항목들을 정렬한다(아래 정렬 규칙 표 참조).
3. `groupAdjacentBy`를 통해 동일한 `group`을 가진 인접 항목들을 묶는다(`groupMenuItems`). 그룹명이 없으면 빈 문자열 `''`을 부여한다.
4. `MenuInfo.createActionGroups`가 각 항목에 대해 `contextKeyService.contextMatchesRules(item.when)`을 평가하여 조건에 맞지 않는 항목을 제외한다.
5. `createActionGroups`가 유효한 항목들로부터 `MenuItemAction` 또는 `SubmenuItemAction` 인스턴스를 생성한다. 서브메뉴는 재귀적으로 구체화하며, 표시 가능한 액션이 0개이면 서브메뉴 항목 자체를 생성하지 않는다. 액션이 하나도 없는 빈 그룹 역시 최종 결과에서 제외된다.
6. `MenuItemAction`의 `enabled` 상태는 `precondition`을 현재 컨텍스트로 평가한 결과다(가시성과 활성화는 구분된다: `when`은 표시 여부, `precondition`은 활성화 여부를 결정한다). `run` 메서드는 내부적으로 `commandService.executeCommand(this.id, ...args)`를 호출한다.

### 3.3 정렬 순서 (`MenuInfo.compareMenuItems`)

| 우선순위 | 규칙 |
|---|---|
| 1 | `group`이 서로 다를 때: 이름이 없는 빈 그룹은 항상 맨 뒤에 배치한다. |
| 2 | `'navigation'` 그룹은 항상 맨 앞에 배치한다. |
| 3 | 그 외 그룹은 `localeCompare`에 따라 사전순으로 정렬한다(이 때문에 `1_open`, `2_save`와 같이 숫자 접두사를 부여해 순서를 제어한다). |
| 4 | 동일 그룹 내부에서는 `order`(기본값 0)의 오름차순으로 정렬한다. |
| 5 | 같으면 제목(`ILocalizedString`이면 `original`)의 `localeCompare` |

- 확장이 기여하는 `group: "name@5"` 구문은 `menusExtensionPoint.ts`가 마지막 `@` 문자를 기준으로 파싱하여 `group` 명칭과 `order` 숫자로 분리한다.
- 사용자가 개별적으로 숨긴 메뉴 항목 상태는 `PersistedMenuHideState`가 `IStorageService`의 `menu.hiddenCommands`(`StorageScope.PROFILE`) 키에 저장한다. 기본 가시성은 `IMenuItem.isHiddenByDefault` 값을 따른다. 저장소 메커니즘은 [vscode-state-settings.md](vscode-state-settings.md)를 참조한다.

## 4. 컨텍스트 키와 `when` 절

### 4.1 표현식: `ContextKeyExpr`, `Parser`

파일: `src/vs/platform/contextkey/common/contextkey.ts` (어휘 분석기는 동일 디렉터리 `scanner.ts`의 `Scanner`)

| 심볼 | 역할 |
|---|---|
| `ContextKeyExpr` | 정적 팩토리 클래스: `has`, `equals`, `regex`, `in`, `not`, `and`, `or`, `greater` 등의 표현식 노드를 생성한다. 반환값은 `ContextKeyExpression`(정규화된 불변 노드)이다. |
| `ContextKeyExpr.deserialize(str)` | 정적 `Parser` 인스턴스(`regexParsingWithErrorRecovery: false`)를 사용해 문자열을 파싱한다. `null`/`undefined` 입력은 `undefined`를 반환하고, 빈 문자열은 파서 에러로 처리한다. 확장의 `when` 절 문자열이 이 메서드를 통해 파싱된다. |
| `Parser` | `Scanner`를 통해 토큰 스트림을 생성하고 재귀 하강 방식으로 파싱을 수행한다. 노드 생성자가 내부 정규화를 수행하므로 구문 트리가 아닌 정규화된 표현식 트리를 생성한다. `lexingErrors`와 `parsingErrors`를 통해 진단 정보를 노출한다. |
| 개별 노드 | `evaluate(context)`, `serialize()`, `keys()`(해당 표현식이 참조하는 키 목록), `negate()` 메서드를 제공한다. `keys()`가 반환하는 키 목록을 바탕으로 메뉴가 어떤 키 변경에 반응할지 결정한다(`MenuInfoSnapshot._fillInKbExprKeys`). |
| `RawContextKey<T>` | `ContextKeyDefinedExpr`를 상속하며 키 이름, 기본값, 설명을 갖는 타입 안전한 컨텍스트 키 선언 객체다. `bindTo(service)`를 통해 `IContextKey<T>`(`set`/`reset`/`get`)를 획득하고, `isEqualTo`, `toNegated` 등으로 조건식을 생성한다. `RawContextKey.all()`로 선언된 모든 키를 열거할 수 있다. |

문법 구조 및 연산자 상세 규칙은 `Parser`와 `scanner.ts`에 정의되어 있으므로 본 문서에서는 중복 기술하지 않는다.

### 4.2 서비스와 스코프

파일: `src/vs/platform/contextkey/browser/contextKeyService.ts`. 등록은 `src/vs/workbench/workbench.common.main.ts`의 `registerSingleton(IContextKeyService, ContextKeyService, ...)`에서 수행된다.

| 심볼 | 역할 |
|---|---|
| `Context` | 키-값 쌍의 레코드와 `_parent` 참조를 갖는 자료구조. 값 조회 시 부모 체인을 따라 상위로 탐색한다. `updateParent`는 부모 변경 시 영향받는 키 목록을 재계산한다. |
| `ContextKeyService` | 루트 컨텍스트 서비스(`_myContextId` 0). `ConfigAwareContextValuesContainer`를 통해 `config.<설정키>` 형식의 키를 설정 서비스에서 조회한다. |
| `createScoped(domNode)` → `ScopedContextKeyService` | DOM 노드에 스코프 컨텍스트를 바인딩하고(`data-keybinding-context` 속성에 컨텍스트 id 기록) 부모 컨텍스트를 상속받는다. 자식 서비스에서 `setContext`를 호출하면 해당 DOM 트리 하위에서만 값이 유효하다. |
| `getContext(target)` | 대상 DOM 요소로부터 상위로 탐색하며 `findContextAttr`로 가장 인접한 `data-keybinding-context`를 찾아 해당 컨텍스트를 반환한다. 키바인딩 디스패처가 포커스 요소를 `target`으로 전달하는 이유다. |
| `createOverlay(entries)` | 읽기 전용 오버레이 컨텍스트 생성. 메뉴 표시 시 항목별 임시 값을 주입하는 데 사용된다. |
| `contextMatchesRules(expr)` | `expr.evaluate(컨텍스트)`를 실행한다. `expr`이 `undefined`이면 항상 참으로 평가한다. |
| `onDidChangeContext`, `bufferChangeEvents` | 컨텍스트 변경 이벤트(`PauseableEmitter`로 병합 처리). |

워크벤치 내 주요 스코프 서비스 생성 위치:

- 에디터 파트: `src/vs/workbench/browser/parts/editor/editorPart.ts`(`createScoped(this.container)`)
- 에디터 그룹: `src/vs/workbench/browser/parts/editor/editorGroupView.ts`
- 사이드바/패널 등 페인 컴포지트: `src/vs/workbench/browser/parts/paneCompositePart.ts`

전역 상태 키는 `src/vs/workbench/browser/contextkeys.ts`의 `WorkbenchContextKeysHandler`가 레이아웃 및 에디터 상태 변경에 맞춰 갱신한다. 주요 선언 파일은 `src/vs/workbench/common/contextkeys.ts`이다:

| 키 선언 | 키 이름 | 의미 |
|---|---|---|
| `TitleBarVisibleContext` | `titleBarVisible` | 제목 표시줄 표시 여부 |
| `SideBarVisibleContext` | `sideBarVisible` | 사이드바 표시 여부 |
| `EditorsVisibleContext` | `editorIsOpen` | 열린 에디터 존재 여부 |
| `PanelVisibleContext` | `panelVisible` | 패널 표시 여부 |
| `PanelFocusContext` | `panelFocus` | 패널에 포커스가 위치하는지 여부 |
| `StatusBarFocused` | `statusBarFocused` | 상태 표시줄에 포커스가 위치하는지 여부 |
| `ActiveEditorContext` | `activeEditor` | 활성 에디터 유형 id |
| `ActiveEditorGroupEmptyContext` | `activeEditorGroupEmpty` | 활성 그룹이 비어 있는지 여부 |

플랫폼 관련 기본 키(`IsMacContext`, `IsWebContext`, `IsMacNativeContext`, `InputFocusedContext` 등)는 `src/vs/platform/contextkey/common/contextkeys.ts`에 정의되어 있다.

## 5. 메뉴 바

### 5.1 구성 요소

| 파일 | 심볼 | 역할 |
|---|---|---|
| `src/vs/workbench/browser/parts/titlebar/menubar.contribution.ts` | `MenuRegistry.appendMenuItem(MenuId.MenubarMainMenu, ...)` | 최상위 메뉴 바 구성 항목 정의. 각 항목은 `submenu`(`MenuId.MenubarFileMenu` 등), `title`(`value`, `original`, `mnemonicTitle`), `order`를 갖는다. |
| `src/vs/workbench/browser/parts/titlebar/menubarControl.ts` | `MenubarControl`(추상 클래스) | `MenuId.MenubarMainMenu`로 `createMenu`를 호출하고 `setupMainMenu`에서 각 최상위 서브메뉴별 `IMenu`를 생성한다. 설정, 키바인딩, 최근 항목, 업데이트 상태 변화를 감지하여 `menuUpdater`(`RunOnceScheduler` 200ms)로 갱신한다. 최근 열린 항목 목록(`getOpenRecentActions`) 생성을 담당한다. |
| 동일 파일 | `CustomMenubarControl` | `MenuBar` 위젯을 실제 DOM에 마운트하는 구현체. `setupCustomMenubar`가 `new MenuBar(container, getMenuBarOptions(), defaultMenuStyles)`를 호출한다. 웹 환경용 `MenuId.MenubarHomeMenu`도 함께 생성한다. |
| `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts` | `installMenubar` | `CustomMenubarControl`을 인스턴스화하여 좌측 콘텐츠 컨테이너인 `div.menubar`(`role="menubar"`)에 삽입한다. |
| `src/vs/base/browser/ui/menu/menubar.ts` | `MenuBar` | 가로형 메뉴 바와 최상위 메뉴 항목 UI, 마우스/키보드 탐색 및 니모닉(단축 문자) 처리를 담당한다. |
| `src/vs/base/browser/ui/menu/menu.ts` | `Menu`(`ActionBar` 상속), `BaseMenuActionViewItem`, `SubmenuMenuActionViewItem`, `MenuSeparatorActionViewItem` | 드롭다운 메뉴 위젯 구현체. `IMenuStyles`로 스타일과 테마를 적용한다. 니모닉 정규식은 `MENU_MNEMONIC_REGEX`를 사용한다. |

- 네이티브 데스크톱 메뉴 구현체인 `NativeMenubarControl`은 `src/vs/workbench/electron-browser/parts/titlebar/menubarControl.ts`에 위치하며 데스크톱 빌드 전용이므로 다루지 않는다. 본 커밋의 브라우저 환경에서 `MenubarControl`의 구체 구현체는 `CustomMenubarControl` 하나뿐이다.
- 가시성은 설정 `MenuSettings.MenuBarVisibility`(`src/vs/platform/window/common/window.ts`)를 `getMenuBarVisibility`가 해석하여 적용한다(`default`, 네이티브 메뉴를 사용하는 `compact`, macOS 네이티브 환경의 `classic`으로 변환되며, 그 외에는 설정값 `classic`/`visible`/`toggle`/`hidden`/`compact`를 그대로 사용한다. `compact`의 경우 `CustomMenubarControl`이 햄버거 형태의 압축 메뉴로 렌더링한다).

### 5.2 최상위 메뉴 목록 (이 커밋)

`menubar.contribution.ts`와 `src/vs/workbench/contrib/debug/browser/debug.contribution.ts`가 `MenuId.MenubarMainMenu`에 등록하는 항목 목록:

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

Run과 Terminal은 writing-room의 범위 밖이므로 어떤 최상위 메뉴를 채택할지는 [architecture.md](architecture.md)의 차이점 섹션에서 명시한다. 최상위 메뉴 구성이 하드코딩된 로직이 아니라 "메뉴 구조 + 순서" 데이터로 선언되어 있다는 점이 핵심 설계 특징이다.

### 5.3 확장은 최상위 메뉴를 기여할 수 없다

파일: `src/vs/workbench/services/actions/common/menusExtensionPoint.ts`

- `apiMenus: IAPIMenu[]`(`key`, `id: MenuId`, `description`, 선택적 `proposed`, `supportsSubmenus`)가 `menus` 기여 지점에서 허용하는 위치 키의 전체 목록이다. 이 커밋 기준으로 총 98개가 정의되어 있다.
- 이 목록에는 `MenuId.MenubarMainMenu`, `MenubarFileMenu`, `MenubarEditMenu`, `MenubarViewMenu`, `MenubarGoMenu`, `MenubarHelpMenu` 등에 직접 매핑되는 키가 존재하지 않는다. 메뉴 바 관련으로 허용된 키는 `menuBar/home`(`MenubarHomeMenu`, 제안 API `contribMenuBarHome`), `menuBar/edit/copy`(`MenubarCopy`), `file/newFile`(`NewFile`), `file/share`(`MenubarShare`, 제안 API `contribShareMenu`)뿐이다. 이는 모두 기존 메뉴 내부에 미리 지정된 하위 위치다.
- `menus` 확장 포인트 핸들러(`menusExtensionPoint.setHandler`)는 지정된 키가 `_apiMenusByKey`에도 없고 확장이 `submenus`로 직접 정의한 id에도 없으면 별도의 에러를 발생시키지 않고 `continue`로 건너뛴다. 즉 확장이 최상위 메뉴에 새 항목을 추가하려는 시도는 무시된다.
- `proposed` 플래그가 있는 키는 `isProposedApiEnabled`가 false인 경우 `collector.error`로 차단된다.
- `supportsSubmenus === false`로 지정된 키(`commandPalette`, `touchBar`, `file/newFile` 등)에는 서브메뉴 항목을 배치할 수 없다.
- 확장의 서브메뉴는 `submenus` 기여 지점을 통해 `MenuId.for('api:' + id)` 형태로 생성된다. `menus`에서 해당 id를 키로 지정하면 서브메뉴 내부에 하위 항목을 추가할 수 있다.
- 메뉴 항목이 참조하는 `command`는 `MenuRegistry.getCommand`로 조회되므로 반드시 `commands` 기여 지점(`commandsExtensionPoint`)에 먼저 선언되어 있어야 한다. 선언되지 않은 커맨드를 참조하면 `missing.command` 에러가 발생한다.
- `group` 속성은 `name@order` 형식을 파싱하여 처리한다. `when` 조건식은 `ContextKeyExpr.deserialize`로 파싱된다.

## 6. 키바인딩

### 6.1 레지스트리

파일: `src/vs/platform/keybinding/common/keybindingsRegistry.ts`

| 심볼 | 역할 |
|---|---|
| `KeybindingsRegistry` (`KeybindingsRegistryImpl`) | 전역 싱글톤 인스턴스. `registerKeybindingRule`, `registerCommandAndKeybindingRule`(커맨드 핸들러와 키바인딩을 함께 등록), `setExtensionKeybindings`, `getDefaultKeybindings`, `getDefaultKeybindingsForOS` 등의 메서드를 제공한다. |
| `IKeybindingRule` | `id`(커맨드), `weight`, `args`, `when`, `primary`, `secondary`, `win`/`linux`/`mac`. 플랫폼별 속성은 `bindToCurrentPlatform`이 현재 OS 환경에 맞춰 간소화한다. `primary`를 `decodeKeybinding`으로 디코딩한 결과가 `_coreKeybindings`에 보관된다. |
| `KeybindingWeight` | 우선순위 가중치 상수: `EditorCore` 0, `EditorContrib` 100, `WorkbenchContrib` 200, `SessionsContrib` 250, `BuiltinExtension` 300, `ExternalExtension` 400. |
| `getDefaultKeybindings()` | 코어 + 확장 키바인딩을 합쳐 `sorter`로 정렬. `sorter`는 `weight1`, 그다음 커맨드 id 문자열, 그다음 `weight2`. |

- 가중치(weight) 값이 클수록 배열의 뒤쪽에 배치되며, 배열의 뒤쪽에 위치할수록 우선권을 갖는다(6.2 참조). 확장 키바인딩의 가중치는 내장 확장의 경우 300 + 인덱스, 외부 확장은 400 + 인덱스로 부여된다(`src/vs/workbench/services/keybinding/browser/keybindingService.ts`의 `_asCommandRule`).
- `Action2.desc.keybinding` 선언은 `registerAction2`를 거쳐 이 레지스트리에 등록된다.

### 6.2 해석: `KeybindingResolver`

파일: `src/vs/platform/keybinding/common/keybindingResolver.ts`

| 심볼 | 역할 |
|---|---|
| 생성자 | 기본 키바인딩 규칙과 사용자 정의 `overrides`를 결합한 뒤 `handleRemovals`를 통해 `-commandId` 형태의 삭제 규칙을 반영한다. 첫 번째 코드(chord) 문자열을 기준으로 `_map`을, 커맨드명을 기준으로 `_lookupMap`을 구성한다. |
| `resolve(context, currentChords, keypress)` | 반환되는 `ResolutionResult`의 `kind`: `NoMatchingKb`, `MoreChordsNeeded`, `KbFound`(`commandId`, `commandArgs`, `isBubble`). 첫 코드로 매칭 후보를 검색하며 코드가 연속된 경우 이미 입력된 코드의 접두사를 비교 검증한다. |
| `_findCommand` | 후보 목록을 **역순(뒤에서부터)**으로 순회하여 `when` 조건이 참으로 평가되는 첫 번째 항목을 선택한다. 따라서 동일 키바인딩에 대해 가중치가 크거나 나중에 등록된 항목(사용자 설정 등)이 우선 적용된다. |
| `lookupKeybindings`, `lookupPrimaryKeybinding` | 커맨드 id로부터 단축키를 역방향 조회하는 메서드. 메뉴와 팔레트가 커맨드의 단축키를 표시할 때 사용한다. |
| `_addKeyPress`, `whenIsEntirelyIncluded` | 첫 코드별로 `_map`에 키바인딩 항목을 등록한다. 나중에 등록된 항목의 `when` 조건이 앞선 항목(다른 커맨드)의 `when` 조건을 완전히 포함하는 경우, 앞선 항목은 역조회용 `_lookupMap`에서만 제외된다. `_map`에는 그대로 유지되므로 실제 입력 해석 순서는 `_findCommand`의 역순 탐색 규칙이 결정한다. |
| `applyAliases` | `KeybindingsRegistry.getKeybindingAliases()`를 참조해 이전 id 별칭을 해석한다. |

### 6.3 디스패치와 코드

파일: `src/vs/platform/keybinding/common/abstractKeybindingService.ts`의 `AbstractKeybindingService`

| 심볼 | 역할 |
|---|---|
| `_dispatch` / `dispatchEvent` | 원시 키보드 이벤트를 `resolveKeyboardEvent`로 `ResolvedKeybinding`으로 변환한 뒤 `_doDispatch`를 호출한다. IME 조합 중(한글 입력 등)에는 입력을 무시한다. |
| `_doDispatch` | `_contextKeyService.getContext(target)`을 통해 포커스된 위치의 스코프 컨텍스트를 가져와 `_getResolver().resolve(...)`를 실행한다. 결과에 따른 분기: `NoMatchingKb`(코드 모드 진행 중이면 상태 표시줄에 "...is not a command" 안내를 띄우고 코드 모드 종료), `MoreChordsNeeded`(`_expectAnotherChord`로 후속 키 대기), `KbFound`(코드 모드 종료 후 `commandService.executeCommand` 실행). 반환값은 `preventDefault` 적용 여부이며 `isBubble`이 참이면 기본 동작을 차단하지 않는다. |
| `_currentChords`, `inChordMode` | 현재까지 입력된 코드 시퀀스 상태를 보관한다. |
| `_scheduleLeaveChordMode` | 500ms 간격으로 상태를 검사하여 문서가 포커스를 잃거나 5초가 경과하면 `_leaveChordMode`로 코드 모드를 취소한다. |
| 단일 모디파이어 코드(예: Shift 연타) | `_currentSingleModifier`와 300ms 타이머를 기반으로 하는 `_singleModifierDispatch` 경로로 처리한다. |
| `softDispatch` | 실제 커맨드 실행 없이 해석 결과만 미리 확인하는 용도로 사용된다. |

브라우저 환경 구현체: `src/vs/workbench/services/keybinding/browser/keybindingService.ts`

| 심볼 | 역할 |
|---|---|
| `WorkbenchKeybindingService` | `AbstractKeybindingService`의 구체 구현체. 파일 하단에서 `registerSingleton(IKeybindingService, WorkbenchKeybindingService, InstantiationType.Eager)`로 등록된다. |
| `_registerKeyListeners` | 각 `window`의 `keydown` 이벤트에서 `_dispatch(keyEvent, keyEvent.target)`를 호출하고, 결과가 참이면 `preventDefault`를 적용한다. 보조 창이 열릴 때도 동일하게 리스너를 바인딩한다(`dom.onDidRegisterWindow`). |
| `_getResolver` | `_cachedResolver`를 지연 생성한다: `KeybindingsRegistry.getDefaultKeybindings()`와 사용자 키바인딩을 `_keyboardMapper.resolveKeybinding`으로 해석해 `KeybindingResolver`에 전달한다. 키바인딩 변경 시 캐시를 무효화(null)하고 `onDidUpdateKeybindings` 이벤트를 발생시킨다. |
| `_keyboardMapper` | `IKeyboardLayoutService`(웹 환경에서는 `BrowserKeyboardLayoutService`, 동일 디렉터리 `keyboardLayoutService.ts`)가 제공하는 자판 배열별 매퍼. 동일한 물리 키가 키보드 레이아웃에 따라 다른 문자로 매핑되는 문제를 여기서 처리한다. |
| `UserKeybindings` | 사용자 프로필의 `keybindingsResource`(`keybindings.json`)를 `IFileService`를 통해 읽고 변경 사항을 파일 감시기로 추적한다. |
| `keybindingsExtPoint` | `extensionPoint: 'keybindings'`, `deps: [commandsExtensionPoint]`. `_handleKeybindingsExtensionPointUser` -> `_asCommandRule` 파이프라인을 통해 `key`, `mac`, `linux`, `win`, `command`, `args`, `when` 속성을 `IExtensionKeybindingRule`로 변환하여 `KeybindingsRegistry.setExtensionKeybindings`에 등록한다. |

## 7. 커맨드 팔레트

| 파일 | 심볼 | 역할 |
|---|---|---|
| `src/vs/platform/quickinput/common/quickInput.ts` | `IQuickInputService` | `pick`, `input`, `createQuickPick`, `createInputBox`, `quickAccess`, `focus`, `toggle`, `navigate`, `accept`, `cancel` 등 퀵 입력 서비스 계약. `IQuickPick`, `IInputBox`, `IQuickPickItem` 타입 정의 포함. |
| `src/vs/platform/quickinput/browser/quickInputService.ts` | `QuickInputService` | `createController`로 컨트롤러 인스턴스를 생성하고 `quickAccess`(`QuickAccessController`)를 지연 생성한다. 워크벤치 환경 등록은 `src/vs/workbench/services/quickinput/browser/quickInputService.ts`의 `registerSingleton(IQuickInputService, ...)`에서 수행된다. |
| `src/vs/platform/quickinput/browser/quickInputController.ts` | `QuickInputController` | DOM 위젯을 직접 관리하는 컨트롤러. `pick`, `input`, `createQuickPick`, `show`, `hide` 등을 담당한다. |
| `src/vs/platform/quickinput/browser/quickAccess.ts` | `QuickAccessController` | 입력된 접두사를 기준으로 알맞은 제공자(provider)를 선택한다. `show(value)`는 레지스트리(`Extensions.Quickaccess`)에서 접두사에 매칭되는 제공자를 찾아 피커에 바인딩한다. |
| `src/vs/platform/quickinput/browser/commandsQuickAccess.ts` | `AbstractCommandsQuickAccessProvider` | 접두사 `>`. `_getPicks`가 입력 필터링(`WORD_FILTER`, 필요 시 TF-IDF 관련 메타데이터 활용)과 최근 사용 기록(`CommandsHistory`, `StorageScope.PROFILE` 범위) 정렬을 수행한다. 항목을 선택하면(`accept`) `commandsHistory.push` 후 `commandService.executeCommand`를 호출하며, 실행 실패 시 `dialogService.error`를 표시한다. 구체 클래스는 `getCommandPicks`를 구현한다. |
| `src/vs/workbench/contrib/quickaccess/browser/commandsQuickAccess.ts` | `CommandsQuickAccessProvider` | `getCommandPicks` 구현체. `getCodeEditorCommandPicks()`(활성 에디터 액션)와 `getGlobalCommandPicks()`를 병합한다. 후자는 활성 에디터 페인 또는 활성 그룹의 스코프 컨텍스트를 사용해 `menuService.getMenuActions(MenuId.CommandPalette, ...)`를 호출한 뒤 `MenuItemAction`이면서 `enabled`인 항목만 필터링한다. 라벨에는 `category: title` 형식을 적용한다. |
| 동일 파일 | `ShowAllCommandsAction` | `workbench.action.showCommands`. `Action2`를 상속하며 단축키 `Ctrl/Cmd+Shift+P`(Firefox 제외)와 `F1`, `f1: true`를 선언한다. `run` 실행 시 `quickAccess.show(CommandsQuickAccessProvider.PREFIX)`를 호출한다. |
| `src/vs/workbench/contrib/quickaccess/browser/quickAccess.contribution.ts` | `quickAccessRegistry.registerQuickAccessProvider` | 제공자를 접두사와 컨텍스트 키(`inCommandsPicker`)로 등록하고 View 메뉴(`MenuId.MenubarViewMenu`)와 Help 메뉴에 팔레트 항목을 추가한다. |

요약: 커맨드 팔레트는 `MenuId.CommandPalette` 메뉴의 액션 목록을 렌더링하는 퀵 픽(Quick Pick) 인터페이스다. 특정 커맨드가 팔레트에 표시되는지 여부는 `Action2`의 `f1: true` 플래그, `precondition` 조건, 확장의 `commandPalette` 메뉴 `when` 절에 의해 결정된다.

## 8. 이 워크벤치에 주는 시사점

본 절은 사실 관계 요약이 아닌 아키텍처 관점의 제안 사항이다. 최종 확정 여부는 달라질 수 있으며 차이점은 [architecture.md](architecture.md)에 기록한다.

- 커맨드 id를 문자열 키로 관리하는 전역 레지스트리와 메뉴를 MenuId 단위로 관리하는 레지스트리를 분리하면 워크벤치 여섯 파트의 UI 요소를 일관된 규칙으로 구성할 수 있다.
- 키바인딩과 메뉴가 같은 `when` 평가기를 공유하므로 컨텍스트 키 서비스가 먼저 있어야 한다.
- 확장이 임의의 최상위 메뉴를 추가하지 못하도록 제한한 것은 VS Code의 명시적인 설계 방침이므로 writing-room 역시 동일한 제약을 적용하는 것이 적절하다.
- 키 입력 단계는 "키 이벤트에서 코드로, 코드에서 `resolve`, 그다음 `executeCommand`"로 분리돼 있어 단위 테스트가 쉽다.

Decided in: wr-e8v6
