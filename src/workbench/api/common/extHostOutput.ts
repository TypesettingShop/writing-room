import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { MainThreadOutputServiceProxy } from './extHost.protocol.windowUi.js';
import type { MainThreadOutputServiceShape } from './extHost.protocol.windowUi.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { LogLevel } from './extHostTypes.js';

/** Writes wait this long, or until this many code units are waiting, and then go together. */
export const OUTPUT_FLUSH_DELAY = 50;
export const OUTPUT_FLUSH_SIZE = 64 * 1024;
/** Matches the workbench's limit per channel: text older than this cannot be kept anyway. */
const CHANNEL_LIMIT = 1024 * 1024;

const levelNames: Partial<Record<LogLevel, string>> = {
  [LogLevel.Trace]: 'trace',
  [LogLevel.Debug]: 'debug',
  [LogLevel.Info]: 'info',
  [LogLevel.Warning]: 'warning',
  [LogLevel.Error]: 'error',
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** The local time as VS Code's log files write it: `2026-11-19 12:24:05.123`. */
export function logTimestamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** Joins a log message and its arguments as VS Code's logger does: errors by message, objects as JSON. */
export function formatLogArguments(args: readonly unknown[], verbose = false): string {
  let result = '';
  args.forEach((arg, index) => {
    let value = arg;
    if (value instanceof Error) {
      value = verbose && value.stack ? `${value.message}: ${value.stack}` : value.message;
    }
    if (typeof value === 'object') {
      try {
        value = JSON.stringify(value);
      } catch {
        // Kept as it is, like VS Code.
      }
    }
    result += (index > 0 ? ' ' : '') + String(value);
  });
  return result;
}

/**
 * One channel of an extension. Writes wait in the service and go to the workbench in order; `clear` and
 * `replace` drop the waiting writes they make moot.
 */
class OutputChannelState {
  disposed = false;
  /** Set when the extension disposed the channel itself; its methods then throw, as in VS Code. */
  closed = false;

  constructor(
    readonly handle: number,
    readonly extension: string,
    readonly name: string,
  ) {}
}

export class ExtHostOutputService {
  private readonly channels = new Map<string, Set<OutputChannelState>>();
  private readonly pending = new Map<OutputChannelState, string>();
  private pendingSize = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextHandle = 1;

  constructor(private readonly proxy: MainThreadOutputServiceShape) {}

  createOutputChannel(extension: string, name: string, options?: string | { log: true }): vscode.OutputChannel | vscode.LogOutputChannel {
    if (typeof name !== 'string') {
      throw new Error('illegal argument `name`. must not be falsy');
    }
    name = name.trim();
    if (!name) {
      throw new Error('illegal argument `name`. must not be falsy');
    }
    if (typeof options === 'string' && !options.trim()) {
      throw new Error('illegal argument `languageId`. must not be empty');
    }
    const log = typeof options === 'object' && options !== null && Boolean(options.log);
    const state = new OutputChannelState(this.nextHandle++, extension, name);
    let channels = this.channels.get(extension);
    if (!channels) {
      channels = new Set();
      this.channels.set(extension, channels);
    }
    channels.add(state);
    this.send(() => this.proxy.$register(extension, state.handle, name));
    return log ? this.createLogChannel(state) : this.createChannel(state);
  }

  private createChannel(state: OutputChannelState): vscode.OutputChannel {
    const validate = () => {
      if (state.closed) {
        throw new Error('Channel has been closed');
      }
    };
    return {
      get name() {
        return state.name;
      },
      append: (value: string) => {
        validate();
        this.write(state, formatLogArguments([value]));
      },
      appendLine: (value: string) => {
        validate();
        this.write(state, formatLogArguments([value]) + '\n');
      },
      replace: (value: string) => {
        validate();
        this.replace(state, formatLogArguments([value]));
      },
      clear: () => {
        validate();
        this.clear(state);
      },
      show: (columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean) => {
        validate();
        this.reveal(state, typeof columnOrPreserveFocus === 'boolean' ? columnOrPreserveFocus : preserveFocus === true);
      },
      hide: () => {
        validate();
        this.call(state, () => this.proxy.$close(state.extension, state.handle));
      },
      dispose: () => {
        state.closed = true;
        this.disposeChannel(state);
      },
    };
  }

  private createLogChannel(state: OutputChannelState): vscode.LogOutputChannel {
    const channel = this.createChannel(state);
    // There is no setting for it yet, so the level stays at its default and the event never fires.
    const level = { value: LogLevel.Info as LogLevel };
    const onDidChangeLogLevel = new Emitter<vscode.LogLevel>();
    const validate = () => {
      if (state.closed) {
        throw new Error('Channel has been closed');
      }
    };
    const log = (messageLevel: LogLevel, message: string) => {
      validate();
      if (level.value !== LogLevel.Off && level.value <= messageLevel) {
        this.write(state, `${logTimestamp()} [${levelNames[messageLevel]}] ${message}\n`);
      }
    };
    // A log channel writes everything as log lines, `append` and `appendLine` at the info level.
    return {
      get name() {
        return state.name;
      },
      get logLevel() {
        return level.value as unknown as vscode.LogLevel;
      },
      onDidChangeLogLevel: onDidChangeLogLevel.event,
      append: (value: string) => log(LogLevel.Info, formatLogArguments([value])),
      appendLine: (value: string) => log(LogLevel.Info, formatLogArguments([value])),
      replace: (value: string) => {
        validate();
        this.replace(state, '');
        log(LogLevel.Info, formatLogArguments([value]));
      },
      clear: channel.clear,
      show: channel.show,
      hide: channel.hide,
      trace: (message: string, ...args: unknown[]) => log(LogLevel.Trace, formatLogArguments([message, ...args], true)),
      debug: (message: string, ...args: unknown[]) => log(LogLevel.Debug, formatLogArguments([message, ...args])),
      info: (message: string, ...args: unknown[]) => log(LogLevel.Info, formatLogArguments([message, ...args])),
      warn: (message: string, ...args: unknown[]) => log(LogLevel.Warning, formatLogArguments([message, ...args])),
      error: (error: string | Error, ...args: unknown[]) => log(LogLevel.Error, error instanceof Error
        ? formatLogArguments([error.stack ?? error.message, ...args])
        : formatLogArguments([error, ...args])),
      dispose: () => {
        channel.dispose();
        onDidChangeLogLevel.dispose();
      },
    };
  }

  private write(state: OutputChannelState, text: string): void {
    if (state.disposed || !text) {
      return;
    }
    let waiting = (this.pending.get(state) ?? '') + text;
    this.pendingSize += text.length;
    if (waiting.length > CHANNEL_LIMIT * 2) {
      // Only the end can stay in the channel; the workbench keeps the same lines from it.
      this.pendingSize -= waiting.length - (CHANNEL_LIMIT + 1);
      waiting = waiting.slice(waiting.length - (CHANNEL_LIMIT + 1));
    }
    this.pending.set(state, waiting);
    if (this.pendingSize >= OUTPUT_FLUSH_SIZE) {
      this.flushAll();
    } else {
      this.timer ??= setTimeout(() => this.flushAll(), OUTPUT_FLUSH_DELAY);
    }
  }

  private replace(state: OutputChannelState, text: string): void {
    if (!state.disposed) {
      this.drop(state);
      this.send(() => this.proxy.$replace(state.extension, state.handle, text.slice(-(CHANNEL_LIMIT + 1))));
    }
  }

  private clear(state: OutputChannelState): void {
    if (!state.disposed) {
      this.drop(state);
      this.send(() => this.proxy.$clear(state.extension, state.handle));
    }
  }

  private reveal(state: OutputChannelState, preserveFocus: boolean): void {
    this.call(state, () => this.proxy.$reveal(state.extension, state.handle, preserveFocus));
  }

  /** Sends the channel's waiting writes, then the call. */
  private call(state: OutputChannelState, call: () => Promise<void>): void {
    if (!state.disposed) {
      this.flushChannel(state);
      this.send(call);
    }
  }

  private disposeChannel(state: OutputChannelState): void {
    if (!state.disposed) {
      this.drop(state);
      state.disposed = true;
      this.channels.get(state.extension)?.delete(state);
      this.send(() => this.proxy.$dispose(state.extension, state.handle));
    }
  }

  private drop(state: OutputChannelState): void {
    const waiting = this.pending.get(state);
    if (waiting !== undefined) {
      this.pending.delete(state);
      this.pendingSize -= waiting.length;
    }
  }

  private flushChannel(state: OutputChannelState): void {
    const waiting = this.pending.get(state);
    if (waiting !== undefined) {
      this.drop(state);
      this.send(() => this.proxy.$append(state.extension, state.handle, waiting));
    }
  }

  /** Sends every waiting write. */
  flushAll(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const state of [...this.pending.keys()]) {
      this.flushChannel(state);
    }
  }

  /** Sends the waiting writes of one extension, as its activation finishes. */
  flush(extension: string): void {
    for (const state of this.channels.get(extension) ?? []) {
      this.flushChannel(state);
    }
  }

  private send(call: () => Promise<void>): void {
    call().catch(() => {});
  }

  /** Disposes the channels of an extension that was deactivated or removed; later writes to them do nothing. */
  release(extension: string): void {
    for (const state of [...this.channels.get(extension) ?? []]) {
      this.disposeChannel(state);
    }
    this.channels.delete(extension);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.clear();
    this.pendingSize = 0;
    for (const extension of [...this.channels.keys()]) {
      this.release(extension);
    }
  }
}

extHostApiRegistry.register('output', ({ rpc }) => {
  const output = new ExtHostOutputService(rpc.getProxy(MainThreadOutputServiceProxy));
  return {
    service: output,
    create: ({ key }) => ({
      namespaces: {
        window: {
          createOutputChannel: ((name: string, options?: string | { log: true }) =>
            output.createOutputChannel(key, name, options)) as typeof vscode.window.createOutputChannel,
        } satisfies Pick<typeof vscode.window, 'createOutputChannel'>,
      },
    }),
    flush: async key => output.flush(key),
    release: key => output.release(key),
    dispose: () => output.dispose(),
  };
});
