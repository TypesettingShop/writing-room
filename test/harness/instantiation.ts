import { registerSingleton } from '../../src/platform/instantiation/common/extensions.js';
import { createDecorator } from '../../src/platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../src/platform/instantiation/common/instantiationService.js';

interface IMessage {
  readonly _serviceBrand: undefined;
  readonly text: string;
}

const IMessage = createDecorator<IMessage>('test.harness.message');

class Message implements IMessage {
  declare readonly _serviceBrand: undefined;
  readonly text = 'injected';
}

class Output {
  constructor(readonly label: string, @IMessage readonly message: IMessage) {}
}

registerSingleton(IMessage, Message);
const instance = new InstantiationService().createInstance(Output, 'Browser');
document.querySelector('output')!.textContent = instance.label + ': ' + instance.message.text;
