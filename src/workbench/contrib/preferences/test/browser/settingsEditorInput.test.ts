import { expect, test } from 'vitest';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { SettingsEditorInput } from '../../browser/settingsEditorInput.js';

class TestConfiguration implements IConfigurationService {
  declare readonly _serviceBrand: undefined;
  readonly saved: string[] = [];
  private readonly changed = new Emitter<string>();
  readonly onDidChangeConfiguration = Event.None;
  readonly onDidChangeUserSettings = this.changed.event;
  getValue(): undefined { return undefined; }
  async updateValue(): Promise<void> {}
  getUserSettingsText(): string { return this.saved.at(-1) ?? '{\n}\n'; }
  saveUserSettings(text: string): void {
    this.saved.push(text);
    this.changed.fire(text);
  }
  dispose(): void { this.changed.dispose(); }
}

test('saves a draft restored from a closed editor before its model exists', () => {
  const configuration = new TestConfiguration();
  const services = new ServiceCollection(
    [IConfigurationService, configuration],
    [IModelService, { getModel: () => null, createModel: () => { throw new Error('Unexpected model creation'); } }],
  );
  const draft = '{"editor.fontSize": 20}';
  const input = new InstantiationService(services).createInstance(SettingsEditorInput, draft, undefined);
  try {
    expect(input.textEditorModel).toBeNull();
    expect(input.isDirty()).toBe(true);
    input.save();
    expect(configuration.saved).toEqual([draft]);
    expect(input.isDirty()).toBe(false);
  } finally {
    input.dispose();
    configuration.dispose();
  }
});
