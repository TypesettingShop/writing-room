declare module 'vscode' {
  // Color themes, contributed colors, the active color theme and status bar colors (wr-mk2j.2j5, wr-mk2j.2xb).

  interface AccessibilityInformation {
    readonly label: string;
    readonly role?: string;
  }

  enum ColorThemeKind {
    Light = 1,
    Dark = 2,
    HighContrast = 3,
    HighContrastLight = 4
  }

  interface ColorTheme {
    readonly kind: ColorThemeKind;
  }

  interface StatusBarItem {
    color: string | ThemeColor | undefined;
    backgroundColor: ThemeColor | undefined;
    accessibilityInformation: AccessibilityInformation | undefined;
  }

  namespace window {
    let activeColorTheme: ColorTheme;
    const onDidChangeActiveColorTheme: Event<ColorTheme>;
    function createStatusBarItem(id: string, alignment?: StatusBarAlignment, priority?: number): StatusBarItem;
  }
}

declare module 'vscode' {
  // Tree views: item icons, check boxes, selection, reveal, titles, drag and drop (wr-mk2j.uak).

  interface TreeItem {
    iconPath?: string | IconPath;
    resourceUri?: Uri;
    accessibilityInformation?: AccessibilityInformation;
    checkboxState?: TreeItemCheckboxState | {
      readonly state: TreeItemCheckboxState;
      readonly tooltip?: string;
      readonly accessibilityInformation?: AccessibilityInformation;
    };
  }

  enum TreeItemCheckboxState {
    Unchecked = 0,
    Checked = 1
  }

  interface TreeDataProvider<T> {
    getParent?(element: T): ProviderResult<T>;
    resolveTreeItem?(item: TreeItem, element: T, token: CancellationToken): ProviderResult<TreeItem>;
  }

  interface TreeViewOptions<T> {
    showCollapseAll?: boolean;
    canSelectMany?: boolean;
    dragAndDropController?: TreeDragAndDropController<T>;
    manageCheckboxStateManually?: boolean;
  }

  interface TreeViewExpansionEvent<T> {
    readonly element: T;
  }

  interface TreeViewSelectionChangeEvent<T> {
    readonly selection: readonly T[];
  }

  interface TreeViewVisibilityChangeEvent {
    readonly visible: boolean;
  }

  interface TreeDragAndDropController<T> {
    readonly dropMimeTypes: readonly string[];
    readonly dragMimeTypes: readonly string[];
    handleDrag?(source: readonly T[], dataTransfer: DataTransfer, token: CancellationToken): Thenable<void> | void;
    handleDrop?(target: T | undefined, dataTransfer: DataTransfer, token: CancellationToken): Thenable<void> | void;
  }

  interface ViewBadge {
    readonly tooltip: string;
    readonly value: number;
  }

  interface TreeCheckboxChangeEvent<T> {
    readonly items: ReadonlyArray<[T, TreeItemCheckboxState]>;
  }

  interface TreeView<T> {
    readonly onDidExpandElement: Event<TreeViewExpansionEvent<T>>;
    readonly onDidCollapseElement: Event<TreeViewExpansionEvent<T>>;
    readonly selection: readonly T[];
    readonly onDidChangeSelection: Event<TreeViewSelectionChangeEvent<T>>;
    readonly visible: boolean;
    readonly onDidChangeVisibility: Event<TreeViewVisibilityChangeEvent>;
    readonly onDidChangeCheckboxState: Event<TreeCheckboxChangeEvent<T>>;
    message?: string;
    title?: string;
    description?: string;
    badge?: ViewBadge | undefined;
    reveal(element: T, options?: {
      readonly select?: boolean;
      readonly focus?: boolean;
      readonly expand?: boolean | number;
    }): Thenable<void>;
  }
}
