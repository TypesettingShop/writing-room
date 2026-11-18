import { registerSingleton } from '../../instantiation/common/extensions.js';
import { ILayoutService } from '../../layout/browser/layoutService.js';
import { IQuickInputService } from '../common/quickInput.js';
import type { IInputOptions, IPickOptions, IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';
import { QuickInputController } from './quickInputController.js';

export class QuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined;
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

  dispose(): void {
    this.controller.dispose();
  }
}

registerSingleton(IQuickInputService, QuickInputService);
