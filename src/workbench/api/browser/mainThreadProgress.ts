import type { IDisposable } from '../../../base/common/lifecycle.js';
import { INotificationService, Severity } from '../../../platform/notification/common/notification.js';
import type { INotificationAction, INotificationHandle } from '../../../platform/notification/common/notification.js';
import { IStatusbarService, StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntryAccessor } from '../../services/statusbar/browser/statusbar.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { ExtHostProgressProxy, MainThreadProgressProxy } from '../common/extHost.protocol.windowUi.js';
import type { ExtHostProgressShape, MainThreadProgressShape, ProgressOptionsDto, ProgressStepDto } from '../common/extHost.protocol.windowUi.js';

const notificationLocation = 15;

interface Running {
  readonly title: string;
  message: string | undefined;
  /** Percent done; it stops at 100 whatever the increments add up to. */
  worked: number | undefined;
  readonly notification?: INotificationHandle;
  readonly entry?: IStatusbarEntryAccessor;
}

interface StatusMessage {
  readonly extension: string;
  readonly id: number;
  readonly text: string;
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export function extensionName(extension: HostExtensionDescription | undefined): string | undefined {
  const name = extension?.manifest.displayName;
  return typeof name === 'string' && name.trim() ? name.trim() : extension?.id;
}

/**
 * Shows the progress of extensions — a toast with a bar for `ProgressLocation.Notification`, a spinning
 * status bar item for every other location — and their status bar messages. Removing an extension takes
 * all of them away.
 */
export class MainThreadProgress implements MainThreadProgressShape, IDisposable {
  private readonly running = new Map<string, Map<number, Running>>();
  private readonly messages: StatusMessage[] = [];
  private messageEntry: IStatusbarEntryAccessor | undefined;

  constructor(
    private readonly proxy: ExtHostProgressShape,
    private readonly notifications: INotificationService,
    private readonly statusbar: IStatusbarService,
    private readonly getExtension: (extension: string) => HostExtensionDescription | undefined,
  ) {}

  async $startProgress(extension: string, handle: number, options: ProgressOptionsDto): Promise<void> {
    const description = typeof extension === 'string' ? this.getExtension(extension) : undefined;
    if (!description || !Number.isSafeInteger(handle) || !options || typeof options !== 'object') {
      return;
    }
    const all = this.running.get(extension) ?? new Map<number, Running>();
    if (all.has(handle)) {
      return;
    }
    this.running.set(extension, all);
    const title = text(options.title) ?? '';
    if (options.location === notificationLocation) {
      let cancelled = false;
      const cancel: INotificationAction = {
        label: 'Cancel', keepOpen: true,
        run: () => {
          if (cancelled) {
            return;
          }
          cancelled = true;
          this.proxy.$acceptProgressCanceled(handle).catch(() => {});
          notification.updateActions([{ label: 'Cancel', keepOpen: true, enabled: false, run: () => {} }]);
        },
      };
      const notification = this.notifications.notify({
        severity: Severity.Info, message: title, source: extensionName(description), progress: { infinite: true },
        actions: options.cancellable === true ? [cancel] : [],
      });
      all.set(handle, { title, message: undefined, worked: undefined, notification });
    } else {
      // Source control and view locations show in the window as well: there are none of their own here.
      const running: Running = {
        title, message: undefined, worked: undefined,
        entry: this.statusbar.addEntry(this.windowEntry(title, undefined, extensionName(description)),
          'status.progress.' + description.id + '.' + handle, StatusbarAlignment.LEFT, Number.MIN_SAFE_INTEGER),
      };
      all.set(handle, running);
    }
  }

  private windowEntry(title: string, message: string | undefined, source: string | undefined) {
    const label = [title, message].filter(Boolean).join(': ');
    return {
      name: 'Progress', text: '$(loading~spin)' + (label ? ' ' + label.replaceAll('$(', '\\$(') : ''),
      ariaLabel: label || 'Working', tooltip: source ? label + (label ? ' — ' : '') + source : label || undefined,
    };
  }

  async $progressReport(extension: string, handle: number, step: ProgressStepDto): Promise<void> {
    const running = this.running.get(extension)?.get(handle);
    if (!running || !step || typeof step !== 'object') {
      return;
    }
    const message = text(step.message);
    if (message !== undefined) {
      running.message = message;
    }
    const increment = step.increment;
    if (typeof increment === 'number' && Number.isFinite(increment) && increment > 0) {
      running.worked = Math.min(100, (running.worked ?? 0) + increment);
    }
    if (running.notification) {
      running.notification.updateMessage([running.title, running.message].filter(Boolean).join(': '));
      running.notification.updateProgress(running.worked === undefined ? { infinite: true } : { worked: running.worked });
    } else {
      running.entry?.update(this.windowEntry(running.title, running.message,
        extensionName(this.getExtension(extension))));
    }
  }

  async $progressEnd(extension: string, handle: number): Promise<void> {
    const all = this.running.get(extension);
    const running = all?.get(handle);
    if (running) {
      all!.delete(handle);
      running.notification?.close();
      running.entry?.dispose();
    }
  }

  async $setStatusBarMessage(extension: string, id: number, text: string): Promise<void> {
    if (!this.getExtension(extension) || !Number.isSafeInteger(id) || typeof text !== 'string') {
      return;
    }
    this.removeMessage(extension, id, false);
    this.messages.push({ extension, id, text });
    this.renderMessage();
  }

  async $disposeStatusBarMessage(extension: string, id: number): Promise<void> {
    this.removeMessage(extension, id, true);
  }

  private removeMessage(extension: string, id: number, render: boolean): void {
    const index = this.messages.findIndex(message => message.extension === extension && message.id === id);
    if (index !== -1) {
      this.messages.splice(index, 1);
      if (render) {
        this.renderMessage();
      }
    }
  }

  /** The newest message shows; when it goes, the one before it shows again. */
  private renderMessage(): void {
    const message = this.messages.at(-1);
    if (!message) {
      this.messageEntry?.dispose();
      this.messageEntry = undefined;
      return;
    }
    const entry = { name: 'Extension Status', text: message.text };
    if (this.messageEntry) {
      this.messageEntry.update(entry);
    } else {
      this.messageEntry = this.statusbar.addEntry(entry, 'status.extensionMessage', StatusbarAlignment.LEFT, Number.MIN_SAFE_INTEGER + 1);
    }
  }

  remove(extension: string): void {
    for (const running of this.running.get(extension)?.values() ?? []) {
      running.notification?.close();
      running.entry?.dispose();
    }
    this.running.delete(extension);
    const before = this.messages.length;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      if (this.messages[index].extension === extension) {
        this.messages.splice(index, 1);
      }
    }
    if (this.messages.length !== before) {
      this.renderMessage();
    }
  }

  dispose(): void {
    for (const extension of [...this.running.keys()]) {
      this.remove(extension);
    }
    this.messages.length = 0;
    this.renderMessage();
  }
}

mainThreadCustomers.register('progress', ({ rpc, instantiation, getExtension }) => {
  const { notifications, statusbar } = instantiation.invokeFunction(accessor => ({
    notifications: accessor.get(INotificationService), statusbar: accessor.get(IStatusbarService),
  }));
  const progress = new MainThreadProgress(rpc.getProxy(ExtHostProgressProxy), notifications, statusbar, getExtension);
  rpc.set(MainThreadProgressProxy, progress);
  return progress;
});
