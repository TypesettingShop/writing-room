import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { NotificationsToasts } from '../../browser/parts/notifications/notificationsToasts.js';
import { IStatusbarService } from '../../services/statusbar/browser/statusbar.js';
import { MainThreadTreeViews } from './mainThreadTreeViews.js';
import type { ExtensionTreeViews } from './mainThreadTreeViews.js';
import { MainThreadStatusBar } from './mainThreadStatusBar.js';
import { MainThreadMessageService } from './mainThreadMessageService.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import type { ExtensionHostStatus } from '../../services/extensions/common/extensionHostProtocol.js';
import type { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { ExtHostContext, MainContext } from '../common/extHost.protocol.js';
import type { MainThreadExtensionServiceShape } from '../common/extHost.protocol.js';
import { MainThreadCommands } from './mainThreadCommands.js';
import type { CommandHostAccess } from './mainThreadCommands.js';

export interface MainThreadExtensionAccess extends CommandHostAccess {
  ownsView(key: string, viewId: string): boolean;
  setStatus(key: string, status: ExtensionHostStatus): void;
}

export class MainThreadExtensionService extends Disposable implements MainThreadExtensionServiceShape {
  private readonly commands: MainThreadCommands;
  private readonly trees: MainThreadTreeViews;
  private readonly entries: MainThreadStatusBar;
  private readonly messages: MainThreadMessageService;

  constructor(
    rpc: RPCProtocol,
    private readonly host: MainThreadExtensionAccess,
    views: ExtensionTreeViews,
    @IInstantiationService instantiation: IInstantiationService,
    @IStatusbarService statusbar: IStatusbarService,
    @ILayoutService layout: ILayoutService,
  ) {
    super();
    this.commands = this._register(new MainThreadCommands(rpc.getProxy(ExtHostContext.ExtHostCommands), host, instantiation));
    this.trees = this._register(new MainThreadTreeViews(rpc.getProxy(ExtHostContext.ExtHostTreeViews), views, host.ownsView));
    this.entries = this._register(new MainThreadStatusBar(statusbar, host.extensionId));
    const toasts = this._register(new NotificationsToasts(layout.mainContainer));
    this.messages = this._register(new MainThreadMessageService(toasts, key => Boolean(host.extensionId(key))));
    rpc.set(MainContext.MainThreadCommands, this.commands);
    rpc.set(MainContext.MainThreadTreeViews, this.trees);
    rpc.set(MainContext.MainThreadStatusBar, this.entries);
    rpc.set(MainContext.MainThreadMessageService, this.messages);
    rpc.set(MainContext.MainThreadExtensionService, this);
  }

  async $setActivationStatus(extension: string, status: ExtensionHostStatus): Promise<void> {
    this.host.setStatus(extension, status);
  }

  remove(extension: string): void {
    this.commands.remove(extension);
    this.trees.remove(extension);
    this.entries.remove(extension);
    this.messages.remove(extension);
  }
}
