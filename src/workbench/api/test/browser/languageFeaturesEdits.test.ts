// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { checkTextEdits, createMainThreadEdits, toRenameEdits, toRenameLocation } from '../../browser/mainThreadLanguageFeaturesEdits.js';
import { CodeActionKind } from '../../common/extHostCommonTypes.js';
import { Diagnostic, DiagnosticSeverity, DiagnosticTag } from '../../common/extHostDiagnosticTypes.js';
import { Position, Range, Selection, TextEdit, WorkspaceEdit } from '../../common/extHostEditorTypes.js';
import { createEditsGroup } from '../../common/extHostLanguageFeaturesEdits.js';
import type { ExtHostEdits } from '../../common/extHostLanguageFeaturesEdits.js';
import { CodeAction, CodeActionTriggerKind } from '../../common/extHostLanguageFeatureTypes.js';
import { Uri } from '../../common/extHostTypes.js';
import { createLanguageFeatureTestHost, settle, testModel, workspaceUri } from './languageFeaturesTestHost.js';

/*
 * Formatting, code actions and rename: the extension host's group and the workbench's group over the
 * real RPC, Monaco faked, the bulk edit faked on the workbench side. Each test names the failure it catches.
 */

const resource = workspaceUri('a.lft');
const other = workspaceUri('b.lft');
const closed = workspaceUri('c.lft');
const lines = ['alpha  beta', 'call(one, two)', 'last'];
const model = (version = 3) => testModel(resource, lines.join('\n'), { language: 'lftest', version }) as ReturnType<typeof testModel> & { bumpVersion(): void };
const token = () => new CancellationTokenSource().token;
const options = { tabSize: 2, insertSpaces: false };

type Host = Awaited<ReturnType<typeof createLanguageFeatureTestHost>>;
let host: Host | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  host = await createLanguageFeatureTestHost({
    hostGroups: [createEditsGroup], mainGroups: [createMainThreadEdits],
    documents: [
      { uri: resource, text: lines.join('\n'), language: 'lftest', version: 3 },
      { uri: other, text: 'uses alpha', language: 'lftest', version: 7 },
    ],
  });
  const group = host.host.groups[0] as ExtHostEdits;
  return { ...host, group, languages: (key = '1') => host!.api(key) };
}

const provider = (kind: string, index = 0) => host!.of(kind)[index].provider;

// --- Formatting ------------------------------------------------------------------------------------

test('range formatting: the provider gets the range and the options, Monaco gets its edits, also those outside the range', async () => {
  const { languages } = await setup();
  const provide = vi.fn((_document: vscode.TextDocument, _range: vscode.Range, _options: vscode.FormattingOptions) => [
    TextEdit.replace(new Range(0, 5, 0, 7), ' '),
    // Outside the selected range: the provider's business, applied as it is (as in VS Code).
    TextEdit.insert(new Position(2, 0), '// '),
  ]);
  languages().registerDocumentRangeFormattingEditProvider('lftest', { provideDocumentRangeFormattingEdits: provide });
  await settle();
  const range = provider('DocumentRangeFormattingEditProvider');
  // Without a display name in its manifest, the extension's identifier.
  expect(range.displayName).toBe('test.first');
  expect(range.provideDocumentRangesFormattingEdits).toBeUndefined();
  const edits = await range.provideDocumentRangeFormattingEdits(model(), { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 12 }, options, token());
  expect(edits).toEqual([
    { range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 }, text: ' ' },
    { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '// ' },
  ]);
  expect(provide.mock.calls[0][1]).toEqual(new Range(0, 0, 0, 11));
  expect(provide.mock.calls[0][2]).toEqual({ tabSize: 2, insertSpaces: false });
});

