import { expect, test, vi } from 'vitest';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MainThreadEditor } from '../../browser/mainThreadEditor.js';
import type { ExtHostEditorsShape } from '../../common/extHost.protocol.documents.js';

test('a selection change reports the VS Code kind of its source once the properties have settled', async () => {
  const cursor = new Emitter<{ source: string }>();
  let column = 1;
  const selections = () => [{ selectionStartLineNumber: 1, selectionStartColumn: 1, positionLineNumber: 1, positionColumn: column }];
  const model = {
    getOptions: () => ({ tabSize: 4, indentSize: 4, insertSpaces: true }),
    onDidChangeOptions: Event.None, onDidChangeContent: Event.None,
  };
  const control = {
    onDidChangeCursorSelection: cursor.event, onDidScrollChange: Event.None, onDidLayoutChange: Event.None,
    onDidChangeConfiguration: Event.None, getSelections: selections, getVisibleRanges: () => [],
    getRawOptions: () => ({}), getModel: () => model,
  };
  const accepted = vi.fn(async (_id: string, _properties: object, _kind?: number) => {});
  const proxy = { $acceptEditorProperties: accepted, $acceptEditorDelta: async () => {} } as ExtHostEditorsShape;
  const editor = new MainThreadEditor('1', control as never, model as never, {} as never, () => 1, proxy);
  try {
    const kinds: Array<number | undefined> = [];
    for (const source of ['keyboard', 'mouse', 'api', 'modelChange', 'restoreState']) {
      column++;
      cursor.fire({ source });
      await editor.whenSettled();
      // The reply that follows the settled promise must come after the properties it waited for.
      const [id, properties, kind] = accepted.mock.lastCall ?? [];
      expect([id, properties]).toEqual(['1', { selections: selections() }]);
      kinds.push(kind);
    }
    expect(kinds).toEqual([1, 2, 3, undefined, undefined]);
  } finally {
    editor.dispose();
    cursor.dispose();
  }
});
