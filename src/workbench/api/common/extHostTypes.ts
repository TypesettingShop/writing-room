import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { dispose, toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';

export class Disposable {
  readonly #entry: IDisposable;

  constructor(callOnDispose: () => unknown) {
    this.#entry = toDisposable(callOnDispose);
  }

  static from(...disposables: IDisposable[]): Disposable {
    return new Disposable(() => dispose(disposables));
  }

  dispose(): void {
    this.#entry.dispose();
  }
}

export class EventEmitter<T> {
  readonly #emitter = new Emitter<T>();
  event = this.#emitter.event;

  fire(data: T): void {
    this.#emitter.fire(data);
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum StatusBarAlignment { Left = 1, Right = 2 }

export class TreeItem {
  id?: string;
  description?: vscode.TreeItem['description'];
  tooltip?: vscode.TreeItem['tooltip'];
  command?: vscode.Command;
  contextValue?: string;

  constructor(
    public label?: vscode.TreeItem['label'],
    public collapsibleState?: TreeItemCollapsibleState,
  ) {}
}

export function tooltipText(value: string | vscode.MarkdownString | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.value;
}
