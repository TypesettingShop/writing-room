import { afterEach, describe, expect, test } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorsOrder, GroupModelChangeKind } from '../../../common/editor.js';
import type { IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import type { IEditorGroupModelOptions, IGroupModelChangeEvent } from '../../../common/editor/editorGroupModel.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

class TestInput extends EditorInput {
  constructor(readonly name: string, private readonly type = 'test.groupModelInput') { super(); }
  override get typeId(): string { return this.type; }
  override get resource(): undefined { return undefined; }
  override getName(): string { return this.name; }
  /** Inputs with the same name open the same thing. */
  override matches(other: EditorInput): boolean { return other instanceof TestInput && other.name === this.name; }
  fireDirty(): void { this._onDidChangeDirty.fire(); }
  fireLabel(): void { this._onDidChangeLabel.fire(); }
}

const disposables = new DisposableStore();
afterEach(() => disposables.clear());

function createModel(options?: Partial<IEditorGroupModelOptions>): { model: EditorGroupModel; events: IGroupModelChangeEvent[] } {
  const model = disposables.add(new EditorGroupModel(() => ({ openPositioning: 'right', focusRecentEditorAfterClose: true, ...options })));
  const events: IGroupModelChangeEvent[] = [];
  model.onDidModelChange(event => events.push(event));
  return { model, events };
}

const names = (editors: readonly EditorInput[]) => editors.map(editor => (editor as TestInput).name);

describe('opening', () => {
  test('a matching input activates the editor already open instead of adding a second tab', () => {
    const { model, events } = createModel();
    const a = new TestInput('a');
    const b = new TestInput('b');
    model.openEditor(a);
    model.openEditor(b);
    events.length = 0;

    const result = model.openEditor(new TestInput('a'));
    expect(result).toEqual({ editor: a, isNew: false });
    expect(model.count).toBe(2);
    expect(model.activeEditor).toBe(a);
    expect(events.map(event => event.kind)).toEqual([GroupModelChangeKind.EDITOR_ACTIVE]);
  });

  test('a new editor goes to the right of the active editor and becomes active', () => {
    const { model, events } = createModel();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => new TestInput(name));
    model.openEditor(a);
    model.openEditor(b);
    model.openEditor(c);
    model.setActive(a);
    events.length = 0;

    model.openEditor(d);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['a', 'd', 'b', 'c']);
    expect(model.activeEditor).toBe(d);
    expect(events).toEqual([
      { kind: GroupModelChangeKind.EDITOR_OPEN, editor: d, editorIndex: 1 },
      { kind: GroupModelChangeKind.EDITOR_ACTIVE, editor: d, editorIndex: 1 },
    ]);
  });

  test('an inactive editor keeps the active one and is the least recently used', () => {
    const { model } = createModel();
    const [a, b, c] = ['a', 'b', 'c'].map(name => new TestInput(name));
    model.openEditor(a);
    model.openEditor(b);
    model.openEditor(c, { active: false, index: 0 });
    expect(model.activeEditor).toBe(b);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['c', 'a', 'b']);
    expect(names(model.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE))).toEqual(['b', 'a', 'c']);
    // An empty group activates the first editor whatever the options say.
    const { model: empty } = createModel();
    empty.openEditor(a, { active: false });
    expect(empty.activeEditor).toBe(a);
  });

  test('the positioning option decides where new editors go', () => {
    for (const [openPositioning, expected] of [
      ['left', ['c', 'a', 'b']], ['first', ['c', 'a', 'b']], ['last', ['a', 'b', 'c']], ['right', ['a', 'c', 'b']],
    ] as const) {
      const { model } = createModel({ openPositioning });
      const [a, b, c] = ['a', 'b', 'c'].map(name => new TestInput(name));
      model.openEditor(a);
      model.openEditor(b, { active: false, index: 1 });
      model.openEditor(c);
      expect(names(model.getEditors(EditorsOrder.SEQUENTIAL)), openPositioning).toEqual(expected);
    }
  });
});