test('several ranges go to a provider that formats ranges; document and on-type formatting answer too', async () => {
  const { languages } = await setup();
  const ranges = vi.fn((_document: vscode.TextDocument, _ranges: vscode.Range[]) => [TextEdit.delete(new Range(0, 5, 0, 6))]);
  languages().registerDocumentRangeFormattingEditProvider('lftest', {
    provideDocumentRangeFormattingEdits: () => [], provideDocumentRangesFormattingEdits: ranges,
  });
  languages('2').registerDocumentFormattingEditProvider('lftest', {
    provideDocumentFormattingEdits: () => [TextEdit.setEndOfLine(2), TextEdit.replace(new Range(1, 0, 1, 4), 'CALL')],
  });
  const onType = vi.fn((_document: vscode.TextDocument, _position: vscode.Position, _ch: string) => [TextEdit.insert(new Position(1, 14), ';')]);
  languages().registerOnTypeFormattingEditProvider('lftest', { provideOnTypeFormattingEdits: onType }, ')', ';', 7 as never);
  await settle();
  const rangeProvider = provider('DocumentRangeFormattingEditProvider');
  await expect(rangeProvider.provideDocumentRangesFormattingEdits(model(), [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 5 },
  ], options, token())).resolves.toEqual([{ range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 7 }, text: '' }]);
  expect(ranges.mock.calls[0][1]).toEqual([new Range(0, 0, 0, 2), new Range(2, 0, 2, 4)]);

  const documentProvider = provider('DocumentFormattingEditProvider');
  expect(documentProvider.displayName).toBe('test.second');
  // Monaco's end of line sequence: CRLF is 1.
  await expect(documentProvider.provideDocumentFormattingEdits(model(), options, token())).resolves.toEqual([
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: '', eol: 1 },
    { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, text: 'CALL' },
  ]);

  const typing = provider('OnTypeFormattingEditProvider');
  expect(typing.autoFormatTriggerCharacters).toEqual([')', ';']);
  await expect(typing.provideOnTypeFormattingEdits(model(), { lineNumber: 2, column: 15 }, ')', options, token())).resolves.toEqual([
    { range: { startLineNumber: 2, startColumn: 15, endLineNumber: 2, endColumn: 15 }, text: ';' },
  ]);
  expect(onType.mock.calls[0].slice(1, 3)).toEqual([new Position(1, 14), ')']);
});

test('a slow formatter\'s edits are dropped when the model changed while it worked', async () => {
  const { languages } = await setup();
  let answer!: (edits: vscode.TextEdit[]) => void;
  languages().registerDocumentFormattingEditProvider('lftest', {
    provideDocumentFormattingEdits: () => new Promise<vscode.TextEdit[]>(resolve => { answer = resolve; }),
  });
  await settle();
  const typed = model();
  const pending = provider('DocumentFormattingEditProvider').provideDocumentFormattingEdits(typed, options, token());
  await settle();
  // The user types before the formatter answers.
  typed.bumpVersion();
  answer([TextEdit.replace(new Range(0, 0, 0, 5), 'ALPHA')]);
  await expect(pending).resolves.toBeUndefined();
});

test('formatting edits computed for another version than the one Monaco asked at are dropped', async () => {
  const { languages } = await setup();
  languages().registerDocumentFormattingEditProvider('lftest', { provideDocumentFormattingEdits: () => [TextEdit.replace(new Range(0, 0, 0, 5), 'ALPHA')] });
  await settle();
  const format = provider('DocumentFormattingEditProvider');
  // The extension host's copy is at version 3.
  await expect(format.provideDocumentFormattingEdits(model(2), options, token())).resolves.toBeUndefined();
  await expect(format.provideDocumentFormattingEdits(model(3), options, token())).resolves.toHaveLength(1);
});

test('Format Selection run as a command keeps the editor.action bridge: the active pane\'s editor, the caller\'s argument, an error without an editor', async () => {
  const run = vi.fn(async () => undefined);
  const control = { getModel: () => ({}), getAction: (id: string) => (id === 'editor.action.formatSelection' ? { run } : null) };
  const accessor = (pane: unknown) => ({
    get: (id: unknown) => (id === ICodeEditorService ? { getFocusedCodeEditor: () => null } : id === IEditorService ? { activeEditorPane: pane } : undefined),
  }) as unknown as ServicesAccessor;
  const handler = CommandsRegistry.getCommand('editor.action.formatSelection')!.handler;
  // An extension runs it while focus is outside the editor (a tree view, a webview).
  await handler(accessor({ getControl: () => control }), { reason: 'caller' });
  expect(run).toHaveBeenCalledWith({ reason: 'caller' });
  await expect(handler(accessor(undefined))).rejects.toThrow("command 'editor.action.formatSelection' not found");
});

test('formatting edits from the extension host are checked before Monaco applies them', () => {
  expect(checkTextEdits([
    { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'reversed' },
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 3 },
    { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'x', eol: 5 },
  ])).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'x' }]);
  expect(checkTextEdits('no')).toBeUndefined();
});

