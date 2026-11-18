import { expect, test } from 'vitest';
import type { Dimension } from '../../../../../base/browser/dom.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { DEFAULT_EDITOR_MIN_DIMENSIONS } from '../../../../browser/parts/editor/editor.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

class TestInput extends EditorInput {
  constructor(private readonly type: string) { super(); }
  override get typeId(): string { return this.type; }
  override get resource(): undefined { return undefined; }
}

class FirstPane extends EditorPane {
  constructor() { super('test.firstPane'); }
  protected createEditor(): void {}
  layout(_dimension: Dimension): void {}
}

class SecondPane extends EditorPane {
  constructor() { super('test.secondPane'); }
  protected createEditor(): void {}
  layout(_dimension: Dimension): void {}
}

const registry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;

test('returns the pane registered for an input type and nothing for others', () => {
  const first = EditorPaneDescriptor.create(FirstPane, 'test.firstPane', 'First');
  const second = EditorPaneDescriptor.create(SecondPane, 'test.secondPane', 'Second');
  const registrations = [
    registry.registerEditorPane(first, ['test.a', 'test.b']),
    registry.registerEditorPane(second, ['test.c']),
  ];
  try {
    expect(registry.getEditorPane(new TestInput('test.a'))).toBe(first);
    expect(registry.getEditorPane(new TestInput('test.b'))).toBe(first);
    expect(registry.getEditorPane(new TestInput('test.c'))).toBe(second);
    expect(registry.getEditorPane(new TestInput('test.unknown'))).toBeUndefined();
    expect(registry.getEditorPaneByType('test.secondPane')).toBe(second);

    const pane = second.instantiate(new InstantiationService());
    expect(pane).toBeInstanceOf(SecondPane);
    expect(second.describes(pane)).toBe(true);
    expect(first.describes(pane)).toBe(false);
    expect([pane.minimumWidth, pane.minimumHeight])
      .toEqual([DEFAULT_EDITOR_MIN_DIMENSIONS.width, DEFAULT_EDITOR_MIN_DIMENSIONS.height]);
  } finally {
    registrations.forEach(registration => registration.dispose());
  }
  expect(registry.getEditorPane(new TestInput('test.a'))).toBeUndefined();
});

test('refuses a second pane for an input type', () => {
  const first = EditorPaneDescriptor.create(FirstPane, 'test.firstPane', 'First');
  const second = EditorPaneDescriptor.create(SecondPane, 'test.secondPane', 'Second');
  const registration = registry.registerEditorPane(first, ['test.taken']);
  try {
    expect(() => registry.registerEditorPane(second, ['test.free', 'test.taken'])).toThrow('test.taken');
    expect(registry.getEditorPane(new TestInput('test.free'))).toBeUndefined();
    expect(registry.getEditorPane(new TestInput('test.taken'))).toBe(first);
  } finally {
    registration.dispose();
  }
});

test('creates its DOM once and forgets the input on clearInput', async () => {
  const pane = new FirstPane();
  const parent = document.createElement('div');
  pane.create(parent);
  expect(pane.getContainer()).toBe(parent);
  expect(() => pane.create(parent)).toThrow('already created');
  const input = new TestInput('test.a');
  await pane.setInput(input, undefined);
  expect(pane.input).toBe(input);
  pane.clearInput();
  expect(pane.input).toBeUndefined();
});
