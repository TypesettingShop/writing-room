import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { combinedDisposable, Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorsOrder, GroupModelChangeKind } from '../editor.js';
import type { GroupIdentifier, IEditorFactoryRegistry } from '../editor.js';
import { EditorInput } from './editorInput.js';

export interface IGroupModelChangeEvent {
  readonly kind: GroupModelChangeKind;
  readonly editor?: EditorInput;
  /** The editor's index after the change; for `EDITOR_CLOSE`, the index it had. */
  readonly editorIndex?: number;
  /** For `EDITOR_MOVE`, the index the editor had before. */
  readonly oldEditorIndex?: number;
}

export interface ISerializedEditorInput {
  readonly id: string;
  readonly value: string;
}

export interface ISerializedEditorGroupModel {
  readonly id: GroupIdentifier;
  /** The serializable editors in tab order. */
  readonly editors: ISerializedEditorInput[];
  /** Indexes into `editors`, most recently active first: the first is the active editor. */
  readonly mru: number[];
}

/** The parts of the editor part's options the model reads. */
export interface IEditorGroupModelOptions {
  /** Where a new editor opens in its group, relative to the active editor. */
  readonly openPositioning: 'left' | 'right' | 'first' | 'last';
  /** Closing the active editor activates the most recently used one rather than its neighbour. */
  readonly focusRecentEditorAfterClose: boolean;
}

export type EditorInputWriter = (editor: EditorInput) => string | undefined;
export type EditorInputReader = (typeId: string, value: string) => EditorInput | undefined;

export function serializeEditorInput(editor: EditorInput): string | undefined {
  const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;
  const serializer = registry.getEditorSerializer(editor);
  return serializer?.canSerialize(editor) ? serializer.serialize(editor) : undefined;
}

export function deserializeEditorInput(
  instantiationService: IInstantiationService, typeId: string, value: string,
): EditorInput | undefined {
  const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;
  const editor = registry.getEditorSerializer(typeId)?.deserialize(instantiationService, value);
  return editor instanceof EditorInput && !editor.isDisposed() ? editor : undefined;
}

const DEFAULT_MODEL_OPTIONS: IEditorGroupModelOptions = { openPositioning: 'right', focusRecentEditorAfterClose: true };

export interface IEditorOpenOptions {
  /** Where to put a new editor, or move an existing one; by default the options decide. */
  readonly index?: number;
  /** Whether the editor becomes active. A group without an active editor activates it anyway. */
  readonly active?: boolean;
}

export interface IEditorOpenResult {
  /** The editor the group holds: `candidate`, or the editor that already `matches` it. */
  readonly editor: EditorInput;
  readonly isNew: boolean;
}

export interface IEditorCloseResult {
  readonly editor: EditorInput;
  readonly editorIndex: number;
}

let groupIds = 0;

/**
 * The editors of one group, without any DOM: their tab order (`editors`) and the order they were
 * active in (`mru`). Every change fires `onDidModelChange`, which is what the views draw from.
 * v0.1.0 has no preview, pinned or sticky editors: every editor is an ordinary tab.
 */
export class EditorGroupModel extends Disposable {
  private readonly _onDidModelChange = this._register(new Emitter<IGroupModelChangeEvent>());
  readonly onDidModelChange: Event<IGroupModelChangeEvent> = this._onDidModelChange.event;

  /**
   * Unique among the page's models. A new model takes the next number; a restored one keeps its
   * saved id and moves the counter past it.
   */
  readonly id: GroupIdentifier;

  private editors: EditorInput[] = [];
  private mru: EditorInput[] = [];
  private active: EditorInput | null = null;
  private readonly editorListeners = new Map<EditorInput, IDisposable>();

  constructor(
    private readonly getOptions: () => IEditorGroupModelOptions = () => DEFAULT_MODEL_OPTIONS,
    restoredId?: GroupIdentifier,
  ) {
    super();
    this.id = restoredId ?? ++groupIds;
    groupIds = Math.max(groupIds, this.id);
  }

  static deserialize(
    data: unknown, readEditor: EditorInputReader, getOptions: () => IEditorGroupModelOptions,
  ): EditorGroupModel {
    const state = data as Partial<ISerializedEditorGroupModel> | null | undefined;
    const id = state?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || id === Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid saved editor group id.');
    }
    const model = new EditorGroupModel(getOptions, id);
    const warn = (detail: string, index?: number, typeId?: string) =>
      console.warn('Invalid saved editor group data.', { key: 'editorpart.state', groupId: id, detail, index, typeId });
    const byIndex = new Map<number, EditorInput>();