// --- Code actions ----------------------------------------------------------------------------------

/** A marker as Monaco's marker service holds it: the code's target is Monaco's URI. */
const marker = {
  owner: 'fixture', resource: { scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace/a.lft', query: '', fragment: '' },
  severity: 4, message: 'Double space', source: 'fixture-lint',
  code: { value: 'FX1', target: { scheme: 'https', authority: 'example.test', path: '/rules/FX1', query: '', fragment: '' } },
  startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8, tags: [1],
};

async function codeActions(range: object = { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 }, context: object = { markers: [marker], trigger: 2 }, cancel = token()) {
  return provider('CodeActionProvider').provideCodeActions(model(), range, context, cancel);
}

/** A provider that fixes its own diagnostic, found by source and code, and offers a command too. */
function fixingProvider(fix: (diagnostic: vscode.Diagnostic) => CodeAction): vscode.CodeActionProvider {
  return {
    provideCodeActions: (document, _range, context) => context.diagnostics
      .filter(diagnostic => diagnostic.source === 'fixture-lint' && typeof diagnostic.code === 'object' && diagnostic.code.value === 'FX1')
      .map(fix),
  };
}

test('the context\'s diagnostics are Monaco\'s markers with source, code and its link, range, message, severity and tags as they were', async () => {
  const { languages } = await setup();
  const provide = vi.fn((_document: vscode.TextDocument, _range: vscode.Range | vscode.Selection, _context: vscode.CodeActionContext): CodeAction[] => []);
  languages().registerCodeActionsProvider('lftest', { provideCodeActions: provide });
  await settle();
  await codeActions({ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8, selectionStartLineNumber: 1, selectionStartColumn: 8, positionLineNumber: 1, positionColumn: 6 },
    { markers: [marker, { ...marker, message: '' }], only: 'quickfix', trigger: 1 });
  const [, range, context] = provide.mock.calls[0];
  expect(range).toBeInstanceOf(Selection);
  expect([(range as vscode.Selection).anchor, (range as vscode.Selection).active]).toEqual([new Position(0, 7), new Position(0, 5)]);
  expect(context.triggerKind).toBe(CodeActionTriggerKind.Invoke);
  expect(context.only?.value).toBe('quickfix');
  expect(context.only?.contains(CodeActionKind.QuickFix.append('fixture'))).toBe(true);
  expect(context.diagnostics).toHaveLength(1);
  const [diagnostic] = context.diagnostics;
  expect(diagnostic).toBeInstanceOf(Diagnostic);
  expect(diagnostic).toMatchObject({
    message: 'Double space', source: 'fixture-lint', severity: DiagnosticSeverity.Warning, range: new Range(0, 5, 0, 7), tags: [DiagnosticTag.Unnecessary],
  });
  const code = diagnostic.code as { value: string; target: vscode.Uri };
  expect(code.value).toBe('FX1');
  expect(code.target.toString()).toBe('https://example.test/rules/FX1');
});

test('a quick fix is listed with its kind, preference, diagnostics and reason; picking it applies its edit, then its command', async () => {
  const { languages, run, bulkEdits, executed } = await setup();
  const callback = () => 'kept';
  languages().registerCodeActionsProvider('lftest', fixingProvider(diagnostic => {
    const fix = new CodeAction('Use one space', CodeActionKind.QuickFix.append('fixture'));
    fix.edit = new WorkspaceEdit();
    fix.edit.replace(Uri.from(resource) as vscode.Uri, diagnostic.range, ' ');
    fix.diagnostics = [diagnostic];
    fix.isPreferred = true;
    fix.command = { command: 'fixture.fixed', title: 'Fixed', arguments: [{ callback }, 2] };
    return fix;
  }), { providedCodeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll.append('fixture')] });
  languages('2').registerCodeActionsProvider('lftest', {
    provideCodeActions: () => {
      const disabled = new CodeAction('Rewrite the line', CodeActionKind.RefactorRewrite);
      disabled.disabled = { reason: 'Nothing to rewrite here' };
      return [disabled, { command: 'fixture.plain', title: 'Plain command' }];
    },
  });
  await settle();
  expect(host!.of('CodeActionProvider')[0].args[0]).toEqual({ providedCodeActionKinds: ['quickfix', 'source.fixAll.fixture'], documentation: undefined });
  const list = await codeActions();
  expect(list.actions).toHaveLength(1);
  const [fix] = list.actions;
  expect(fix).toMatchObject({ title: 'Use one space', kind: 'quickfix.fixture', isPreferred: true });
  expect(fix.diagnostics).toEqual([expect.objectContaining({ message: 'Double space', source: 'fixture-lint', code: { value: 'FX1', target: expect.anything() } })]);
  // Monaco never gets the edit: it would bypass the bulk edit.
  expect(fix.edit).toBeUndefined();
  const others = await provider('CodeActionProvider', 1).provideCodeActions(model(), { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, { markers: [], trigger: 1 }, token());
  expect(others.actions.map((action: { title: string; disabled?: string; kind?: string }) => [action.title, action.disabled, action.kind])).toEqual([
    ['Rewrite the line', 'Nothing to rewrite here', 'refactor.rewrite'], ['Plain command', undefined, undefined],
  ]);

  let executedAtEdit = -1;
  bulkEdits.answer = () => {
    executedAtEdit = executed.length;
    return true;
  };
  await run(fix.command);
  await settle();
  expect(executedAtEdit).toBe(0);
  expect(bulkEdits.calls).toHaveLength(1);
  const [call] = bulkEdits.calls;
  expect(call.extension).toBe('1');
  expect(call.isRefactoring).toBe(true);
  // At the version the document had when the provider was asked.
  expect(call.operations).toEqual([{
    kind: 'text', uri: resource, version: 3,
    edit: { operations: [{ range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 8 }, text: ' ' }], eol: undefined },
  }]);
  expect(executed).toEqual([{ extension: '1', id: 'fixture.fixed', args: [{ callback }, 2] }]);

  // A plain command only runs.
  await run(others.actions[1].command);
  await settle();
  expect(bulkEdits.calls).toHaveLength(1);
  expect(executed[1]).toEqual({ extension: '2', id: 'fixture.plain', args: [] });
});

