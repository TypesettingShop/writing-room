import { extHostApiRegistry } from './extHostApiRegistry.js';
import { MainThreadStatusBarProxy } from './extHost.protocol.statusBar.js';
import type * as vscode from 'vscode';
import { StatusBarAlignment, tooltipText } from './extHostTypes.js';
import type { MainThreadStatusBarShape } from './extHost.protocol.js';

class Entry implements vscode.StatusBarItem {
  readonly #proxy: MainThreadStatusBarShape;
  readonly #remove: () => void;
  readonly #extension: string;

  #visible = false;
  #scheduled = false;
  #disposed = false;
  #currentName: string | undefined;
  #currentText = '';
  #currentTooltip: vscode.StatusBarItem['tooltip'];
  #currentCommand: vscode.StatusBarItem['command'];

  constructor(
    extension: string,
    readonly id: string,
    readonly alignment: StatusBarAlignment,
    readonly priority: number | undefined,
    proxy: MainThreadStatusBarShape,
    remove: () => void,
  ) {
    this.#extension = extension;
    this.#proxy = proxy;
    this.#remove = remove;
  }

  get name(): string | undefined { return this.#currentName; }
  set name(value: string | undefined) { this.#currentName = value; this.#update(); }
  get text(): string { return this.#currentText; }
  set text(value: string) { this.#currentText = value; this.#update(); }
  get tooltip(): vscode.StatusBarItem['tooltip'] { return this.#currentTooltip; }
  set tooltip(value: vscode.StatusBarItem['tooltip']) { this.#currentTooltip = value; this.#update(); }
  get command(): vscode.StatusBarItem['command'] { return this.#currentCommand; }
  set command(value: vscode.StatusBarItem['command']) { this.#currentCommand = value; this.#update(); }

  show(): void {
    if (!this.#disposed) {
      this.#visible = true;
      this.#update();
    }
  }

  hide(): void {
    if (this.#visible) {
      this.#visible = false;
      void this.#proxy.$disposeEntry(this.#extension, this.id).catch(() => {});
    }
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
      void this.#proxy.$setEntry(this.#extension, this.id, {
        name: this.#currentName,
        text: this.#currentText,
        tooltip: tooltipText(this.#currentTooltip),
        command: command && (typeof command === 'string' ? command : { id: command.command, args: command.arguments }),
        alignment: this.alignment,
        priority: this.priority,
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

  createStatusBarItem(extension: string, alignment = StatusBarAlignment.Left, priority?: number): vscode.StatusBarItem {
    const entries = this.entries.get(extension) ?? new Set();
    this.entries.set(extension, entries);
    const entry = new Entry(extension, String(++this.nextId), alignment, priority, this.proxy, () => entries.delete(entry));
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
          createStatusBarItem: (alignment, priority) => status.createStatusBarItem(key, alignment, priority),
        } satisfies Pick<typeof vscode.window, 'createStatusBarItem'>,
      },
    }),
    release: key => status.remove(key),
  };
});
