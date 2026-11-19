import { expect, test } from 'vitest';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { NullConfigurationService, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../../common/editor.js';
import type { IEditorFactoryRegistry } from '../../../../common/editor.js';
import { ISettingsEditorInputService, SettingsEditorInput } from '../../browser/settingsEditorInput.js';
import '../../browser/preferences.contribution.js';

test('restores the same settings input for multiple groups without serializing user text', () => {
  const services = new ServiceCollection(
    [IConfigurationService, new NullConfigurationService()],
    [IModelService, { getModel: () => null, createModel: () => { throw new Error('Unexpected model creation'); } }],
  );
  const instantiation = new InstantiationService(services);
  const input = instantiation.invokeFunction(accessor => accessor.get(ISettingsEditorInputService).getOrCreate());
  try {
    const factory = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;
    const serializer = factory.getEditorSerializer(input)!;
    expect(input.getName()).toBe('settings.json');
    const serialized = serializer.serialize(input)!;
    expect(serialized).toBe(SettingsEditorInput.resource.toString());
    expect(serializer.deserialize(instantiation, serialized)).toBe(input);
    expect(serializer.deserialize(instantiation, serialized)).toBe(input);
    expect(serializer.deserialize(instantiation, 'not the settings resource')).toBeUndefined();
  } finally {
    input.dispose();
  }
});
