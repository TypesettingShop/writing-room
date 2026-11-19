import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { asCssVariableName, ColorScheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { loadWebviewResource } from './resourceLoading.js';
import { isWebviewState } from './webviewStateStore.js';
import type { WebviewOrigin } from '../common/webviewOrigin.js';

export interface WebviewElementOptions {
  readonly enableScripts?: boolean;
  readonly enableForms?: boolean;
  readonly localResourceRoots?: readonly URI[];
}

interface PendingMessage {
  readonly value: unknown;
  readonly resolve: (accepted: boolean) => void;
}

interface QueuedRead {
  readonly id: number;
  readonly path: string;
}

const shellTimeout = 10_000;
const concurrentReads = 16;
const queuedReadLimit = 1024;

function sameRoots(first: readonly URI[] | undefined, second: readonly URI[] | undefined): boolean {
  return first === second || (!!first && !!second && first.length === second.length
    && first.every((root, index) => root.toString() === second[index].toString()));
}

export class WebviewElement extends Disposable {
  private readonly contentReady = this._register(new Emitter<void>());
  readonly onDidLoadContent = this.contentReady.event;
  private readonly messages = this._register(new Emitter<unknown>());
  readonly onDidReceiveMessage = this.messages.event;
  private readonly contextMenus = this._register(new Emitter<{ x: number; y: number; context: unknown }>());
  readonly onDidRequestContextMenu = this.contextMenus.event;
  private readonly stateChanges = this._register(new Emitter<string>());
  readonly onDidChangeState = this.stateChanges.event;

  readonly container: HTMLElement;
  private readonly frame: HTMLIFrameElement | undefined;
  private readonly window: Window;
  private readonly pending = new Map<number, PendingMessage>();
  private readonly reads = new Map<number, AbortController>();
  /** A page asks for its resources at once; reads past the concurrent limit wait here instead of failing. */
  private readonly queuedReads: QueuedRead[] = [];
  private readonly readyTimeout: number | undefined;
  private port: MessagePort | undefined;
  private disposed = false;
  private ready = false;
  private loaded = false;
  private revision = 0;
  private sequence = 0;
  private html = '';
  private options: WebviewElementOptions = {};
  private state: string | undefined;

  constructor(
    private readonly document: Document, origin: WebviewOrigin, private readonly files: IFileService,
    private readonly opener: IOpenerService, private readonly theme: IThemeService,
  ) {
    super();
    this.window = document.defaultView!;
    this.container = document.createElement('div');
    this.container.className = 'webview-element';
    this.container.style.cssText = 'width:100%;height:100%;overflow:hidden';
    if ('error' in origin) {
      this.showError(origin.error);
      return;
    }

    const source = new URL('/webview/index.html', origin.origin);
    if (source.origin === this.window.location.origin || !['http:', 'https:'].includes(source.protocol)) {
      this.showError('Webviews need an origin separate from the workbench.');
      return;
    }
    const token = crypto.randomUUID();
    source.searchParams.set('parentOrigin', this.window.location.origin);
    source.searchParams.set('id', crypto.randomUUID());
    source.hash = token;
    const frame = this.frame = document.createElement('iframe');
    frame.title = 'Webview';
    frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
    frame.referrerPolicy = 'no-referrer';
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
    const connect = (event: MessageEvent) => {
      if (!event.isTrusted || this.port || event.source !== frame.contentWindow || event.origin !== source.origin
        || event.data?.type !== 'connect' || event.data.token !== token) {
        return;
      }
      const { port1, port2 } = new MessageChannel();
      this.port = port1;
      port1.onmessage = event => this.receive(event.data);
      frame.contentWindow?.postMessage({ type: 'attach', token }, source.origin, [port2]);
    };
    this.window.addEventListener('message', connect);
    this._register(toDisposable(() => this.window.removeEventListener('message', connect)));
    this._register(theme.onDidColorThemeChange(() => this.sendTheme()));
    frame.src = source.href;
    this.container.append(frame);
    this.readyTimeout = this.window.setTimeout(() => {
      if (!this.ready) {
        this.showError('The Webview shell did not start. Open its address in a new tab, then reopen the Webview.', source);
      }
    }, shellTimeout);
  }

  setContent(html: string, options: WebviewElementOptions): void {
    const reload = this.html !== html || this.options.enableScripts !== options.enableScripts
      || this.options.enableForms !== options.enableForms;
    this.html = html;
    if (!sameRoots(this.options.localResourceRoots, options.localResourceRoots)) {
      // Queued reads start under the new roots; a read already running answers as refused.
      this.abortActiveReads();
    }
    this.options = options;
    if (reload && this.ready) {
      this.render();
    }
  }

  get savedState(): string | undefined {
    return this.state;
  }

  setState(state: string | undefined): void {
    this.state = state;
  }

  postMessage(value: unknown): Promise<boolean> {
    if (this.disposed || !this.frame?.parentNode || this.pending.size >= 1024) {
      return Promise.resolve(false);
    }
    const id = ++this.sequence;
    return new Promise(resolve => {
      this.pending.set(id, { value, resolve });
      if (this.ready) {
        this.sendMessage(id, value);
      }
    });
  }

  focus(): boolean {
    if (!this.loaded || !this.frame?.parentNode) {
      return false;
    }
    this.frame.focus();
    this.port?.postMessage({ type: 'focus' });
    return true;
  }

  private render(): void {
    this.loaded = false;
    this.abortReads();
    this.port?.postMessage({
      type: 'content', revision: ++this.revision, html: this.html, state: this.state,
      scripts: this.options.enableScripts === true, forms: this.options.enableForms ?? this.options.enableScripts === true,
    });
  }

  private sendTheme(): void {
    const theme = this.theme.getColorTheme();
    const editor = this.container.closest('.workbench');
    const style = editor && this.window.getComputedStyle(editor);
    const colors: Record<string, string> = {};
    if (style) {
      for (const name of style) {
        const value = style.getPropertyValue(name).trim();
        if (/^--vscode-[\w-]+$/.test(name) && /^#[\da-f]{3,8}$/i.test(value)) {
          colors[name] = value;
        }
      }
    }
    for (const key of ['editor.background', 'editor.foreground', 'focusBorder', 'textLink.foreground']) {
      const value = theme.getColor(key);
      if (value && /^#[\da-f]{3,8}$/i.test(value)) {
        colors[asCssVariableName(key)] = value;
      }
    }
    const kind = theme.type === ColorScheme.LIGHT ? 'vscode-light'
      : theme.type === ColorScheme.DARK ? 'vscode-dark' : 'vscode-high-contrast';
    this.port?.postMessage({ type: 'theme', colors, kind });
  }

  private sendMessage(id: number, value: unknown): void {
    try {
      this.port?.postMessage({ type: 'message', id, value });
    } catch {
      this.resolveMessage(id, false);
    }
  }

  private receive(data: any): void {
    if (!data || this.disposed) {
      return;
    }
    if (data.type === 'ready' && !this.ready) {
      this.ready = true;
      this.window.clearTimeout(this.readyTimeout);
      this.sendTheme();
      this.render();
      for (const [id, { value }] of this.pending) {
        this.sendMessage(id, value);
      }
    }
    if (!this.ready) {
      return;
    }
    if (data.type === 'content-error') {
      this.showError('The Webview content did not start. Reopen the Webview to try again.');
    } else if (data.type === 'ack') {
      this.resolveMessage(data.id, data.accepted === true);
    } else if (data.revision === this.revision) {
      switch (data.type) {
        case 'content-ready':
          this.loaded = true;
          this.contentReady.fire();
          break;
        case 'message':
          this.messages.fire(data.value);
          break;
        case 'state':
          if (typeof data.value === 'string') {
            if (isWebviewState(data.value)) {
              this.state = data.value;
            }
            this.stateChanges.fire(data.value);
          }
          break;
        case 'resource':
          if (typeof data.path === 'string' && Number.isSafeInteger(data.id)) {
            this.requestResource(data.id, data.path);
          }
          break;
        case 'cancel-resource':
          this.cancelRead(data.id);
          break;
        case 'link':
          if (typeof data.href === 'string' && /^https?:\/\//i.test(data.href)) {
            void this.opener.open(data.href).catch(console.error);
          }
          break;
        case 'key':
          if (this.document.activeElement === this.frame && typeof data.key === 'string') {
            const event = new KeyboardEvent('keydown', {
              key: data.key, code: data.code, ctrlKey: data.ctrlKey, altKey: data.altKey,
              shiftKey: data.shiftKey, metaKey: data.metaKey, bubbles: true, cancelable: true,
            });
            this.frame?.dispatchEvent(event);
          }
          break;
        case 'context-menu':
          if (Number.isFinite(data.x) && Number.isFinite(data.y) && this.frame) {
            const rect = this.frame.getBoundingClientRect();
            this.contextMenus.fire({ x: rect.left + data.x, y: rect.top + data.y, context: data.context });
          }
          break;
      }
    }
  }

  private requestResource(id: number, path: string): void {
    if (this.reads.has(id) || this.queuedReads.some(read => read.id === id) || this.queuedReads.length >= queuedReadLimit) {
      this.port?.postMessage({ type: 'resource-result', id, status: 401 });
    } else if (this.reads.size >= concurrentReads) {
      this.queuedReads.push({ id, path });
    } else {
      void this.readResource(id, path);
    }
  }

  private cancelRead(id: number): void {
    this.reads.get(id)?.abort();
    const index = this.queuedReads.findIndex(read => read.id === id);
    if (index >= 0) {
      this.queuedReads.splice(index, 1);
    }
  }

  private async readResource(id: number, path: string): Promise<void> {
    const abort = new AbortController();
    this.reads.set(id, abort);
    try {
      const result = await loadWebviewResource(this.files, path, this.options.localResourceRoots ?? [], abort.signal);
      if (abort.signal.aborted) {
        // The shell ignores an answer for a read it has already finished; otherwise it would wait for its timeout.
        this.port?.postMessage({ type: 'resource-result', id, status: 401 });
      } else if (result.status === 200) {
        const bytes = result.bytes.slice();
        this.port?.postMessage({ type: 'resource-result', id, ...result, bytes }, [bytes.buffer]);
      } else {
        this.port?.postMessage({ type: 'resource-result', id, ...result });
      }
    } finally {
      if (this.reads.get(id) === abort) {
        this.reads.delete(id);
      }
      this.startQueuedReads();
    }
  }

  private startQueuedReads(): void {
    while (!this.disposed && this.reads.size < concurrentReads && this.queuedReads.length) {
      const { id, path } = this.queuedReads.shift()!;
      void this.readResource(id, path);
    }
  }

  private resolveMessage(id: number, accepted: boolean): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.resolve(accepted);
  }

  private abortReads(): void {
    this.queuedReads.length = 0;
    this.abortActiveReads();
  }

  private abortActiveReads(): void {
    for (const read of this.reads.values()) {
      read.abort();
    }
    this.reads.clear();
  }

  private showError(message: string, address?: URL): void {
    this.abortReads();
    this.port?.close();
    this.port = undefined;
    const status = this.document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = message;
    this.container.replaceChildren(status);
    if (address) {
      const link = this.document.createElement('a');
      link.textContent = address.origin;
      link.href = new URL(address.pathname, address.origin).href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      status.append(' ', link);
    }
    for (const id of this.pending.keys()) {
      this.resolveMessage(id, false);
    }
  }

  override dispose(): void {
    this.disposed = true;
    this.window.clearTimeout(this.readyTimeout);
    this.abortReads();
    this.port?.postMessage({ type: 'dispose' });
    this.port?.close();
    for (const id of this.pending.keys()) {
      this.resolveMessage(id, false);
    }
    this.container.remove();
    super.dispose();
  }
}
