import { expect, test } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IConfigurationService, NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { SettingsEditorInput } from '../../browser/settingsEditorInput.js';

class TestConfiguration extends NullConfigurationService {
  readonly saved: string[] = [];
  private readonly changed = new Emitter<string>();
  override readonly onDidChangeUserSettings = this.changed.event;
  override getUserSettingsText(): string { return this.saved.at(-1) ?? '{\n}\n'; }
  override saveUserSettings(text: string): void {
    this.saved.push(text);
    this.changed.fire(text);
  }
  override dispose(): void { this.changed.dispose(); }
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