test('when the edit is refused, the command does not run and the user is told', async () => {
  const { languages, run, bulkEdits, executed, warnings } = await setup();
  languages().registerCodeActionsProvider('lftest', fixingProvider(diagnostic => {
    const fix = new CodeAction('Use one space', CodeActionKind.QuickFix);
    fix.edit = new WorkspaceEdit();
    fix.edit.replace(Uri.from(resource) as vscode.Uri, diagnostic.range, ' ');
    fix.command = { command: 'fixture.fixed', title: 'Fixed' };
    return fix;
  }));
  await settle();
  const list = await codeActions();
  bulkEdits.answer = () => false;
  await run(list.actions[0].command);
  await settle();
  expect(bulkEdits.calls).toHaveLength(1);
  expect(executed).toEqual([]);
  expect(warnings).toEqual([expect.stringContaining('could not be applied')]);
});

test('an action without an edit is resolved when picked, and its resolved edit and command apply', async () => {
  const { languages, run, bulkEdits, executed } = await setup();
  const resolve = vi.fn((action: CodeAction) => {
    action.edit = new WorkspaceEdit();
    action.edit.insert(Uri.from(resource) as vscode.Uri, new Position(2, 0), '// ');
    action.command = { command: 'fixture.resolved', title: 'Resolved' };
    return action;
  });
  languages().registerCodeActionsProvider('lftest', {
    provideCodeActions: () => [new CodeAction('Comment out', CodeActionKind.RefactorRewrite)],
    resolveCodeAction: resolve,
  });
  await settle();
  const list = await codeActions();
  // Monaco is not asked to resolve: applying does.
  expect(provider('CodeActionProvider').resolveCodeAction).toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
  await run(list.actions[0].command);
  await settle();
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(bulkEdits.calls[0].operations[0]).toMatchObject({ kind: 'text', uri: resource, version: 3 });
  expect(executed).toEqual([{ extension: '1', id: 'fixture.resolved', args: [] }]);
});

