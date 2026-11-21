import { toDisposable } from '../../base/common/lifecycle.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../platform/registry/common/platform.js';
import type { EditorInput } from './editor/editorInput.js';

export const EditorExtensions = {
  EditorPane: 'workbench.contributions.editors',
  EditorFactory: 'workbench.contributions.editor.inputFactories',
} as const;

export const FILE_EDITOR_INPUT_ID = 'workbench.editors.files.fileEditorInput';

/** An editor group's id: an increasing integer, never reused. */
export type GroupIdentifier = number;

export interface IEditorIdentifier {
  readonly groupId: GroupIdentifier;
  readonly editor: EditorInput;
}

/**
 * What a command run from an editor's tab or a group's title passes as its first argument, naming
 * the group and, from a tab, the editor at that index. A command run from elsewhere gets nothing
 * and works on the active group.
 */
export interface IEditorCommandsContext {
  readonly groupId: GroupIdentifier;
  readonly editorIndex?: number;
}

export function isEditorCommandsContext(value: unknown): value is IEditorCommandsContext {
  return typeof value === 'object' && value !== null
    && typeof (value as IEditorCommandsContext).groupId === 'number'
    && ['number', 'undefined'].includes(typeof (value as IEditorCommandsContext).editorIndex);
}

/** What a group tells about the pane that shows its active editor. `EditorPane` implements it. */
export interface IEditorPane {
  readonly id: string;
  readonly input: EditorInput | undefined;
  getViewState(): object | undefined;
  focus(): void;
}

export enum EditorsOrder {
  /** Most recently active first. */
  MOST_RECENTLY_ACTIVE,
  /** Tab order. */
  SEQUENTIAL,
}

/** What changed in an editor group's model. */
export enum GroupModelChangeKind {
  EDITOR_OPEN,
  EDITOR_CLOSE,
  EDITOR_MOVE,
  EDITOR_ACTIVE,
  EDITOR_LABEL,
  EDITOR_DIRTY,
  EDITOR_WILL_DISPOSE,
}

/**
 * Writes an editor input to a string and reads it back, registered under the input's `typeId`.
 * An input without one is left out when its group is serialized.
 */
export interface IEditorSerializer {
  canSerialize(editor: EditorInput): boolean;
  serialize(editor: EditorInput): string | undefined;
  deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined;
}

export interface IEditorFactoryRegistry {
  /**
   * Registers the serializer of the inputs whose `typeId` is `editorTypeId`. VS Code instantiates
   * serializers with services; these take none and get the instantiation service in `deserialize`.
   */
  registerEditorSerializer(editorTypeId: string, ctor: new () => IEditorSerializer): IDisposable;
  getEditorSerializer(editor: EditorInput): IEditorSerializer | undefined;
  getEditorSerializer(editorTypeId: string): IEditorSerializer | undefined;
}

class EditorFactoryRegistry implements IEditorFactoryRegistry {
  private readonly serializers = new Map<string, { readonly ctor: new () => IEditorSerializer; instance?: IEditorSerializer }>();

  registerEditorSerializer(editorTypeId: string, ctor: new () => IEditorSerializer): IDisposable {
    if (this.serializers.has(editorTypeId)) {
      throw new Error(`An editor serializer for ${editorTypeId} is already registered.`);
    }
    const entry = { ctor };
    this.serializers.set(editorTypeId, entry);
    return toDisposable(() => {
      if (this.serializers.get(editorTypeId) === entry) {
        this.serializers.delete(editorTypeId);
      }
    });
  }

  getEditorSerializer(editorOrTypeId: EditorInput | string): IEditorSerializer | undefined {
    const typeId = typeof editorOrTypeId === 'string' ? editorOrTypeId : editorOrTypeId.typeId;
    const entry = this.serializers.get(typeId);
    if (!entry) {
      return undefined;
    }
    entry.instance ??= new entry.ctor();
    return entry.instance;
  }
}

Registry.add(EditorExtensions.EditorFactory, new EditorFactoryRegistry());
