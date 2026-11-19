import { Emitter } from '../../../../base/common/event.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ActivePanelContext, ActiveViewletContext } from '../../../common/contextkeys.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IOutputService, OUTPUT_VIEW_ID, OutputChannelModel } from '../../../services/output/common/output.js';
import type { IOutputChannel, IOutputChannelDescriptor } from '../../../services/output/common/output.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';

class OutputChannel implements IOutputChannel {
  readonly model = new OutputChannelModel();
  private disposed = false;

  constructor(
    readonly descriptor: IOutputChannelDescriptor,
    private readonly onDispose: (channel: OutputChannel) => void,
  ) {}

  get id(): string {
    return this.descriptor.id;
  }

  get label(): string {
    return this.descriptor.label;
  }

  append(output: string): void {
    if (!this.disposed) {
      this.model.append(output);
    }
  }

  clear(): void {
    if (!this.disposed) {
      this.model.clear();
    }
  }

  replace(output: string): void {
    if (!this.disposed) {
      this.model.replace(output);
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.onDispose(this);
      this.model.dispose();
    }
  }
}

/** The output channels of the workbench and its extensions, each kept in memory up to its limit. */
export class OutputService implements IOutputService {
  declare readonly _serviceBrand: undefined;

  private readonly channels = new Map<string, OutputChannel>();
  private active: OutputChannel | undefined;
  private readonly didRegister = new Emitter<IOutputChannelDescriptor>();
  private readonly didRemove = new Emitter<IOutputChannelDescriptor>();
  private readonly didChangeActive = new Emitter<string | undefined>();
  readonly onDidRegisterChannel = this.didRegister.event;
  readonly onDidRemoveChannel = this.didRemove.event;
  readonly onActiveOutputChannel = this.didChangeActive.event;

  constructor(
    @IViewsService private readonly views: IViewsService,
    @IViewDescriptorService private readonly viewDescriptors: IViewDescriptorService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
  ) {}

  registerChannel(descriptor: IOutputChannelDescriptor): IOutputChannel {
    if (this.channels.has(descriptor.id)) {
      throw new Error(`Output channel '${descriptor.id}' is already registered.`);
    }
    const channel = new OutputChannel({ ...descriptor }, removed => this.remove(removed));
    this.channels.set(channel.id, channel);
    this.didRegister.fire(channel.descriptor);
    if (!this.active) {
      this.activate(channel);
    }
    return channel;
  }

  getChannel(id: string): IOutputChannel | undefined {
    return this.channels.get(id);
  }

  getChannelDescriptor(id: string): IOutputChannelDescriptor | undefined {
    return this.channels.get(id)?.descriptor;
  }

  getChannelDescriptors(): IOutputChannelDescriptor[] {
    return [...this.channels.values()].map(channel => channel.descriptor);
  }

  getActiveChannel(): IOutputChannel | undefined {
    return this.active;
  }

  setActiveChannel(id: string): void {
    const channel = this.channels.get(id);
    if (channel && channel !== this.active) {
      this.activate(channel);
    }
  }

  async showChannel(id: string, preserveFocus?: boolean): Promise<void> {
    if (!this.channels.has(id)) {
      return;
    }
    this.setActiveChannel(id);
    await this.views.openView(OUTPUT_VIEW_ID, !preserveFocus);
  }

  hideChannel(id: string): void {
    if (this.active?.id !== id) {
      return;
    }
    const container = this.viewDescriptors.getViewContainerById(OUTPUT_VIEW_ID);
    const location = container && this.viewDescriptors.getViewContainerLocation(container);
    // A part names its active container only while the part is visible.
    if (location === ViewContainerLocation.Panel && this.contextKeys.getContextKeyValue(ActivePanelContext.key) === OUTPUT_VIEW_ID) {
      this.layout.setPartHidden(true, Parts.PANEL_PART);
    } else if (location === ViewContainerLocation.Sidebar && this.contextKeys.getContextKeyValue(ActiveViewletContext.key) === OUTPUT_VIEW_ID) {
      this.layout.setPartHidden(true, Parts.SIDEBAR_PART);
    }
  }

  private activate(channel: OutputChannel | undefined): void {
    this.active = channel;
    this.didChangeActive.fire(channel?.id);
  }

  private remove(channel: OutputChannel): void {
    if (this.channels.get(channel.id) !== channel) {
      return;
    }
    this.channels.delete(channel.id);
    this.didRemove.fire(channel.descriptor);
    if (this.active === channel) {
      this.activate(this.channels.values().next().value);
    }
  }
}

registerSingleton(IOutputService, OutputService);
