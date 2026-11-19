import type * as vscode from 'vscode';
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { ExtHostProgressProxy, MainThreadProgressProxy } from './extHost.protocol.windowUi.js';
import type { ExtHostProgressShape, MainThreadProgressShape, ProgressOptionsDto, ProgressStepDto } from './extHost.protocol.windowUi.js';
import { extHostApiRegistry, promiseApiMethod } from './extHostApiRegistry.js';
import { Disposable } from './extHostTypes.js';

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

/** Reports go out at most once per interval; what came in between is merged, and the last one always goes. */
export const progressReportInterval = 100;

class ThrottledReporter {
  private pending: { message?: string; increment: number } | undefined;
  private last = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ended = false;

  constructor(private readonly send: (step: ProgressStepDto) => void) {}

  report(value: { message?: string; increment?: number } | undefined): void {
    if (this.ended || !value || typeof value !== 'object') {
      return;
    }
    const message = typeof value.message === 'string' ? value.message : undefined;
    const increment = typeof value.increment === 'number' && Number.isFinite(value.increment) && value.increment > 0
      ? value.increment : 0;
    if (message === undefined && !increment) {
      return;
    }
    this.pending = {
      message: message ?? this.pending?.message,
      increment: (this.pending?.increment ?? 0) + increment,
    };
    const wait = this.last + progressReportInterval - Date.now();
    if (wait <= 0) {
      this.flush();
    } else {
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
    }
  }

  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const step = this.pending;
    if (step) {
      this.pending = undefined;
      this.last = Date.now();
      this.send({ ...step.message !== undefined ? { message: step.message } : {}, ...step.increment ? { increment: step.increment } : {} });
    }
  }

  end(): void {
    this.flush();
    this.ended = true;
  }
}

/** `window.withProgress` and `window.setStatusBarMessage`. */
export class ExtHostProgress implements ExtHostProgressShape {
  private nextHandle = 0;
  private nextMessage = 0;
  private readonly cancellations = new Map<number, CancellationTokenSource>();
  private readonly running = new Map<string, Set<number>>();
  private readonly messages = new Map<string, Set<vscode.Disposable>>();

  constructor(private readonly proxy: MainThreadProgressShape) {}

  async withProgress<R>(
    extension: string, options: vscode.ProgressOptions,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<R>,
  ): Promise<R> {
    if (!options || typeof options !== 'object') {
      throw new Error('Expected progress options.');
    }
    if (typeof task !== 'function') {
      throw new Error('Expected a progress task.');
    }
    const location = options.location;
    const dto: ProgressOptionsDto = {
      location: typeof location === 'number' ? location
        : location && typeof location === 'object' && typeof location.viewId === 'string' ? { viewId: location.viewId } : ProgressLocation.Window,
      title: typeof options.title === 'string' ? options.title : undefined,
      cancellable: options.cancellable === true,
    };
    const handle = ++this.nextHandle;
    const source = new CancellationTokenSource();
    const running = this.running.get(extension) ?? new Set();
    this.running.set(extension, running);
    running.add(handle);
    if (dto.cancellable) {
      this.cancellations.set(handle, source);
    }
    const ignore = () => {};
    this.proxy.$startProgress(extension, handle, dto).catch(ignore);
    const reporter = new ThrottledReporter(step => { this.proxy.$progressReport(extension, handle, step).catch(ignore); });
    const progress: vscode.Progress<{ message?: string; increment?: number }> = Object.freeze({
      report: (value: { message?: string; increment?: number }) => reporter.report(value),
    });
    try {
      return await task(progress, source.token);
    } finally {
      // Thrown or returned, the last report shows and then the progress goes away.
      reporter.end();
      this.proxy.$progressEnd(extension, handle).catch(ignore);
      this.cancellations.delete(handle);
      running.delete(handle);
      source.dispose();
    }
  }

  async $acceptProgressCanceled(handle: number): Promise<void> {
    // The task decides when to stop; the progress stays until it does.
    this.cancellations.get(handle)?.cancel();
    this.cancellations.delete(handle);
  }

  setStatusBarMessage(extension: string, text: string, hide?: number | Thenable<unknown>): vscode.Disposable {
    const id = ++this.nextMessage;
    const set = this.messages.get(extension) ?? new Set();
    this.messages.set(extension, set);
    let disposed = false;
    const message = new Disposable(() => {
      if (!disposed) {
        disposed = true;
        set.delete(message);
        this.proxy.$disposeStatusBarMessage(extension, id).catch(() => {});
      }
    });
    set.add(message);
    this.proxy.$setStatusBarMessage(extension, id, typeof text === 'string' ? text : String(text ?? '')).catch(() => {});
    if (typeof hide === 'number') {
      setTimeout(() => message.dispose(), Math.max(0, hide));
    } else if (hide && typeof (hide as Thenable<unknown>).then === 'function') {
      (hide as Thenable<unknown>).then(() => message.dispose(), () => message.dispose());
    }
    return message;
  }

  /** Cancels the running progress of an extension that was deactivated or removed, and drops its messages. */
  release(extension: string): void {
    for (const handle of this.running.get(extension) ?? []) {
      this.cancellations.get(handle)?.cancel();
      this.cancellations.delete(handle);
    }
    this.running.delete(extension);
    for (const message of [...this.messages.get(extension) ?? []]) {
      message.dispose();
    }
    this.messages.delete(extension);
  }

  dispose(): void {
    for (const extension of [...new Set([...this.running.keys(), ...this.messages.keys()])]) {
      this.release(extension);
    }
  }
}

extHostApiRegistry.register('progress', ({ rpc }) => {
  const progress = new ExtHostProgress(rpc.getProxy(MainThreadProgressProxy));
  rpc.set(ExtHostProgressProxy, progress);
  return {
    service: progress,
    create: ({ key }) => ({
      types: { ProgressLocation },
      namespaces: {
        window: {
          withProgress: promiseApiMethod(<R>(options: vscode.ProgressOptions, task: Parameters<typeof vscode.window.withProgress<R>>[1]) =>
            progress.withProgress<R>(key, options, task)),
          setStatusBarMessage: (text: string, hide?: number | Thenable<unknown>) => progress.setStatusBarMessage(key, text, hide),
        } satisfies Pick<typeof vscode.window, 'withProgress' | 'setStatusBarMessage'>,
      },
    }),
    release: key => progress.release(key),
    dispose: () => progress.dispose(),
  };
});
