import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { combinedDisposable, Disposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorsOrder, GroupModelChangeKind } from '../editor.js';
import type { GroupIdentifier, IEditorFactoryRegistry } from '../editor.js';
import type { EditorInput } from './editorInput.js';

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
  readonly openPositioning: 'left' | 'right' | 'first' | 'last';
  readonly focusRecentEditorAfterClose: boolean;
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

  /** Increasing and never reused, across every model of the page. */
  readonly id: GroupIdentifier = ++groupIds;

  private editors: EditorInput[] = [];
  private mru: EditorInput[] = [];
  private active: EditorInput | null = null;
  private readonly editorListeners = new Map<EditorInput, IDisposable>();

  constructor(private readonly getOptions: () => IEditorGroupModelOptions = () => DEFAULT_MODEL_OPTIONS) {
    super();
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
    this.editors.splice(index, 0, candidate);
    // A new editor that does not become active is the least recently used one.
    this.mru.push(candidate);
    this.editorListeners.set(candidate, combinedDisposable(
      candidate.onDidChangeDirty(() => this.fire(GroupModelChangeKind.EDITOR_DIRTY, candidate)),
      candidate.onDidChangeLabel(() => this.fire(GroupModelChangeKind.EDITOR_LABEL, candidate)),
      candidate.onWillDispose(() => this.fire(GroupModelChangeKind.EDITOR_WILL_DISPOSE, candidate)),
    ));
    this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_OPEN, editor: candidate, editorIndex: index });
    if (makeActive) {
      this.setActive(candidate);
    }
    return { editor: candidate, isNew: true };
  }

  /**
   * Closes `candidate` (or the editor that `matches` it). Closing the active editor activates the
   * most recently used one that is left (with `focusRecentEditorAfterClose` off, the neighbour), or
   * nothing once the group is empty. The new active editor is reported before the close.
   */
  closeEditor(candidate: EditorInput): IEditorCloseResult | undefined {
    const found = this.findEditor(candidate);
    if (!found) {
      return undefined;
    }
    const [editor, index] = found;
    if (this.active === editor) {
      this.active = null;
      const next = this.nextActiveAfterClose(editor, index);
      if (next) {
        this.setActive(next);
      } else {
        this._onDidModelChange.fire({ kind: GroupModelChangeKind.EDITOR_ACTIVE });
      }
    }
    this.editors.splice(index, 1);
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
   * The group as data. Each editor is written by the serializer registered for its `typeId`; an
   * editor without one, or whose serializer declines it, is left out of `editors` and `mru` alike.
   */
  serialize(): ISerializedEditorGroupModel {
    const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;
    const serialized = new Map<EditorInput, number>();
    const editors: ISerializedEditorInput[] = [];
    for (const editor of this.editors) {
      const serializer = registry.getEditorSerializer(editor);
      const value = serializer?.canSerialize(editor) ? serializer.serialize(editor) : undefined;
      if (typeof value === 'string') {
        serialized.set(editor, editors.length);
        editors.push({ id: editor.typeId, value });
      }
    }
    const mru = this.mru.filter(editor => serialized.has(editor)).map(editor => serialized.get(editor)!);
    return { id: this.id, editors, mru };
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