test('the extension host keeps a list until Monaco disposes it; a late list is not kept', async () => {
  const { languages, group } = await setup();
  const source = new CancellationTokenSource();
  let cancelOnAnswer = false;
  languages().registerCodeActionsProvider('lftest', {
    provideCodeActions: () => {
      if (cancelOnAnswer) {
        source.cancel();
      }
      return [new CodeAction('One', CodeActionKind.QuickFix)];
    },
  });
  await settle();
  const first = await codeActions();
  const second = await codeActions();
  expect(group.cacheSize).toBe(2);
  await expect(CommandsRegistry.getCommand('_workbench.languageFeatures.codeActionCacheSize')!.handler(undefined as never)).resolves.toBe(2);
  first.dispose();
  first.dispose();
  second.dispose();
  await settle();
  expect(group.cacheSize).toBe(0);
  await expect(CommandsRegistry.getCommand('_workbench.languageFeatures.codeActionCacheSize')!.handler(undefined as never)).resolves.toBe(0);
  cancelOnAnswer = true;
  await expect(codeActions(undefined, undefined, source.token)).resolves.toBeUndefined();
  await settle();
  expect(group.cacheSize).toBe(0);
});

test('a removed extension\'s actions leave Monaco and the extension host; an old pick does nothing', async () => {
  const { languages, group, features, run, bulkEdits, executed, of } = await setup();
  languages().registerCodeActionsProvider('lftest', {
    provideCodeActions: () => {
      const action = new CodeAction('One', CodeActionKind.QuickFix);
      action.command = { command: 'fixture.one', title: 'One' };
      return [action];
    },
  });
  await settle();
  const list = await codeActions();
  const command = list.actions[0].command;
  features.release('1');
  group.release('1');
  await settle();
  expect(of('CodeActionProvider')).toHaveLength(0);
  expect(group.cacheSize).toBe(0);
  await run(command);
  await settle();
  expect([bulkEdits.calls, executed]).toEqual([[], []]);
});

test('documentation commands of the metadata reach Monaco and run on the extension host', async () => {
  const { languages, run, executed, features } = await setup();
  const registration = languages().registerCodeActionsProvider('lftest', { provideCodeActions: () => [] }, {
    providedCodeActionKinds: [CodeActionKind.Refactor],
    documentation: [{ kind: CodeActionKind.Refactor, command: { command: 'fixture.docs', title: 'Learn more', arguments: ['refactor'] } }],
  });
  await settle();
  const metadata = host!.of('CodeActionProvider')[0].args[0] as { documentation: { kind: string; command: { title: string } }[] };
  expect(metadata.documentation).toMatchObject([{ kind: 'refactor', command: { title: 'Learn more' } }]);
  await run(metadata.documentation[0].command as never);
  await settle();
  expect(executed).toEqual([{ extension: '1', id: 'fixture.docs', args: ['refactor'] }]);
  registration.dispose();
  await settle();
  expect(features.commandCount).toBe(0);
});

// --- Rename ----------------------------------------------------------------------------------------

test('rename edits both documents through the bulk edit, each at the version it was asked for, as a refactoring', async () => {
  const { languages, bulkEdits } = await setup();
  languages().registerRenameProvider('lftest', {
    provideRenameEdits: (document, position, newName) => {
      const range = document.getWordRangeAtPosition(position)!;
      const edit = new WorkspaceEdit();
      edit.replace(document.uri, range, newName);
      edit.replace(Uri.from(other) as vscode.Uri, new Range(0, 5, 0, 10), newName);
      edit.replace(Uri.from(closed) as vscode.Uri, new Range(0, 0, 0, 5), newName);
      return edit;
    },
  });
  await settle();
  const rename = provider('RenameProvider');
  expect(rename.resolveRenameLocation).toBeUndefined();
  await expect(rename.provideRenameEdits(model(), { lineNumber: 1, column: 3 }, 'omega', token())).resolves.toEqual({ edits: [] });
  expect(bulkEdits.calls).toHaveLength(1);
  expect(bulkEdits.calls[0].isRefactoring).toBe(true);
  expect(bulkEdits.calls[0].operations.map(operation => operation.kind === 'text' && [operation.uri.toString(), operation.version, operation.edit.operations[0]])).toEqual([
    [resource.toString(), 3, { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'omega' }],
    [other.toString(), 7, { range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 11 }, text: 'omega' }],
    // A file the extension host has no copy of is opened by the bulk edit, at whatever version.
    [closed.toString(), undefined, { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'omega' }],
  ]);
});

