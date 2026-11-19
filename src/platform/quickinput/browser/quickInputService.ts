import { registerSingleton } from '../../instantiation/common/extensions.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IQuickInputService } from '../common/quickInput.js';
import type {
  IInputBox, IInputOptions, IPickOptions, IQuickInputButton, IQuickPick, IQuickPickItem, IQuickPickSeparator,
} from '../common/quickInput.js';
import { backButton, QuickInputController } from './quickInputController.js';

export class QuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined;
  readonly backButton: IQuickInputButton = backButton;
  private readonly controller: QuickInputController;

  constructor(@ILayoutService layout: ILayoutService) {
    this.controller = new QuickInputController(layout);
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