    const entries = state?.editors;
    if (Array.isArray(entries)) {
      entries.forEach((saved, index) => {
        if (typeof saved?.id !== 'string' || typeof saved.value !== 'string') {
          warn('Invalid editor entry', index);
          return;
        }
        try {
          const editor = readEditor(saved.id, saved.value);
          if (editor && !model.findEditor(editor)) {
            model.insertEditor(editor, model.count);
            byIndex.set(index, editor);
            return;
          }
        } catch {
          // A serializer or input can fail independently of the other tabs.
        }
        warn('Editor could not be restored', index, saved.id);
      });
    } else {
      warn('Invalid editor list');
    }

    const recent = new Set<EditorInput>();
    if (Array.isArray(state?.mru)) {
      for (const index of state.mru) {
        const editor = byIndex.get(index);
        if (editor) {
          recent.add(editor);
        } else if (!Number.isInteger(index) || index < 0 || index >= (Array.isArray(entries) ? entries.length : 0)) {
          warn('Invalid recently used editor index', index);
        }
      }
    } else {
      warn('Invalid recently used editor list');
    }
    model.editors.forEach(editor => recent.add(editor));
    model.mru = [...recent];
    model.active = model.mru[0] ?? null;
    return model;
  }

  get count(): number {
    return this.editors.length;
  }

  get activeEditor(): EditorInput | null {
    return this.active;
  }

  isActive(editor: EditorInput): boolean {
    return this.active === editor;
  }

  getEditors(order: EditorsOrder): EditorInput[] {
    return order === EditorsOrder.MOST_RECENTLY_ACTIVE ? [...this.mru] : [...this.editors];
  }

  getEditorByIndex(index: number): EditorInput | undefined {
    return this.editors[index];
  }

  /** The index of this very editor object, or -1. */
  indexOf(editor: EditorInput | null | undefined): number {
    return editor ? this.editors.indexOf(editor) : -1;
  }

  /** Whether the group holds this very editor object. */
  contains(editor: EditorInput): boolean {
    return this.editors.includes(editor);
  }

  /** The editor the group holds that `matches` `candidate`, and its index. */
  findEditor(candidate: EditorInput): [EditorInput, number] | undefined {
    const index = this.editors.findIndex(editor => editor === candidate || editor.matches(candidate));
    return index === -1 ? undefined : [this.editors[index], index];
  }

  /**
   * Opens `candidate`. An editor the group already holds that `matches` it is activated (and moved,
   * given an `index`) instead of getting a second tab. A new editor goes to `index`, or by default
   * to the right of the active editor.
   */
  openEditor(candidate: EditorInput, options: IEditorOpenOptions = {}): IEditorOpenResult {
    const makeActive = options.active !== false || !this.active;
    const existing = this.findEditor(candidate);
    if (existing) {
      const [editor] = existing;
      if (options.index !== undefined) {
        this.moveEditor(editor, options.index);
      }
      if (makeActive) {
        this.setActive(editor);
      }
      return { editor, isNew: false };
    }

    const index = this.clampIndex(options.index ?? this.defaultOpenIndex(), this.editors.length);
    this.insertEditor(candidate, index);
    if (makeActive) {
      this.setActive(candidate);
    }
    return { editor: candidate, isNew: true };
  }

  /**
   * Closes `candidate` (or the editor that `matches` it). Closing the active editor activates the
   * most recently used one that is left (with `focusRecentEditorAfterClose` off, the neighbour), or
   * nothing once the group is empty. The new active editor is reported before the close, with the
   * index it has once the closed editor is out of the tab order.
   */
  closeEditor(candidate: EditorInput): IEditorCloseResult | undefined {
    const found = this.findEditor(candidate);
    if (!found) {
      return undefined;
    }
    const [editor, index] = found;
    const wasActive = this.active === editor;
    // The next editor is chosen from the tabs as they were; its event reads the tabs without the closed one.
    const next = wasActive ? this.nextActiveAfterClose(editor, index) : undefined;
    this.editors.splice(index, 1);
    if (wasActive) {
      this.active = null;
      if (next) {
        this.setActive(next);
      } else {
        this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_ACTIVE });
      }
    }
    this.mru.splice(this.mru.indexOf(editor), 1);
    this.editorListeners.get(editor)?.dispose();
    this.editorListeners.delete(editor);
    this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_CLOSE, editor, editorIndex: index });
    return { editor, editorIndex: index };
  }

  /**
   * Moves `candidate` within the group so that its index afterwards is `toIndex` (clamped to the
   * group). Moving right by one is `toIndex = index + 1`, as in VS Code.
   */
  moveEditor(candidate: EditorInput, toIndex: number): EditorInput | undefined {
    const found = this.findEditor(candidate);
    if (!found) {
      return undefined;
    }
    const [editor, index] = found;
    const target = this.clampIndex(toIndex, this.editors.length - 1);
    if (target === index) {
      return editor;
    }
    this.editors.splice(index, 1);
    this.editors.splice(target, 0, editor);
    this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_MOVE, editor, editorIndex: target, oldEditorIndex: index });
    return editor;
  }

  /** Makes `candidate` (or the editor that `matches` it) the active editor. */
  setActive(candidate: EditorInput): EditorInput | undefined {
    const editor = this.findEditor(candidate)?.[0];
    if (!editor) {
      return undefined;
    }
    if (this.active === editor) {
      return editor;
    }
    this.active = editor;
    this.mru.splice(this.mru.indexOf(editor), 1);
    this.mru.unshift(editor);
    this.fire(GroupModelChangeKind.EDITOR_ACTIVE, editor);
    return editor;
  }

  /**
   * The group as data. Each editor is written by `writeEditor`, by default the serializer registered
   * for its `typeId`; an editor it writes no string for, or that throws, is left out of `editors` and
   * `mru` alike.
   */
  serialize(writeEditor: EditorInputWriter = serializeEditorInput): ISerializedEditorGroupModel {
    const serialized = new Map<EditorInput, number>();
    const editors: ISerializedEditorInput[] = [];
    for (const editor of this.editors) {
      try {
        const value = writeEditor(editor);
        if (typeof value === 'string') {
          serialized.set(editor, editors.length);
          editors.push({ id: editor.typeId, value });
        }
      } catch {
        console.warn('Could not save editor.', { key: 'editorpart.state', groupId: this.id, typeId: editor.typeId });
      }
    }
    const mru = this.mru.filter(editor => serialized.has(editor)).map(editor => serialized.get(editor)!);
    return { id: this.id, editors, mru };
  }

  private insertEditor(editor: EditorInput, index: number): void {
    this.editors.splice(index, 0, editor);
    // A new editor that does not become active is the least recently used one.
    this.mru.push(editor);
    this.editorListeners.set(editor, combinedDisposable(
      editor.onDidChangeDirty(() => this.fire(GroupModelChangeKind.EDITOR_DIRTY, editor)),
      editor.onDidChangeLabel(() => this.fire(GroupModelChangeKind.EDITOR_LABEL, editor)),
      editor.onWillDispose(() => this.fire(GroupModelChangeKind.EDITOR_WILL_DISPOSE, editor)),
    ));
    this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_OPEN, editor, editorIndex: index });
  }

  private defaultOpenIndex(): number {
    const activeIndex = this.indexOf(this.active);
    switch (this.getOptions().openPositioning) {
      case 'first': return 0;
      case 'last': return this.editors.length;
      case 'left': return activeIndex === -1 ? 0 : activeIndex;
      case 'right': return activeIndex === -1 ? this.editors.length : activeIndex + 1;
    }
  }

  private nextActiveAfterClose(closing: EditorInput, index: number): EditorInput | undefined {
    if (this.editors.length < 2) {
      return undefined;
    }
    if (this.getOptions().focusRecentEditorAfterClose) {
      return this.mru.find(editor => editor !== closing);
    }
    // The neighbour: the next tab, or the previous one when the last tab closes.
    return index === this.editors.length - 1 ? this.editors[index - 1] : this.editors[index + 1];
  }

  private clampIndex(index: number, max: number): number {
    return Number.isFinite(index) ? Math.max(0, Math.min(Math.trunc(index), max)) : max;
  }

  private fire(kind: GroupModelChangeKind, editor: EditorInput): void {
    this._onDidModelChange.fire({ kind, editor, editorIndex: this.indexOf(editor) });
  }

  override dispose(): void {
    for (const listener of this.editorListeners.values()) {
      listener.dispose();
    }
    this.editorListeners.clear();
    super.dispose();
  }
}
