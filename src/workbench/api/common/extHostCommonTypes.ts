import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';

export const Uri = URI as unknown as typeof vscode.Uri;
export type Uri = vscode.Uri;

export class MarkdownString implements vscode.MarkdownString {
  isTrusted?: vscode.MarkdownString['isTrusted'];
  supportHtml?: boolean;
  baseUri?: vscode.Uri;

  constructor(public value = '', public supportThemeIcons: boolean | undefined = false) {}

  appendText(value: string): this {
    const backtick = String.fromCharCode(96);
    const escapedIcons = this.supportThemeIcons ? value.replace(/(?<!\\)\$\([\w-]+(?:~[\w-]+)?\)/g, '\\$&') : value;
    this.value += escapedIcons.replace(/[\\*_{}[\]()#+!~]/g, '\\$&')
      .replaceAll(backtick, '\\' + backtick)
      .replace(/^([ \t]*)-/gm, '$1\\-')
      .replace(/[ \t]+/g, spaces => '&nbsp;'.repeat(spaces.length))
      .replace(/>/g, '\\>')
      .replace(/\n/g, '\n\n');
    return this;
  }

  appendMarkdown(value: string): this {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language = ''): this {
    const backtick = String.fromCharCode(96);
    const fencePattern = new RegExp('^ {0,3}' + backtick + '+', 'gm');
    let length = 3;
    for (const match of value.matchAll(fencePattern)) {
      length = Math.max(length, match[0].trimStart().length + 1);
    }
    const fence = backtick.repeat(length);
    this.value += '\n' + fence + language + '\n' + value + '\n' + fence + '\n';
    return this;
  }
}

export class ThemeColor implements vscode.ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon implements vscode.ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');

  constructor(readonly id: string, readonly color?: ThemeColor) {}
}

export class RelativePattern implements vscode.RelativePattern {
  declare base: string;
  declare baseUri: vscode.Uri;

  constructor(base: vscode.WorkspaceFolder | vscode.Uri | string, public pattern: string) {
    if (typeof base !== 'string' && !URI.isUri(base) && !URI.isUri((base as vscode.WorkspaceFolder | undefined)?.uri)) {
      throw new Error('Illegal argument: base');
    }
    if (typeof pattern !== 'string') {
      throw new Error('Illegal argument: pattern');
    }
    let baseUri: vscode.Uri;
    let basePath: string;
    // RPC copies own enumerable fields and revives URI values in those fields.
    Object.defineProperties(this, {
      base: {
        enumerable: true,
        get: () => basePath,
        set: (path: string) => {
          baseUri = Uri.file(path);
          basePath = path;
        },
      },
      baseUri: {
        enumerable: true,
        get: () => baseUri,
        set: (resource: vscode.Uri) => {
          baseUri = resource;
          basePath = resource.fsPath;
        },
      },
    });
    const initialUri = typeof base === 'string' ? Uri.file(base)
      : URI.isUri(base) ? base as unknown as vscode.Uri : (base as vscode.WorkspaceFolder).uri;
    this.baseUri = initialUri;
  }
}

export class CodeActionKind implements vscode.CodeActionKind {
  static readonly Empty = new CodeActionKind('');
  static readonly QuickFix = CodeActionKind.Empty.append('quickfix');
  static readonly Refactor = CodeActionKind.Empty.append('refactor');
  static readonly RefactorExtract = CodeActionKind.Refactor.append('extract');
  static readonly RefactorInline = CodeActionKind.Refactor.append('inline');
  static readonly RefactorMove = CodeActionKind.Refactor.append('move');
  static readonly RefactorRewrite = CodeActionKind.Refactor.append('rewrite');
  static readonly Source = CodeActionKind.Empty.append('source');
  static readonly SourceOrganizeImports = CodeActionKind.Source.append('organizeImports');
  static readonly SourceFixAll = CodeActionKind.Source.append('fixAll');
  static readonly Notebook = CodeActionKind.Empty.append('notebook');

  private constructor(readonly value: string) {}

  append(parts: string): CodeActionKind {
    const prefix = this.value ? this.value + '.' : '';
    return new CodeActionKind(prefix + parts);
  }

  contains(other: CodeActionKind): boolean {
    const path = other.value;
    return path === this.value || path.startsWith(this.value + '.');
  }

  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this);
  }
}

export enum LogLevel { Off = 0, Trace = 1, Debug = 2, Info = 3, Warning = 4, Error = 5 }

export class DataTransferItem implements vscode.DataTransferItem {
  constructor(readonly value: any) {}

  async asString(): Promise<string> {
    return typeof this.value === 'string' ? this.value : JSON.stringify(this.value);
  }

  asFile(): vscode.DataTransferFile | undefined { return undefined; }
}

export class DataTransfer implements vscode.DataTransfer {
  readonly #items = new Map<string, vscode.DataTransferItem[]>();

  constructor(init?: Iterable<readonly [string, vscode.DataTransferItem]>) {
    for (const [mimeType, item] of init ?? []) {
      const key = mimeType.toLowerCase();
      const existing = this.#items.get(key);
      if (existing) {
        existing.push(item);
      } else {
        this.#items.set(key, [item]);
      }
    }
  }

  get(mimeType: string): vscode.DataTransferItem | undefined {
    return this.#items.get(mimeType.toLowerCase())?.[0];
  }

  set(mimeType: string, value: vscode.DataTransferItem): void {
    this.#items.set(mimeType.toLowerCase(), [value]);
  }

  forEach(callbackfn: (item: vscode.DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void, thisArg?: unknown): void {
    for (const [mimeType, items] of this.#items) {
      for (const item of items) {
        callbackfn.call(thisArg, item, mimeType, this);
      }
    }
  }

  *[Symbol.iterator](): IterableIterator<[string, vscode.DataTransferItem]> {
    for (const [mimeType, items] of this.#items) {
      for (const item of items) {
        yield [mimeType, item];
      }
    }
  }
}