test('a rename the bulk edit refuses, or one cancelled before it applied, says so and applies nothing', async () => {
  const { languages, bulkEdits } = await setup();
  let answer!: (edit: vscode.WorkspaceEdit) => void;
  languages().registerRenameProvider('lftest', {
    provideRenameEdits: (document, position, newName) => {
      const edit = new WorkspaceEdit();
      edit.replace(document.uri, document.getWordRangeAtPosition(position)!, newName);
      return answer ? new Promise<vscode.WorkspaceEdit>(resolve => { answer = resolve; }) : edit;
    },
  });
  await settle();
  const rename = provider('RenameProvider');
  bulkEdits.answer = () => false;
  const refused = await rename.provideRenameEdits(model(), { lineNumber: 1, column: 3 }, 'omega', token());
  expect(refused).toEqual({ edits: [], rejectReason: expect.stringContaining('could not be applied') });

  bulkEdits.answer = () => true;
  answer = () => {};
  const source = new CancellationTokenSource();
  const pending = rename.provideRenameEdits(model(), { lineNumber: 1, column: 3 }, 'omega', source.token);
  await settle();
  source.cancel();
  await settle();
  const edit = new WorkspaceEdit();
  edit.replace(Uri.from(resource) as vscode.Uri, new Range(0, 0, 0, 5), 'late');
  answer(edit);
  await expect(pending).resolves.toBeUndefined();
  await settle();
  expect(bulkEdits.calls).toHaveLength(1);
});

test('prepareRename: its range and placeholder reach Monaco, a bare range takes its text, a thrown message is the refusal', async () => {
  const { languages } = await setup();
  let answer: () => unknown = () => ({ range: new Range(0, 0, 0, 5), placeholder: 'the alpha' });
  const provideRenameEdits = vi.fn(() => undefined);
  languages().registerRenameProvider('lftest', { provideRenameEdits, prepareRename: () => answer() as never });
  await settle();
  const rename = provider('RenameProvider');
  const at = { lineNumber: 1, column: 3 };
  await expect(rename.resolveRenameLocation(model(), at, token())).resolves.toEqual({
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'the alpha',
  });
  answer = () => new Range(1, 0, 1, 4);
  await expect(rename.resolveRenameLocation(model(), { lineNumber: 2, column: 2 }, token())).resolves.toEqual({
    range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 5 }, text: 'call',
  });
  answer = () => {
    throw new Error('You cannot rename this element.');
  };
  await expect(rename.resolveRenameLocation(model(), at, token())).resolves.toMatchObject({ rejectReason: 'You cannot rename this element.' });
  // A range off the position's line is ignored: Monaco takes the word.
  answer = () => new Range(2, 0, 2, 4);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(rename.resolveRenameLocation(model(), at, token())).resolves.toBeUndefined();
  // A provider that refuses the edits themselves.
  provideRenameEdits.mockImplementation(() => {
    throw new Error('Not here.');
  });
  await expect(rename.provideRenameEdits(model(), at, 'x', token())).resolves.toEqual({ edits: [], rejectReason: 'Not here.' });
  provideRenameEdits.mockImplementation(() => undefined);
  await expect(rename.provideRenameEdits(model(), at, 'x', token())).resolves.toBeUndefined();
});

test('what the extension host sends about a rename is checked', () => {
  const at = { lineNumber: 1, column: 2 };
  expect(toRenameEdits({ applied: 'yes' } as never)).toBeUndefined();
  expect(toRenameEdits({ rejectReason: 3 } as never)).toBeUndefined();
  expect(toRenameLocation({ range: { startLineNumber: 0, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'x' }, at)).toBeUndefined();
  expect(toRenameLocation({ rejectReason: 'No.' }, at)).toEqual({
    range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 2 }, text: '', rejectReason: 'No.',
  });
});

test('providers are checked when registered; the API classes are plain', async () => {
  class ProtocolCodeAction extends CodeAction {
    data = 'kept';
  }
  const action = new ProtocolCodeAction('Fix', CodeActionKind.QuickFix);
  expect([action.title, action.kind?.value, action.data]).toEqual(['Fix', 'quickfix', 'kept']);
  const { languages } = await setup();
  expect(() => languages().registerCodeActionsProvider('lftest', {} as never)).toThrow(TypeError);
  expect(() => languages().registerRenameProvider('lftest', { prepareRename: () => undefined } as never)).toThrow(TypeError);
  expect(() => languages().registerDocumentFormattingEditProvider(7 as never, { provideDocumentFormattingEdits: () => [] })).toThrow(TypeError);
});
