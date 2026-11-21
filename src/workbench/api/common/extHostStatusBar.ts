import { extHostApiRegistry } from './extHostApiRegistry.js';
import { MainThreadStatusBarProxy } from './extHost.protocol.statusBar.js';
import type * as vscode from 'vscode';
import { StatusBarAlignment, ThemeColor, tooltipText } from './extHostTypes.js';
import type { MainThreadStatusBarShape, ThemeColorDto } from './extHost.protocol.js';

/** VS Code's `ALLOWED_BACKGROUND_COLORS`: the backgrounds an item may have, with the foreground each takes. */
const ALLOWED_BACKGROUND_COLORS: ReadonlyMap<string, string> = new Map([
  ['statusBarItem.errorBackground', 'statusBarItem.errorForeground'],
  ['statusBarItem.warningBackground', 'statusBarItem.warningForeground'],
]);

function themeColorId(value: unknown): string | undefined {
  return value instanceof ThemeColor || (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string')
    ? (value as { id: string }).id : undefined;
}

class Entry implements vscode.StatusBarItem {
  readonly #proxy: MainThreadStatusBarShape;
  readonly #remove: () => void;
  readonly #extension: string;
  /** The key the workbench knows this item by: unique per extension even when two items share an id. */
  readonly #key: string;
  readonly #explicitId: string | undefined;

  #visible = false;
  #scheduled = false;
  #disposed = false;
  #currentName: string | undefined;
  #currentText = '';
  #currentTooltip: vscode.StatusBarItem['tooltip'];
  #currentCommand: vscode.StatusBarItem['command'];
  #currentColor: vscode.StatusBarItem['color'];
  #currentBackgroundColor: vscode.StatusBarItem['backgroundColor'];
  #currentAccessibilityInformation: vscode.StatusBarItem['accessibilityInformation'];

  constructor(
    extension: string,
    key: string,
    explicitId: string | undefined,
    readonly alignment: StatusBarAlignment,
    readonly priority: number | undefined,
    proxy: MainThreadStatusBarShape,
    remove: () => void,
  ) {
    this.#extension = extension;
    this.#key = key;
    this.#explicitId = explicitId;
    this.#proxy = proxy;
    this.#remove = remove;
  }

  /** The id given to `createStatusBarItem`, or else the item's number in this host, as before ids could be given. */
  get id(): string { return this.#explicitId ?? this.#key; }
  get name(): string | undefined { return this.#currentName; }
  set name(value: string | undefined) { this.#currentName = value; this.#update(); }
  get text(): string { return this.#currentText; }
  set text(value: string) { this.#currentText = value; this.#update(); }
  get tooltip(): vscode.StatusBarItem['tooltip'] { return this.#currentTooltip; }
  set tooltip(value: vscode.StatusBarItem['tooltip']) { this.#currentTooltip = value; this.#update(); }
  get command(): vscode.StatusBarItem['command'] { return this.#currentCommand; }
  set command(value: vscode.StatusBarItem['command']) { this.#currentCommand = value; this.#update(); }
  get color(): vscode.StatusBarItem['color'] { return this.#currentColor; }
  set color(value: vscode.StatusBarItem['color']) { this.#currentColor = value; this.#update(); }
  get backgroundColor(): vscode.StatusBarItem['backgroundColor'] { return this.#currentBackgroundColor; }
  set backgroundColor(value: vscode.StatusBarItem['backgroundColor']) {
    // As in VS Code, a background other than the allowed ones is dropped when it is set.
    const id = themeColorId(value);
    this.#currentBackgroundColor = id !== undefined && ALLOWED_BACKGROUND_COLORS.has(id) ? value : undefined;
    this.#update();
  }
  get accessibilityInformation(): vscode.StatusBarItem['accessibilityInformation'] { return this.#currentAccessibilityInformation; }
  set accessibilityInformation(value: vscode.StatusBarItem['accessibilityInformation']) {
    this.#currentAccessibilityInformation = value;
    this.#update();
  }

  show(): void {
    if (!this.#disposed) {
      this.#visible = true;
      this.#update();
    }
  }

  hide(): void {
    if (this.#visible) {
      this.#visible = false;
      void this.#proxy.$disposeEntry(this.#extension, this.#key).catch(() => {});
    }
  }

  #colors(): { color?: string | ThemeColorDto; backgroundColor?: ThemeColorDto } {
    const backgroundId = themeColorId(this.#currentBackgroundColor);
    const foreground = backgroundId === undefined ? undefined : ALLOWED_BACKGROUND_COLORS.get(backgroundId);
    if (backgroundId !== undefined && foreground !== undefined) {
      // The text takes the foreground that goes with the background.
      return { color: { id: foreground }, backgroundColor: { id: backgroundId } };
    }
    const color = this.#currentColor;
    if (typeof color === 'string') {
      return { color };
    }
    const colorId = themeColorId(color);
    return colorId === undefined ? {} : { color: { id: colorId } };
  }

  #update(): void {
    if (!this.#visible || this.#scheduled || this.#disposed) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#visible || this.#disposed) {
        return;
      }
      const command = this.#currentCommand;
      const accessibility = this.#currentAccessibilityInformation;
      void this.#proxy.$setEntry(this.#extension, this.#key, {
        name: this.#currentName,
        id: this.#explicitId,
        text: this.#currentText,
        tooltip: tooltipText(this.#currentTooltip),
        command: command && (typeof command === 'string' ? command : { id: command.command, args: command.arguments }),
        alignment: this.alignment,
        priority: this.priority,
        ...this.#colors(),
        accessibilityInformation: accessibility && typeof accessibility.label === 'string'
          ? { label: accessibility.label, role: typeof accessibility.role === 'string' ? accessibility.role : undefined }
          : undefined,
      }).catch(error => { if (!this.#disposed) { console.error(error); } });
    });
  }

  dispose(): void {
    if (!this.#disposed) {
      this.hide();
      this.#disposed = true;
      this.#remove();
    }
  }
}

export class ExtHostStatusBar {
  private nextId = 0;
  private readonly entries = new Map<string, Set<Entry>>();

  constructor(private readonly proxy: MainThreadStatusBarShape) {}

  /** `createStatusBarItem(alignment?, priority?)` and `createStatusBarItem(id, alignment?, priority?)`. */
  createStatusBarItem(
    extension: string, idOrAlignment?: string | StatusBarAlignment, alignmentOrPriority?: StatusBarAlignment | number, priority?: number,
  ): vscode.StatusBarItem {
    let id: string | undefined;
    let alignment = StatusBarAlignment.Left;
    let itemPriority: number | undefined;
    if (typeof idOrAlignment === 'string') {
      id = idOrAlignment;
      alignment = alignmentOrPriority ?? StatusBarAlignment.Left;
      itemPriority = priority;
    } else {
      alignment = idOrAlignment ?? StatusBarAlignment.Left;
      itemPriority = alignmentOrPriority;
    }
    const entries = this.entries.get(extension) ?? new Set();
    this.entries.set(extension, entries);
    const entry = new Entry(extension, String(++this.nextId), id, alignment, itemPriority, this.proxy, () => entries.delete(entry));
    entries.add(entry);
    return Object.freeze(entry);
  }

  remove(extension: string): void {
    for (const entry of this.entries.get(extension) ?? []) {
      entry.dispose();
    }
    this.entries.delete(extension);
  }
}

extHostApiRegistry.register('statusBar', ({ rpc }) => {
  const status = new ExtHostStatusBar(rpc.getProxy(MainThreadStatusBarProxy));
  return {
    service: status,
    create: ({ key }) => ({
      types: { StatusBarAlignment },
      namespaces: {
        window: {
          createStatusBarItem: ((idOrAlignment?: string | StatusBarAlignment, alignmentOrPriority?: StatusBarAlignment | number, priority?: number) =>
            status.createStatusBarItem(key, idOrAlignment, alignmentOrPriority, priority)) as typeof vscode.window.createStatusBarItem,
        } satisfies Pick<typeof vscode.window, 'createStatusBarItem'>,
      },
    }),
    release: key => status.remove(key),
  };
});
