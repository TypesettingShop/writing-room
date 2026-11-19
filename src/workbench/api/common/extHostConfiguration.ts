import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { Configuration, ConfigurationChangeEvent } from '../../../platform/configuration/common/configurationModels.js';
import type { IConfigurationOverrides } from '../../../platform/configuration/common/configurationModels.js';
import { deepFreeze, isJSONValue, isPlainObject } from '../../../platform/configuration/common/configurationValues.js';
import { MainThreadConfigurationProxy } from './extHost.protocol.configuration.js';
import type {
  ConfigurationChangeDto, ConfigurationTargetDto, ExtHostConfigurationShape, MainThreadConfigurationShape,
} from './extHost.protocol.configuration.js';
import { ExtHostConfigurationProxy } from './extHost.protocol.configuration.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

/**
 * Only a language narrows what is read: there is one settings file, so a URI or a folder in the scope
 * changes nothing.
 */
function scopeToOverrides(scope: unknown): IConfigurationOverrides | undefined {
  if (!scope || typeof scope !== 'object') {
    return undefined;
  }
  const languageId = (scope as { languageId?: unknown }).languageId;
  return typeof languageId === 'string' && languageId ? { overrideIdentifier: languageId } : undefined;
}

function lookUp(tree: unknown, key: string): unknown {
  let node = tree;
  for (const part of key.split('.')) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

function toTarget(target: unknown): ConfigurationTargetDto {
  if (target === undefined || target === null) {
    return null;
  }
  if (typeof target === 'boolean') {
    return target ? ConfigurationTarget.Global : ConfigurationTarget.Workspace;
  }
  if (target === ConfigurationTarget.Global || target === ConfigurationTarget.Workspace || target === ConfigurationTarget.WorkspaceFolder) {
    return target;
  }
  throw new Error('Unknown configuration target: ' + String(target));
}

/**
 * The extension host's copy of the settings: the whole of it arrives once, then only changed keys. Reads
 * are synchronous; writes go to the workbench, and their change arrives before the write settles.
 */
export class ExtHostConfiguration implements ExtHostConfigurationShape {
  private configuration = new Configuration();
  private initialized = false;
  readonly whenInitialized: Promise<void>;
  private readonly emitters = new Map<string, Emitter<vscode.ConfigurationChangeEvent>>();

  constructor(private readonly proxy: MainThreadConfigurationShape) {
    // The workbench answers before it hears that this host has started, so before any activation.
    this.whenInitialized = proxy.$getConfigurationData().then(data => {
      this.configuration = new Configuration(data);
      this.initialized = true;
    }, () => {});
  }

  async $acceptConfigurationChanged(changes: ConfigurationChangeDto): Promise<void> {
    // The data requested at start was read after any change sent before it, so earlier changes are in it.
    if (!this.initialized) {
      return;
    }
    const previous = this.configuration;
    this.configuration = previous.with(changes);
    const change = new ConfigurationChangeEvent(changes.map(([key]) => key), previous, this.configuration);
    const event: vscode.ConfigurationChangeEvent = Object.freeze({
      affectsConfiguration: (section: string, scope?: vscode.ConfigurationScope) =>
        change.affectsConfiguration(section, scopeToOverrides(scope)),
    });
    // The copy is up to date first, so a listener reads the new values.
    for (const emitter of [...this.emitters.values()]) {
      emitter.fire(event);
    }
  }

  onDidChangeConfiguration(extension: string): vscode.Event<vscode.ConfigurationChangeEvent> {
    let emitter = this.emitters.get(extension);
    if (!emitter) {
      emitter = new Emitter();
      this.emitters.set(extension, emitter);
    }
    return emitter.event;
  }

  /** Stops the events of an extension that was deactivated or removed. */
  release(extension: string): void {
    this.emitters.get(extension)?.dispose();
    this.emitters.delete(extension);
  }

  dispose(): void {
    for (const emitter of this.emitters.values()) {
      emitter.dispose();
    }
    this.emitters.clear();
  }

  getConfiguration(extension: string, section?: string, scope?: vscode.ConfigurationScope | null): vscode.WorkspaceConfiguration {
    const overrides = scopeToOverrides(scope);
    // A fresh copy, frozen: what an extension reads cannot change the copy, nor be changed by the next event.
    const config = deepFreeze(this.configuration.getValue(section || undefined, overrides));
    const qualify = (key: string) => section ? section + '.' + key : key;
    const result = {
      has: (key: string): boolean => lookUp(config, key) !== undefined,
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        const value = lookUp(config, key);
        return value === undefined ? defaultValue : value as T;
      },
      update: (key: string, value: unknown, target?: vscode.ConfigurationTarget | boolean | null, overrideInLanguage?: boolean) =>
        this.update(extension, qualify(key), value, target, overrides, overrideInLanguage),
      inspect: <T>(key: string) => {
        const qualified = qualify(key);
        const value = this.configuration.inspect<T>(qualified, overrides);
        return deepFreeze({
          key: qualified,
          defaultValue: value.default?.value,
          globalValue: value.user?.value,
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
          defaultLanguageValue: value.default?.override,
          globalLanguageValue: value.user?.override,
          workspaceLanguageValue: undefined,
          workspaceFolderLanguageValue: undefined,
          languageIds: value.overrideIdentifiers ? [...value.overrideIdentifiers] : undefined,
        });
      },
    };
    if (isPlainObject(config)) {
      for (const [name, value] of Object.entries(config)) {
        if (!Object.hasOwn(result, name)) {
          Object.defineProperty(result, name, { value, enumerable: true });
        }
      }
    }
    return Object.freeze(result) as vscode.WorkspaceConfiguration;
  }

  private async update(
    extension: string, key: string, value: unknown, target: unknown,
    overrides: IConfigurationOverrides | undefined, overrideInLanguage: boolean | undefined,
  ): Promise<void> {
    const dto = toTarget(target);
    if (value === undefined) {
      return this.proxy.$removeConfigurationOption(extension, dto, key, overrides, overrideInLanguage);
    }
    if (!isJSONValue(value)) {
      throw new Error(`Unable to write ${key}: the value must be JSON data without functions or cycles.`);
    }
    return this.proxy.$updateConfigurationOption(extension, dto, key, value, overrides, overrideInLanguage);
  }
}

extHostApiRegistry.register('configuration', ({ rpc }) => {
  const configuration = new ExtHostConfiguration(rpc.getProxy(MainThreadConfigurationProxy));
  rpc.set(ExtHostConfigurationProxy, configuration);
  return {
    service: configuration,
    create: ({ key }) => ({
      types: { ConfigurationTarget },
      namespaces: {
        workspace: {
          getConfiguration: (section?: string, scope?: vscode.ConfigurationScope | null) =>
            configuration.getConfiguration(key, section, scope),
          // Looked up on each call: a released extension that is activated again gets events again.
          onDidChangeConfiguration: (listener, thisArgs?, disposables?) =>
            configuration.onDidChangeConfiguration(key)(listener, thisArgs, disposables),
        } satisfies Pick<typeof vscode.workspace, 'getConfiguration' | 'onDidChangeConfiguration'>,
      },
    }),
    release: key => configuration.release(key),
    dispose: () => configuration.dispose(),
  };
});