describe('closing', () => {
  test('closing the active editor activates the most recently used one, not its neighbour', () => {
    const { model, events } = createModel();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => new TestInput(name));
    for (const editor of [a, b, c, d]) {
      model.openEditor(editor, { index: model.count });
    }
    model.setActive(a);
    model.setActive(c);
    events.length = 0;

    expect(model.closeEditor(c)).toEqual({ editor: c, editorIndex: 2 });
    // The neighbours are b and d; a was used more recently.
    expect(model.activeEditor).toBe(a);
    expect(events).toEqual([
      { kind: GroupModelChangeKind.EDITOR_ACTIVE, editor: a, editorIndex: 0 },
      { kind: GroupModelChangeKind.EDITOR_CLOSE, editor: c, editorIndex: 2 },
    ]);
    expect(names(model.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE))).toEqual(['a', 'd', 'b']);
  });

  test('without focusRecentEditorAfterClose the neighbour becomes active', () => {
    const { model } = createModel({ focusRecentEditorAfterClose: false });
    const [a, b, c] = ['a', 'b', 'c'].map(name => new TestInput(name));
    for (const editor of [a, b, c]) {
      model.openEditor(editor, { index: model.count });
    }
    model.setActive(a);
    model.setActive(b);
    model.closeEditor(b);
    expect(model.activeEditor).toBe(c);
    model.closeEditor(c);
    expect(model.activeEditor).toBe(a);
  });

  test('closing a background editor keeps the active one', () => {
    const { model, events } = createModel();
    const [a, b] = ['a', 'b'].map(name => new TestInput(name));
    model.openEditor(a);
    model.openEditor(b);
    events.length = 0;
    model.closeEditor(a);
    expect(model.activeEditor).toBe(b);
    expect(events.map(event => event.kind)).toEqual([GroupModelChangeKind.EDITOR_CLOSE]);
  });

  test('closing the last editor leaves no active editor, and an unknown editor closes nothing', () => {
    const { model, events } = createModel();
    const a = new TestInput('a');
    model.openEditor(a);
    events.length = 0;
    expect(model.closeEditor(new TestInput('missing'))).toBeUndefined();
    model.closeEditor(new TestInput('a'));
    expect(model.activeEditor).toBeNull();
    expect(model.count).toBe(0);
    expect(model.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE)).toEqual([]);
    expect(events.map(event => event.kind)).toEqual([GroupModelChangeKind.EDITOR_ACTIVE, GroupModelChangeKind.EDITOR_CLOSE]);
  });

  test('a closed editor no longer reports through the group', () => {
    const { model, events } = createModel();
    const a = new TestInput('a');
    model.openEditor(a);
    a.fireDirty();
    a.fireLabel();
    expect(events.slice(-2).map(event => event.kind)).toEqual([GroupModelChangeKind.EDITOR_DIRTY, GroupModelChangeKind.EDITOR_LABEL]);
    model.closeEditor(a);
    events.length = 0;
    a.fireDirty();
    a.dispose();
    expect(events).toEqual([]);
  });

  test('an editor about to be disposed says so', () => {
    const { model, events } = createModel();
    const a = new TestInput('a');
    model.openEditor(a);
    events.length = 0;
    a.dispose();
    expect(events).toEqual([{ kind: GroupModelChangeKind.EDITOR_WILL_DISPOSE, editor: a, editorIndex: 0 }]);
  });
});

describe('moving', () => {
  test('the target index is the index after the move, in both directions', () => {
    const { model, events } = createModel();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(name => new TestInput(name));
    for (const editor of [a, b, c, d]) {
      model.openEditor(editor, { index: model.count });
    }
    events.length = 0;

    model.moveEditor(a, 2);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['b', 'c', 'a', 'd']);
    expect(model.indexOf(a)).toBe(2);
    expect(events).toEqual([{ kind: GroupModelChangeKind.EDITOR_MOVE, editor: a, editorIndex: 2, oldEditorIndex: 0 }]);

    model.moveEditor(a, 3);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['b', 'c', 'd', 'a']);
    model.moveEditor(d, 0);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['d', 'b', 'c', 'a']);
    // Past the end clamps to the last index.
    model.moveEditor(d, 99);
    expect(names(model.getEditors(EditorsOrder.SEQUENTIAL))).toEqual(['b', 'c', 'a', 'd']);
  });

  test('a move to the same index changes nothing and fires nothing', () => {
    const { model, events } = createModel();
    const [a, b] = ['a', 'b'].map(name => new TestInput(name));
    model.openEditor(a);
    model.openEditor(b);
    events.length = 0;
    model.moveEditor(b, 1);
    expect(events).toEqual([]);
    expect(model.moveEditor(new TestInput('missing'), 0)).toBeUndefined();
  });
});

describe('serializing', () => {
  const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;

  class TestSerializer implements IEditorSerializer {
    canSerialize(editor: EditorInput): boolean { return (editor as TestInput).name !== 'declined'; }
    serialize(editor: EditorInput): string { return (editor as TestInput).name; }
    deserialize(): EditorInput { return new TestInput('restored', 'test.serializable'); }
  }

  test('keeps the group id, the serializable editors in order and their use order', () => {
    disposables.add(registry.registerEditorSerializer('test.serializable', TestSerializer));
    const { model } = createModel();
    const [a, skipped, b, declined, c] = [
      new TestInput('a', 'test.serializable'),
      new TestInput('skipped', 'test.noSerializer'),
      new TestInput('b', 'test.serializable'),
      new TestInput('declined', 'test.serializable'),
      new TestInput('c', 'test.serializable'),
    ];
    for (const editor of [a, skipped, b, declined, c]) {
      model.openEditor(editor, { index: model.count });
    }
    model.setActive(b);
    model.setActive(skipped);

    // No serializer, or one that declines, leaves the editor out instead of throwing.
    const serialized = model.serialize();
    expect(serialized).toEqual({
      id: model.id,
      editors: [
        { id: 'test.serializable', value: 'a' },
        { id: 'test.serializable', value: 'b' },
        { id: 'test.serializable', value: 'c' },
      ],
      // c was opened last, then b and skipped were activated: b is the active serializable editor.
      mru: [1, 2, 0],
    });
    expect(registry.getEditorSerializer('test.serializable')).toBeInstanceOf(TestSerializer);
    expect(() => registry.registerEditorSerializer('test.serializable', TestSerializer)).toThrow('already registered');
  });

  test('group ids increase and are never reused', () => {
    const first = createModel().model;
    const second = createModel().model;
    first.dispose();
    const third = createModel().model;
    expect(second.id).toBeGreaterThan(first.id);
    expect(third.id).toBeGreaterThan(second.id);
  });
});
