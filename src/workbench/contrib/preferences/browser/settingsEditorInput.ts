import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import type { MonacoNamespace } from '../../../../editor/browser/monaco.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { ITextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const resource = URI.from({ scheme: 'vscode-userdata', path: '/User/settings.json' });
const schemaUri = 'vscode://schemas/writing-room/user-settings';
let schemaRegistered = false;

async function ensureSchema(): Promise<void> {
  const monaco = await loadMonaco();
  if (schemaRegistered) {
    return;
  }
  const update = () => registerSchema(monaco);
  update();
  configurationRegistry.onDidUpdateConfiguration(update);
  schemaRegistered = true;
}

function registerSchema(monaco: MonacoNamespace): void {
  const defaults = monaco.json.jsonDefaults;
  const existing = defaults.diagnosticsOptions;
  defaults.setDiagnosticsOptions({
    ...existing,
    validate: true,
    schemas: [
      ...existing.schemas?.filter(entry => entry.uri !== schemaUri) ?? [],
      {
        uri: schemaUri,
        fileMatch: [resource.toString()],
        schema: {
          type: 'object',
          additionalProperties: false,
          allowComments: true,
          allowTrailingCommas: true,
          properties: Object.fromEntries(configurationRegistry.getConfigurationProperties()),
        },
      },
    ],
  });
}

/** Monaco normalizes line endings and hides a leading BOM when returning the editable text. */
function editableText(text: string): string {
  return text.replace(/^\ufeff/, '').replace(/\r\n|\r/g, '\n');
}

export class SettingsEditorInput extends EditorInput implements ITextEditorModel {
  static readonly ID = 'workbench.editors.settingsJson';
  static readonly resource = resource;

  private model: ITextModel | null = null;
  private resolving?: Promise<this>;
  private saved: string;
  private dirty: boolean;

  constructor(
    private initialDraft: string | undefined,
    private readonly previousCreation: Promise<unknown> | undefined,
    @IConfigurationService private readonly configuration: IConfigurationService,
    @IModelService private readonly models: IModelService,
  ) {
    super();
    this.saved = configuration.getUserSettingsText();
    this.dirty = initialDraft !== undefined && editableText(initialDraft) !== editableText(this.saved);
    this._register(configuration.onDidChangeUserSettings(text => {
      const wasDirty = this.dirty;
      this.saved = text;
      if (!wasDirty && this.model && editableText(this.model.getValue()) !== editableText(text)) {
        this.model.setValue(text);
      }
      this.refreshDirty();
    }));
  }

  override get typeId(): string { return SettingsEditorInput.ID; }
  override get resource(): URI { return resource; }
  override getName(): string { return 'settings.json'; }
  override isDirty(): boolean { return this.dirty; }
  get textEditorModel(): ITextModel | null { return this.model; }

  get draft(): string | undefined {
    return this.dirty ? this.model?.getValue() ?? this.initialDraft : undefined;
  }

  whenCreationSettles(): Promise<unknown> | undefined {
    return this.resolving;
  }

  override resolve(): Promise<this> {
    this.resolving ??= this.createModel().catch(error => {
      this.resolving = undefined;
      throw error;
    });
    return this.resolving;
  }

  save(): void {
    // The draft is the model's text, or a restored draft while the model is still being created.
    const value = this.draft;
    if (value !== undefined) {
      this.configuration.saveUserSettings(this.saved.charCodeAt(0) === 0xfeff ? '\ufeff' + value : value);
    }
  }

  private async createModel(): Promise<this> {
    await this.previousCreation;
    await ensureSchema();
    if (this.isDisposed()) {
      return this;
    }
    const original = this.saved;
    const draft = this.draft;
    const model = await this.models.createModel(draft ?? original, 'json', resource);
    if (this.isDisposed()) {
      model.dispose();
      return this;
    }
    this.model = model;
    this.initialDraft = undefined;
    if (draft === undefined && this.saved !== original) {
      model.setValue(this.saved);
    }
    this._register(model.onDidChangeContent(() => this.refreshDirty()));
    this.refreshDirty();
    return this;
  }

  private refreshDirty(): void {
    const value = this.model?.getValue() ?? this.initialDraft;
    const dirty = value !== undefined && editableText(value) !== editableText(this.saved);
    if (dirty !== this.dirty) {
      this.dirty = dirty;
      this._onDidChangeDirty.fire();
    }
  }

  override dispose(): void {
    super.dispose();
    const model = this.model;
    this.model = null;
    model?.dispose();
  }
}

export const ISettingsEditorInputService = createDecorator<ISettingsEditorInputService>('settingsEditorInputService');

export interface ISettingsEditorInputService extends BrandedService {
  getOrCreate(restoredDraft?: string): SettingsEditorInput;
}

class SettingsEditorInputService implements ISettingsEditorInputService {
  declare readonly _serviceBrand: undefined;
  private input?: SettingsEditorInput;
  private draft?: string;
  private releasing?: Promise<unknown>;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  getOrCreate(restoredDraft?: string): SettingsEditorInput {
    if (!this.input) {
      const input = this.instantiation.createInstance(SettingsEditorInput, this.draft ?? restoredDraft, this.releasing);
      this.input = input;
      this.draft = undefined;
      Event.once(input.onWillDispose)(() => {
        this.draft = input.draft;
        this.releasing = input.whenCreationSettles()?.then(() => {}, () => {});
        this.input = undefined;
      });
    }
    return this.input;
  }
}

registerSingleton(ISettingsEditorInputService, SettingsEditorInputService);
