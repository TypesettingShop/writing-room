import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IQuickInputService } from '../common/quickInput.js';
import type { IQuickAccessController } from '../common/quickAccess.js';
import type {
  IInputBox, IInputOptions, IPickOptions, IQuickInputButton, IQuickPick, IQuickPickItem, IQuickPickSeparator,
} from '../common/quickInput.js';
import { QuickAccessController } from './quickAccess.js';
import { backButton, QuickInputController } from './quickInputController.js';

export class QuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined;
  readonly backButton: IQuickInputButton = backButton;
  private readonly controller: QuickInputController;
  private quickAccessController: QuickAccessController | undefined;

  constructor(
    @ILayoutService layout: ILayoutService,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
  ) {
    this.controller = new QuickInputController(layout);
  }

  get quickAccess(): IQuickAccessController {
    this.quickAccessController ??= new QuickAccessController(this, this.instantiation);
    return this.quickAccessController;
  }

  pick<T extends IQuickPickItem>(items: readonly (T | IQuickPickSeparator)[], options?: IPickOptions):
  Promise<T | undefined> {
    return this.controller.pick(items, options);
  }

  input(options?: IInputOptions): Promise<string | undefined> {
    return this.controller.input(options);
  }

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    return this.controller.createQuickPick<T>();
  }

  createInputBox(): IInputBox {
    return this.controller.createInputBox();
  }

  dispose(): void {
    this.controller.dispose();
  }
}

registerSingleton(IQuickInputService, QuickInputService);
