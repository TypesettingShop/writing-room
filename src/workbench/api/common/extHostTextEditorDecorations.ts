import type * as vscode from 'vscode';
import { Range } from './extHostTypes.js';
import { decorationRangeLimit, toModelRange } from './extHost.protocol.documents.js';
import type { MainThreadDecorationsShape } from './extHost.protocol.documents.js';

export enum OverviewRulerLane { Left = 1, Center = 2, Right = 4, Full = 7 }
export enum DecorationRangeBehavior { OpenOpen, ClosedClosed, OpenClosed, ClosedOpen }

export class ExtHostTextEditorDecorations {
  private readonly registered = new Map<vscode.TextEditorDecorationType, string>();
  private sequence = 0;

  constructor(private readonly proxy: MainThreadDecorationsShape) {}

  create(extension: string, options: vscode.DecorationRenderOptions): vscode.TextEditorDecorationType {
    const key = 'decoration-' + ++this.sequence;
    const type = Object.freeze({ key, dispose: () => this.remove(type) });
    this.registered.set(type, extension);
    void this.proxy.$registerDecoration(extension, key, options).catch(error => {
      this.registered.delete(type);
      console.warn('Unable to register text editor decoration:', error);
    });
    return type;
  }

  set(editor: string, type: vscode.TextEditorDecorationType, ranges: readonly (vscode.Range | vscode.DecorationOptions)[]): void {
    const extension = this.registered.get(type);
    if (!extension) {
      return;
    }
    const entries = ranges.slice(0, decorationRangeLimit).map(entry => {
      if (entry instanceof Range) {
        return { range: toModelRange(entry) };
      }
      const { range, hoverMessage, renderOptions } = entry as vscode.DecorationOptions;
      const hover = hoverMessage === undefined ? undefined : (Array.isArray(hoverMessage) ? hoverMessage : [hoverMessage])
        .map(message => typeof message === 'string' ? message
          : 'language' in message ? '\n```' + message.language.replace(/[^\w-]/g, '') + '\n' + message.value + '\n```'
            : message.value);
      return { range: toModelRange(range), hover, render: renderOptions };
    });
    void this.proxy.$setDecorations(extension, editor, type.key, entries, ranges.length > decorationRangeLimit).catch(() => {});
  }

  private remove(type: vscode.TextEditorDecorationType): void {
    const key = this.registered.get(type);
    if (key !== undefined) {
      this.registered.delete(type);
      void this.proxy.$removeDecoration(key, type.key).catch(() => {});
    }
  }

  release(extension: string): void {
    for (const [type, key] of this.registered) {
      if (key === extension) {
        this.remove(type);
      }
    }
  }

  dispose(): void {
    this.registered.clear();
  }
}
