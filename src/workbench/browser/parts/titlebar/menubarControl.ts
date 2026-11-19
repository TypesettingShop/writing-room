import { MenuBar } from '../../../../base/browser/ui/menu/menubar.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import './menubar.contribution.js';

export class CustomMenubarControl extends Disposable {
  private readonly menubar = this._register(new MutableDisposable<DisposableStore>());

  constructor(
    @IMenuService private readonly menuService: IMenuService,
    @IContextKeyService private readonly contextKeyService: IContextKeyService,
    @ILayoutService private readonly layoutService: ILayoutService,
  ) { super(); }

  installMenubar(container: HTMLElement): void {
    const installation = new DisposableStore();
    this.menubar.value = installation;
    const menu = installation.add(this.menuService.createMenu(MenuId.MenubarMainMenu, this.contextKeyService));
    const bar = installation.add(new MenuBar(container, this.layoutService.mainContainer));
    const update = () => bar.update(menu.getActions().flatMap(([, actions]) =>
      actions.filter(action => action instanceof SubmenuItemAction)));
    update();
    installation.add(menu.onDidChange(update));
  }
}
