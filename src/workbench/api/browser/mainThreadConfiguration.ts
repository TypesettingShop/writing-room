import type { IDisposable } from '../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import type { IConfigurationData } from '../../../platform/configuration/common/configurationModels.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { ExtHostConfigurationProxy, MainThreadConfigurationProxy } from '../common/extHost.protocol.configuration.js';
import type {
  ConfigurationOverridesDto, ConfigurationTargetDto, ExtHostConfigurationShape, MainThreadConfigurationShape,
} from '../common/extHost.protocol.configuration.js';

const enum Target {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/**
 * Hands the settings to the extension host — all of them when it asks at start, then each change — and
 * writes what extensions update into the user's settings.json. There is no workspace or folder target.
 */
export class MainThreadConfiguration implements MainThreadConfigurationShape, IDisposable {
  private readonly listener: IDisposable;

  constructor(
    private readonly proxy: ExtHostConfigurationShape,
    private readonly configuration: IConfigurationService,
    private readonly isRegistered: (extension: string) => boolean,
  ) {
    this.listener = configuration.onDidChangeConfiguration(event => {
      // Sent while the write that caused it is still running, so it reaches the host before the write's reply.
      void this.proxy.$acceptConfigurationChanged(configuration.getConfiguration().toData(event.affectedKeys)).catch(() => {});
    });
  }

  async $getConfigurationData(): Promise<IConfigurationData> {
    return this.configuration.getConfiguration().toData();
  }

  $updateConfigurationOption(
    extension: string, target: ConfigurationTargetDto, key: string, value: unknown,
    overrides: ConfigurationOverridesDto | undefined, scopeToLanguage: boolean | undefined,
  ): Promise<void> {
    return this.write(extension, target, key, value, overrides, scopeToLanguage);
  }

  $removeConfigurationOption(
    extension: string, target: ConfigurationTargetDto, key: string,
    overrides: ConfigurationOverridesDto | undefined, scopeToLanguage: boolean | undefined,
  ): Promise<void> {
    return this.write(extension, target, key, undefined, overrides, scopeToLanguage);
  }

  private async write(
    extension: unknown, target: unknown, key: unknown, value: unknown, overrides: unknown, scopeToLanguage: unknown,
  ): Promise<void> {
    if (typeof extension !== 'string' || !this.isRegistered(extension)) {
      throw new Error('The extension is not registered.');
    }
    if (typeof key !== 'string' || !key) {
      throw new Error('Expected a configuration key.');
    }
    if (target === Target.Workspace || target === Target.WorkspaceFolder) {
      const name = target === Target.Workspace ? 'Workspace Settings' : 'Folder Settings';
      throw new Error(`Unable to write to ${name} because this release does not support workspace settings.`);
    }
    if (target !== null && target !== undefined && target !== Target.Global) {
      throw new Error('Unknown configuration target.');
    }
    const language = overrides && typeof overrides === 'object'
      ? (overrides as ConfigurationOverridesDto).overrideIdentifier : undefined;
    if (language !== undefined && (typeof language !== 'string' || !language || language.includes(']'))) {
      throw new Error('Expected a language identifier.');
    }
    if (scopeToLanguage !== undefined && scopeToLanguage !== null && typeof scopeToLanguage !== 'boolean') {
      throw new Error('Expected a boolean for overrideInLanguage.');
    }
    // As in VS Code: `true` writes for the language, `false` for every language, and without either the
    // value goes where the user already has one for the language, or else for every language.
    const inLanguage = !!language && (scopeToLanguage === true
      || (scopeToLanguage !== false && this.configuration.inspect(key, { overrideIdentifier: language }).user?.override !== undefined));
    await this.configuration.updateValue(key, value, inLanguage ? { overrideIdentifier: language } : undefined);
  }

  dispose(): void {
    this.listener.dispose();
  }
}

mainThreadCustomers.register('configuration', ({ rpc, instantiation, getExtension }) => {
  const configuration = instantiation.invokeFunction(accessor => accessor.get(IConfigurationService));
  const main = new MainThreadConfiguration(rpc.getProxy(ExtHostConfigurationProxy), configuration, key => Boolean(getExtension(key)));
  rpc.set(MainThreadConfigurationProxy, main);
  return { dispose: () => main.dispose() };
});
