import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { Disposable as ApiDisposable, TextEdit } from './extHostTypes.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type { DocumentEdit } from './extHost.protocol.documents.js';

export class ExtHostDocumentSaveParticipant extends Disposable {
  private readonly listeners = new Set<{
    extension: string;
    callback: (event: vscode.TextDocumentWillSaveEvent) => unknown;
    failures: number;
  }>();

  event(extension: string): vscode.Event<vscode.TextDocumentWillSaveEvent> {
    return (listener, thisArg, disposables) => {
      const item = { extension, callback: listener.bind(thisArg), failures: 0 };
      this.listeners.add(item);
      const subscription = new ApiDisposable(() => this.listeners.delete(item));
      disposables?.push(subscription);
      return subscription;
    };
  }

  async participate(
    document: vscode.TextDocument,
    reason: vscode.TextDocumentSaveReason,
    deadline: number,
    token: CancellationToken,
    apply: (extension: string, version: number, edit: DocumentEdit) => Promise<boolean>,
  ): Promise<void> {
    for (const item of [...this.listeners]) {
      if (token.isCancellationRequested || Date.now() >= deadline || document.isClosed) {
        return;
      }
      if (!this.listeners.has(item)) {
        continue;
      }
      const version = document.version;
      const work: Promise<unknown>[] = [];
      let delivering = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancellation: { dispose(): void } | undefined;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          const expired = () => reject(new Error('Save participant timed out.'));
          timer = setTimeout(expired, Math.max(0, deadline - Date.now()));
          cancellation = token.onCancellationRequested(expired);
        });
        // Arm the rejection handler even when the listener throws before returning.
        void interrupted.catch(() => {});
        try {
          item.callback({
            document, reason,
            waitUntil(value: Thenable<unknown>) {
              if (!delivering) {
                throw new Error('waitUntil can only be called while delivering the save event.');
              }
              const promise = Promise.resolve(value);
              void promise.catch(() => {});
              work.push(promise);
            },
          });
        } finally {
          delivering = false;
        }
        const results = await Promise.race([Promise.all(work), interrupted]);
        if (Date.now() >= deadline || token.isCancellationRequested) {
          throw new Error('Save participant timed out.');
        }
        if (!this.listeners.has(item) || document.version !== version) {
          continue;
        }
        const edits = results.flatMap(value => Array.isArray(value) ? value.filter(edit => edit instanceof TextEdit) : []);
        if (edits.length) {
          const operations = edits.filter(edit => edit.newEol === undefined).map(edit => ({
            range: toModelRange(document.validateRange(edit.range)), text: edit.newText,
          }));
          const eol = edits.filter(edit => edit.newEol !== undefined).at(-1)?.newEol;
          await Promise.race([apply(item.extension, version, { operations, eol }), interrupted]);
        }
      } catch (error) {
        if (++item.failures >= 3) {
          this.listeners.delete(item);
        }
        console.warn(`[${item.extension}] Save participant failed:`, error);
      } finally {
        clearTimeout(timer);
        cancellation?.dispose();
      }
    }
  }

  override dispose(): void {
    this.listeners.clear();
    super.dispose();
  }
}
