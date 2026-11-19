import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqual } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IResourceEditorInput } from '../../../../platform/editor/common/editor.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ErrorEditorInput } from '../../../common/editor/errorEditorInput.js';
import { UntitledTextEditorInput } from '../../untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';
import { IEditorGroupsService } from '../common/editorGroupsService.js';
import type { IEditorGroup } from '../common/editorGroupsService.js';
import {
  DEFAULT_EDITOR_ID, EDITOR_ASSOCIATIONS_SETTING, globMatchesResource, IEditorResolverService, priorityToRank, RegisteredEditorPriority,
} from '../common/editorResolverService.js';
import type {
  EditorInputFactoryFunction, IResolvedEditor, RegisteredEditorInfo, RegisteredEditorOptions,
} from '../common/editorResolverService.js';

interface IRegisteredEditor {
  readonly globPattern: string;
  readonly editorInfo: RegisteredEditorInfo;
  readonly options: RegisteredEditorOptions;
  readonly createEditorInput: EditorInputFactoryFunction;
}

/** The user's `workbench.editorAssociations`: file name pattern to editor id. Anything else is ignored. */
function readAssociations(value: unknown): [pattern: string, editorId: string][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
}

export class EditorResolverService implements IEditorResolverService {
  declare readonly _serviceBrand: undefined;

  /** In registration order; the sort that picks an editor is stable, so the first of equals wins. */
  private readonly editors: IRegisteredEditor[] = [];

  constructor(
    @IConfigurationService private readonly configuration: IConfigurationService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    // Untitled text opens in the text editor: the fallback editor, for the untitled scheme only.
    this.registerEditor('*', { id: DEFAULT_EDITOR_ID, label: 'Text Editor', priority: RegisteredEditorPriority.builtin },
      { canSupportResource: resource => resource.scheme === Schemas.untitled },
      ({ resource, options }) => instantiation.invokeFunction(accessor => {
        // An untitled text that is open keeps its one input. A second input over the same model would
        // dispose the model, and the other tab's text with it, when either tab closes.
        const open = accessor.get(IEditorGroupsService).groups.flatMap(group => group.editors)
          .find(editor => editor instanceof UntitledTextEditorInput && isEqual(editor.resource, resource));
        const untitled = accessor.get(IUntitledTextEditorService);
        return { editor: open ?? new UntitledTextEditorInput(untitled.get(resource) ?? untitled.restore(resource, '')), options };
      }));
  }

  registerEditor(
    globPattern: string, editorInfo: RegisteredEditorInfo, options: RegisteredEditorOptions,
    createEditorInput: EditorInputFactoryFunction,
  ): IDisposable {
    const entry: IRegisteredEditor = { globPattern, editorInfo, options, createEditorInput };
    this.editors.push(entry);
    return toDisposable(() => {
      const index = this.editors.indexOf(entry);
      if (index !== -1) {
        this.editors.splice(index, 1);
      }
    });
  }

  getEditors(resource?: URI): RegisteredEditorInfo[] {
    const editors = resource ? this.findMatchingEditors(resource) : this.editors;
    const seen = new Set<string>();
    return editors.map(editor => editor.editorInfo).filter(info => !seen.has(info.id) && seen.add(info.id));
  }

  async resolveEditor(input: IResourceEditorInput, group: IEditorGroup): Promise<IResolvedEditor> {
    const { resource, options } = input;
    const selected = this.selectEditor(resource, options?.override);
    if (!selected) {
      const message = options?.override
        ? `no editor '${options.override}' is registered for ${resource}.`
        : `no editor is registered for ${resource}.`;
      return { editor: new ErrorEditorInput(resource, message), options, editorId: undefined };
    }
    // An override has been used up: the input it makes does not carry it on.
    const { override: _override, ...rest } = options ?? {};
    const created = await selected.createEditorInput({ resource, options: rest }, group);
    return { editor: created.editor, options: created.options ?? rest, editorId: selected.editorInfo.id };
  }

  private selectEditor(resource: URI, override: string | undefined): IRegisteredEditor | undefined {
    if (override) {
      // An editor asked for by id does not have to match the resource by its glob.
      return this.editors.find(editor => editor.editorInfo.id === override && this.supports(editor, resource));
    }
    const associations = this.getAssociations(resource);
    const matching = this.findMatchingEditors(resource, associations);
    const candidates = matching.filter(editor => editor.editorInfo.id !== DEFAULT_EDITOR_ID
      && priorityToRank(editor.editorInfo.priority) >= priorityToRank(RegisteredEditorPriority.builtin));
    if (candidates[0]?.editorInfo.priority === RegisteredEditorPriority.exclusive) {
      return candidates[0];
    }
    const associated = associations
      .map(editorId => matching.find(editor => editor.editorInfo.id === editorId))
      .find(editor => editor !== undefined);
    return associated ?? candidates[0] ?? matching.find(editor => editor.editorInfo.id === DEFAULT_EDITOR_ID);
  }

  /** The editors whose glob takes the resource, or that an association names; best first. */
  private findMatchingEditors(resource: URI, associations: readonly string[] = this.getAssociations(resource)): IRegisteredEditor[] {
    return this.editors
      .filter(editor => this.supports(editor, resource) && ((associations.includes(editor.editorInfo.id)
        && editor.editorInfo.priority !== RegisteredEditorPriority.exclusive) || globMatchesResource(editor.globPattern, resource)))
      .sort((a, b) => {
        const rank = priorityToRank(b.editorInfo.priority) - priorityToRank(a.editorInfo.priority);
        // Between equals the longer glob, normally the more specific one, wins.
        return rank !== 0 ? rank : b.globPattern.length - a.globPattern.length;
      });
  }

  private supports(editor: IRegisteredEditor, resource: URI): boolean {
    return editor.options.canSupportResource?.(resource) ?? true;
  }

  /** The editor ids the user associated with the resource, the most specific pattern first. */
  private getAssociations(resource: URI): string[] {
    return readAssociations(this.configuration.getValue(EDITOR_ASSOCIATIONS_SETTING))
      .filter(([pattern]) => globMatchesResource(pattern, resource))
      .sort(([a], [b]) => b.length - a.length)
      .map(([, editorId]) => editorId);
  }
}

registerSingleton(IEditorResolverService, EditorResolverService);
