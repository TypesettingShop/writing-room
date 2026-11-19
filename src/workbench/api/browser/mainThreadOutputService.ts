import type { IDisposable } from '../../../base/common/lifecycle.js';
import { IOutputService } from '../../services/output/common/output.js';
import type { IOutputChannel } from '../../services/output/common/output.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { MainThreadOutputServiceProxy } from '../common/extHost.protocol.windowUi.js';
import type { MainThreadOutputServiceShape } from '../common/extHost.protocol.windowUi.js';

/** A label longer than this is cut: it is a name in a list. */
const MAX_LABEL_LENGTH = 256;

/**
 * The output channels of extensions. Each channel belongs to the extension that created it; removing the
 * extension, or stopping its host, removes its channels. The values from the extension host are checked
 * before they are used, and the output service keeps at most its limit of each channel's text.
 */
export class MainThreadOutputService implements MainThreadOutputServiceShape, IDisposable {
  private readonly channels = new Map<string, Map<number, IOutputChannel>>();

  constructor(
    private readonly output: IOutputService,
    private readonly getExtension: (extension: string) => HostExtensionDescription | undefined,
  ) {}

  async $register(extension: string, handle: number, label: string): Promise<void> {
    const description = typeof extension === 'string' ? this.getExtension(extension) : undefined;
    if (!description || !Number.isSafeInteger(handle) || typeof label !== 'string' || !label.trim()) {
      return;
    }
    let channels = this.channels.get(extension);
    if (channels?.has(handle)) {
      return;
    }
    const id = `extension-output-${extension}-#${handle}`;
    if (this.output.getChannel(id)) {
      return;
    }
    const displayName = description.manifest.displayName;
    const channel = this.output.registerChannel({
      id,
      label: label.trim().slice(0, MAX_LABEL_LENGTH),
      extensionId: description.id,
      extensionName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : description.id,
    });
    if (!channels) {
      channels = new Map();
      this.channels.set(extension, channels);
    }
    channels.set(handle, channel);
  }

  async $append(extension: string, handle: number, text: string): Promise<void> {
    if (typeof text === 'string') {
      this.channel(extension, handle)?.append(text);
    }
  }

  async $replace(extension: string, handle: number, text: string): Promise<void> {
    if (typeof text === 'string') {
      this.channel(extension, handle)?.replace(text);
    }
  }

  async $clear(extension: string, handle: number): Promise<void> {
    this.channel(extension, handle)?.clear();
  }

  async $reveal(extension: string, handle: number, preserveFocus: boolean): Promise<void> {
    const channel = this.channel(extension, handle);
    if (channel) {
      await this.output.showChannel(channel.id, preserveFocus === true);
    }
  }

  async $close(extension: string, handle: number): Promise<void> {
    const channel = this.channel(extension, handle);
    if (channel) {
      this.output.hideChannel(channel.id);
    }
  }

  async $dispose(extension: string, handle: number): Promise<void> {
    const channel = this.channel(extension, handle);
    if (channel) {
      this.channels.get(extension)!.delete(handle);
      channel.dispose();
    }
  }

  /** The channel, if this extension made it and is still registered. */
  private channel(extension: string, handle: number): IOutputChannel | undefined {
    return typeof extension === 'string' && this.getExtension(extension) ? this.channels.get(extension)?.get(handle) : undefined;
  }

  /** Removes the channels of an extension that was removed or whose host stopped. */
  remove(extension: string): void {
    const channels = this.channels.get(extension);
    this.channels.delete(extension);
    for (const channel of channels?.values() ?? []) {
      channel.dispose();
    }
  }

  dispose(): void {
    for (const extension of [...this.channels.keys()]) {
      this.remove(extension);
    }
  }
}

mainThreadCustomers.register('output', ({ rpc, instantiation, getExtension }) => {
  const output = new MainThreadOutputService(instantiation.invokeFunction(accessor => accessor.get(IOutputService)), getExtension);
  rpc.set(MainThreadOutputServiceProxy, output);
  return output;
});
