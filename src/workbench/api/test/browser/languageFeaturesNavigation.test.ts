// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test, vi } from 'vitest';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import { OpenerService } from '../../../../platform/opener/browser/openerService.js';
import type { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import {
  checkDocumentSymbols, checkSelectionRanges, checkSemanticTokens, createEditorOpener, createMainThreadNavigation, MainThreadNavigation, trackedProviderCount,
} from '../../browser/mainThreadLanguageFeaturesNavigation.js';
import { createMainThreadCompletions } from '../../browser/mainThreadLanguageFeaturesCompletions.js';
import { createMainThreadEdits } from '../../browser/mainThreadLanguageFeaturesEdits.js';
import { CodeActionKind, MarkdownString } from '../../common/extHostCommonTypes.js';
import { Location, Position, Range, TextEdit, WorkspaceEdit } from '../../common/extHostEditorTypes.js';
import { createCompletionsGroup } from '../../common/extHostLanguageFeaturesCompletions.js';
import { createEditsGroup } from '../../common/extHostLanguageFeaturesEdits.js';
import { createNavigationGroup } from '../../common/extHostLanguageFeaturesNavigation.js';
import type { ExtHostNavigation } from '../../common/extHostLanguageFeaturesNavigation.js';
import {
  CodeAction, CodeLens, Color, ColorInformation, ColorPresentation, CompletionItem, CompletionList, DocumentHighlight, DocumentHighlightKind,
  DocumentLink, DocumentSymbol, FoldingRange, FoldingRangeKind, Hover, InlayHint, InlayHintKind, InlayHintLabelPart, LinkedEditingRanges,
  SelectionRange, SemanticTokens, SemanticTokensBuilder, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensLegend, SymbolInformation,
  SymbolKind, SymbolTag,
} from '../../common/extHostLanguageFeatureTypes.js';
import { Uri } from '../../common/extHostTypes.js';
import { createLanguageFeatureTestHost, settle, testModel, workspaceUri } from './languageFeaturesTestHost.js';

/*
 * The navigation group: the extension host's and the workbench's over the real RPC, Monaco faked. Each
 * test names the failure it catches.
 */

const resource = workspaceUri('a.lft');
const other = workspaceUri('b.lft');
const closed = workspaceUri('c.lft');
const lines = ['# Title', 'alpha beta', '## Inner', 'gamma', 'end'];
const model = () => testModel(resource, lines.join('\n'), { language: 'lftest', version: 1 });
const token = () => new CancellationTokenSource().token;

type Host = Awaited<ReturnType<typeof createLanguageFeatureTestHost>>;
let host: Host | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
  vi.restoreAllMocks();
});

async function setup(options: Parameters<typeof createLanguageFeatureTestHost>[0] = {}) {
  host = await createLanguageFeatureTestHost({
    hostGroups: [createCompletionsGroup, createEditsGroup, createNavigationGroup],
    mainGroups: [createMainThreadCompletions, createMainThreadEdits, createMainThreadNavigation],
    documents: [
      { uri: resource, text: lines.join('\n'), language: 'lftest' },
      { uri: other, text: 'uses alpha', language: 'lftest' },
    ],
    ...options,
  });
  const group = host.host.groups[2] as ExtHostNavigation;
  const languages = (key = '1') => host!.api(key);
  /** Releases an extension as the area does: the seam, then the groups. */
  const release = async (key: string) => {
    host!.features.release(key);
    for (const each of host!.host.groups) {
      each.release?.(key);
    }
    await settle();
  };
  return { ...host, group, languages, release };
}

const provider = (kind: string, index = 0) => host!.of(kind)[index].provider;

/** Runs the Monaco command a resolved link's `command:` URI names, as Monaco's opener does. */
function follow(url: URI) {
  return host!.commands.get(url.path)?.(...JSON.parse(url.query));
}

// --- Document symbols ------------------------------------------------------------------------------

test('document symbols reach the outline as a tree with its depth, ranges 1-based and the selection range inside the range', async () => {
  const { languages } = await setup();
  const inner = new DocumentSymbol('Inner', 'h2', SymbolKind.String, new Range(2, 0, 3, 5), new Range(2, 3, 2, 8));
  const deeper = new DocumentSymbol('Deeper', '', SymbolKind.Key, new Range(3, 0, 3, 5), new Range(3, 0, 3, 5));
  deeper.tags = [SymbolTag.Deprecated];
  inner.children.push(deeper);
  const title = new DocumentSymbol('Title', 'h1', SymbolKind.Module, new Range(0, 0, 4, 3), new Range(0, 2, 0, 7));
  title.children.push(inner);
  languages().registerDocumentSymbolProvider('lftest', { provideDocumentSymbols: () => [title] }, { label: 'Headings' });
  await settle();
  const symbols = provider('DocumentSymbolProvider');
  expect(symbols.displayName).toBe('Headings');
  expect(await symbols.provideDocumentSymbols(model(), token())).toEqual([{
    name: 'Title', detail: 'h1', kind: SymbolKind.Module, tags: [],
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 4 },
    selectionRange: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 8 },
    children: [{
      name: 'Inner', detail: 'h2', kind: SymbolKind.String, tags: [],
      range: { startLineNumber: 3, startColumn: 1, endLineNumber: 4, endColumn: 6 },
      selectionRange: { startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 9 },
      children: [{
        name: 'Deeper', detail: '', kind: SymbolKind.Key, tags: [SymbolTag.Deprecated],
        range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 6 },
        selectionRange: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 6 }, children: [],
      }],
    }],
  }]);
});

test('symbol information becomes a tree by containment, as VS Code builds it', async () => {
  const { languages } = await setup();
  const at = (range: vscode.Range) => new Location(Uri.from(resource) as vscode.Uri, range);
  languages().registerDocumentSymbolProvider('lftest', {
    provideDocumentSymbols: () => [
      new SymbolInformation('Inner', SymbolKind.String, 'Title', at(new Range(2, 0, 3, 5))),
      new SymbolInformation('Title', SymbolKind.String, '', at(new Range(0, 0, 4, 3))),
      new SymbolInformation('Next', SymbolKind.String, new Range(4, 3, 4, 3), Uri.from(resource) as vscode.Uri),
    ],
  });
  await settle();
  const symbols = await provider('DocumentSymbolProvider').provideDocumentSymbols(model(), token());
  const shape = (list: { name: string; children?: unknown[] }[]): unknown => list.map(symbol => [symbol.name, shape((symbol.children ?? []) as never)]);
  expect(shape(symbols)).toEqual([['Title', [['Inner', []], ['Next', []]]]]);
  expect(symbols[0].children[0].containerName).toBe('Title');
});

test('symbols from the extension host are checked: a selection range outside the range, or no name, is dropped', () => {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 5 };
  expect(checkDocumentSymbols([
    { name: 'outside', detail: '', kind: 4, range, selectionRange: { ...range, startLineNumber: 2, endLineNumber: 2 } },
    { name: '', detail: '', kind: 4, range, selectionRange: range },
    { name: 'kept', detail: 3, kind: 99, range, selectionRange: range },
  ])).toEqual([{ name: 'kept', detail: '', kind: 6, tags: [], range, selectionRange: range, children: [] }]);
});

// --- Links -----------------------------------------------------------------------------------------

test('links show with their range and tooltip; following a workspace link opens it at its fragment\'s line, with the extension\'s own commands allowed', async () => {
  const { languages, followed } = await setup();
  languages().registerDocumentLinkProvider('lftest', {
    provideDocumentLinks: () => {
      const link = new DocumentLink(new Range(1, 0, 1, 5), Uri.from(other).with({ fragment: 'L3,2' }) as vscode.Uri);
      link.tooltip = 'Open b';
      return [link];
    },
  });
  await settle();
  const links = provider('LinkProvider');
  const list = await links.provideLinks(model(), token());
  // Monaco never gets the target: following goes through the workbench.
  expect(list.links).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }, tooltip: 'Open b' }]);
  const resolved = await links.resolveLink(list.links[0], token());
  expect(resolved.url.scheme).toBe('command');
  await follow(resolved.url);
  expect(followed).toHaveLength(1);
  expect(followed[0].target.toString()).toBe(other.toString());
  expect(followed[0].options).toEqual({ allowCommands: ['test.first.run'], selection: { startLineNumber: 3, startColumn: 2 } });
  // An answer the opener refused is told.
  expect(host!.warnings).toEqual([expect.stringContaining('could not be opened')]);
});

test('through the opener: a web link opens only after the user agrees, a command link only for the extension\'s contributed command', async () => {
  let agree = false;
  const quickInput = { pick: vi.fn(async () => agree ? { id: 'open' } : { id: 'cancel' }) } as unknown as IQuickInputService;
  const executeCommand = vi.fn(async () => undefined);
  const opener = new OpenerService(quickInput, { executeCommand } as unknown as ICommandService);
  const open = vi.fn((_url?: string) => null);
  vi.stubGlobal('open', open);
  try {
    const { languages, warnings } = await setup({ openLink: (target, options) => opener.open(target, options) });
    languages().registerDocumentLinkProvider('lftest', {
      provideDocumentLinks: () => [
        new DocumentLink(new Range(0, 0, 0, 1), Uri.parse('https://example.com/page') as vscode.Uri),
        new DocumentLink(new Range(1, 0, 1, 1), Uri.parse('command:other.extension.run') as vscode.Uri),
        new DocumentLink(new Range(2, 0, 2, 1), Uri.parse('command:test.first.run?%5B1%5D') as vscode.Uri),
      ],
    });
    await settle();
    const links = provider('LinkProvider');
    const list = await links.provideLinks(model(), token());
    const urls = await Promise.all(list.links.map((link: unknown) => links.resolveLink(link, token()).then((value: { url: URI }) => value.url)));
    await follow(urls[0]);
    expect(quickInput.pick).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    agree = true;
    await follow(urls[0]);
    expect(open).toHaveBeenCalledWith('https://example.com/page', '_blank', 'noopener,noreferrer');
    await follow(urls[1]);
    expect(executeCommand).not.toHaveBeenCalled();
    expect(warnings).toEqual([expect.stringContaining("'other.extension.run' is not one its extension contributes")]);
    await follow(urls[2]);
    expect(executeCommand).toHaveBeenCalledWith('test.first.run', 1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('a link without a target is resolved on the extension host when followed; the list is kept until Monaco disposes it', async () => {
  const { languages, followed, group } = await setup();
  const resolveDocumentLink = vi.fn((link: vscode.DocumentLink) => {
    link.target = Uri.from(other) as vscode.Uri;
    return link;
  });
  languages().registerDocumentLinkProvider('lftest', { provideDocumentLinks: () => [new DocumentLink(new Range(0, 0, 0, 1))], resolveDocumentLink });
  await settle();
  const links = provider('LinkProvider');
  const list = await links.provideLinks(model(), token());
  expect(group.cacheSize).toBe(1);
  expect(resolveDocumentLink).not.toHaveBeenCalled();
  await follow((await links.resolveLink(list.links[0], token())).url);
  expect(resolveDocumentLink).toHaveBeenCalledTimes(1);
  expect(followed[0].target.toString()).toBe(other.toString());
  list.dispose();
  await settle();
  expect(group.cacheSize).toBe(0);
  // A followed target goes with its list: the old command does nothing now.
  await follow((await links.resolveLink(list.links[0], token())).url);
  expect(followed).toHaveLength(2);
});

// --- Definitions and references --------------------------------------------------------------------

test('a definition in another file reaches Monaco as a link to that file with 1-based ranges; locations and links both cross', async () => {
  const { languages } = await setup();
  const provideDefinition = vi.fn((_document: vscode.TextDocument, _position: vscode.Position) => [{
    originSelectionRange: new Range(1, 0, 1, 5), targetUri: Uri.from(other) as vscode.Uri,
    targetRange: new Range(0, 0, 0, 10), targetSelectionRange: new Range(0, 5, 0, 10),
  }]);
  languages().registerDefinitionProvider('lftest', { provideDefinition });
  languages().registerDeclarationProvider('lftest', { provideDeclaration: () => new Location(Uri.from(other) as vscode.Uri, new Position(0, 2)) });
  languages().registerTypeDefinitionProvider('lftest', { provideTypeDefinition: () => [new Location(Uri.from(resource) as vscode.Uri, new Range(3, 0, 3, 5))] });
  languages().registerImplementationProvider('lftest', { provideImplementation: () => undefined });
  await settle();
  const definitions = await provider('DefinitionProvider').provideDefinition(model(), { lineNumber: 2, column: 3 }, token());
  expect(provideDefinition.mock.calls[0][1]).toEqual(new Position(1, 2));
  expect(definitions).toHaveLength(1);
  expect(definitions[0].uri.toString()).toBe(other.toString());
  expect(definitions[0]).toMatchObject({
    originSelectionRange: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 },
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 11 },
    targetSelectionRange: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 11 },
  });
  const declarations = await provider('DeclarationProvider').provideDeclaration(model(), { lineNumber: 1, column: 1 }, token());
  expect(declarations).toEqual([{ uri: expect.anything(), range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 3 } }]);
  expect((await provider('TypeDefinitionProvider').provideTypeDefinition(model(), { lineNumber: 1, column: 1 }, token()))[0].range.startLineNumber).toBe(4);
  await expect(provider('ImplementationProvider').provideImplementation(model(), { lineNumber: 1, column: 1 }, token())).resolves.toBeUndefined();
});

test('references get the declaration flag and come back as locations; highlights keep their kinds', async () => {
  const { languages } = await setup();
  const provideReferences = vi.fn((_document: vscode.TextDocument, _position: vscode.Position, _context: vscode.ReferenceContext) =>
    [new Location(Uri.from(other) as vscode.Uri, new Range(0, 5, 0, 10)), { uri: 'not a uri', range: new Range(0, 0, 0, 1) } as never]);
  languages().registerReferenceProvider('lftest', { provideReferences });
  languages().registerDocumentHighlightProvider('lftest', {
    provideDocumentHighlights: () => [new DocumentHighlight(new Range(1, 0, 1, 5), DocumentHighlightKind.Write), new DocumentHighlight(new Range(1, 6, 1, 10))],
  });
  await settle();
  const references = await provider('ReferenceProvider').provideReferences(model(), { lineNumber: 2, column: 1 }, { includeDeclaration: true }, token());
  expect(provideReferences.mock.calls[0][2]).toEqual({ includeDeclaration: true });
  expect(references).toHaveLength(1);
  expect(references[0]).toEqual({ uri: expect.anything(), range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 11 } });
  expect(await provider('DocumentHighlightProvider').provideDocumentHighlights(model(), { lineNumber: 2, column: 1 }, token())).toEqual([
    { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }, kind: 2 },
    { range: { startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 11 }, kind: 0 },
  ]);
});

test('going to another file opens it in an editor at the target; a scheme no provider handles tells the user instead', async () => {
  const opened: { resource: string; selection: unknown }[] = [];
  const warnings: string[] = [];
  const opener = createEditorOpener({
    openEditor: async (target, selection) => {
      opened.push({ resource: target.toString(), selection });
      return true;
    },
    canOpen: target => target.scheme === 'vscode-vfs',
    warn: message => warnings.push(message),
  });
  const components = (uri: URI) => ({ scheme: uri.scheme, authority: uri.authority, path: uri.path, query: uri.query, fragment: uri.fragment });
  await expect(opener.openCodeEditor(undefined, components(other), { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 11 })).resolves.toBe(true);
  await opener.openCodeEditor(undefined, components(other), { lineNumber: 3, column: 2 });
  expect(opened).toEqual([
    { resource: other.toString(), selection: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 11 } },
    { resource: other.toString(), selection: { startLineNumber: 3, startColumn: 2 } },
  ]);
  await expect(opener.openCodeEditor(undefined, components(URI.parse('git:/repo/a.lft')))).resolves.toBe(true);
  expect(opened).toHaveLength(2);
  expect(warnings).toEqual([expect.stringContaining("no file system provider handles 'git' resources")]);
});

// --- Folding and selection ranges ------------------------------------------------------------------

test('folding ranges are the provider\'s, 0-based lines become 1-based, kinds are Monaco\'s, a reversed range is dropped', async () => {
  const { languages } = await setup();
  languages().registerFoldingRangeProvider('lftest', {
    provideFoldingRanges: () => [new FoldingRange(0, 4), new FoldingRange(2, 3, FoldingRangeKind.Region), new FoldingRange(3, 1), new FoldingRange(1, 2, FoldingRangeKind.Comment)],
  });
  await settle();
  expect(await provider('FoldingRangeProvider').provideFoldingRanges(model(), {}, token())).toEqual([
    { start: 1, end: 5 }, { start: 3, end: 4, kind: { value: 'region' } }, { start: 2, end: 3, kind: { value: 'comment' } },
  ]);
});

test('selection ranges: each position\'s chain runs from the innermost range out through its parents, 1-based', async () => {
  const { languages } = await setup();
  const provideSelectionRanges = vi.fn((_document: vscode.TextDocument, positions: readonly vscode.Position[]) => positions.map(at =>
    new SelectionRange(new Range(at.line, 0, at.line, 5), new SelectionRange(new Range(at.line, 0, 4, 3), new SelectionRange(new Range(0, 0, 4, 3))))));
  languages().registerSelectionRangeProvider('lftest', { provideSelectionRanges });
  await settle();
  const ranges = await provider('SelectionRangeProvider').provideSelectionRanges(model(), [{ lineNumber: 2, column: 3 }, { lineNumber: 4, column: 1 }], token());
  expect(provideSelectionRanges.mock.calls[0][1]).toEqual([new Position(1, 2), new Position(3, 0)]);
  expect(ranges).toEqual([
    [
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 } },
      { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 4 } },
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 4 } },
    ],
    [
      { range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 6 } },
      { range: { startLineNumber: 4, startColumn: 1, endLineNumber: 5, endColumn: 4 } },
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 4 } },
    ],
  ]);
  // From the extension host: one chain per position, each range containing the one before.
  const range = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 };
  expect(checkSelectionRanges([[range, { ...range, endColumn: 3 }]], 1)).toEqual([[{ range }]]);
  expect(checkSelectionRanges([[range]], 2)).toBeUndefined();
});

// --- Code lenses -----------------------------------------------------------------------------------

test('a code lens\'s command runs on the extension host with its arguments, a resolved lens\'s too; the change event makes Monaco ask again', async () => {
  const { languages, executed, group } = await setup();
  const changed = new (await import('../../common/extHostTypes.js')).EventEmitter<void>();
  const provideCodeLenses = vi.fn(() => [
    new CodeLens(new Range(0, 0, 0, 7), { title: '2 references', command: 'test.first.run', arguments: [{ kept: new Map([[1, 2]]) }] }),
    new CodeLens(new Range(2, 0, 2, 8)),
  ]);
  languages().registerCodeLensProvider('lftest', {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses,
    resolveCodeLens: lens => {
      lens.command = { title: 'Resolved', command: 'test.first.run', arguments: ['late'] };
      return lens;
    },
  });
  await settle();
  const lenses = provider('CodeLensProvider');
  const list = await lenses.provideCodeLenses(model(), token());
  expect(list.lenses.map((lens: { range: unknown }) => lens.range)).toEqual([
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 8 }, { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 9 },
  ]);
  expect(list.lenses[0].command.title).toBe('2 references');
  await host!.run(list.lenses[0].command);
  await settle();
  expect(executed).toEqual([{ extension: '1', id: 'test.first.run', args: [{ kept: new Map([[1, 2]]) }] }]);
  const resolved = await lenses.resolveCodeLens(model(), list.lenses[1], token());
  expect(resolved.command.title).toBe('Resolved');
  await host!.run(resolved.command);
  await settle();
  expect(executed[1].args).toEqual(['late']);

  const asked = vi.fn();
  lenses.onDidChange(asked);
  changed.fire();
  await settle();
  expect(asked).toHaveBeenCalledWith(lenses);

  expect(group.cacheSize).toBe(1);
  const commands = host!.features.commandCount;
  expect(commands).toBe(2);
  list.dispose();
  await settle();
  expect(group.cacheSize).toBe(0);
  expect(host!.features.commandCount).toBe(0);
});

test('cancelling a code lens request cancels the provider\'s token and keeps nothing of its late answer', async () => {
  const { languages, group } = await setup();
  let answer!: (lenses: vscode.CodeLens[]) => void;
  let providerToken: vscode.CancellationToken | undefined;
  languages().registerCodeLensProvider('lftest', {
    provideCodeLenses: (_document, cancellation) => {
      providerToken = cancellation;
      return new Promise<vscode.CodeLens[]>(resolve => { answer = resolve; });
    },
  });
  await settle();
  const source = new CancellationTokenSource();
  const pending = provider('CodeLensProvider').provideCodeLenses(model(), source.token);
  await settle();
  source.cancel();
  await settle();
  expect(providerToken?.isCancellationRequested).toBe(true);
  answer([new CodeLens(new Range(0, 0, 0, 1), { title: 'late', command: 'test.first.run' })]);
  await expect(pending).resolves.toBeUndefined();
  await settle();
  expect(group.cacheSize).toBe(0);
  expect(host!.features.commandCount).toBe(0);
});

test('a removed extension\'s providers leave Monaco and the workbench\'s list, and its kept lists go; an old provider answers nothing', async () => {
  const { languages, group, seam, release } = await setup();
  const provideCodeLenses = vi.fn(() => [new CodeLens(new Range(0, 0, 0, 1), { title: 'x', command: 'test.first.run' })]);
  languages().registerCodeLensProvider('lftest', { provideCodeLenses });
  languages().registerDocumentSymbolProvider('lftest', { provideDocumentSymbols: () => [] });
  languages().registerFoldingRangeProvider('lftest', { provideFoldingRanges: () => [] });
  languages('2').registerDefinitionProvider('lftest', { provideDefinition: () => undefined });
  await settle();
  expect(trackedProviderCount()).toBe(4);
  const lenses = provider('CodeLensProvider');
  await lenses.provideCodeLenses(model(), token());
  expect(group.cacheSize).toBe(1);
  seam.remove('1');
  await release('1');
  expect(host!.providers.map(entry => entry.kind)).toEqual(['DefinitionProvider']);
  expect(trackedProviderCount()).toBe(1);
  expect(group.cacheSize).toBe(0);
  await expect(lenses.provideCodeLenses(model(), token())).resolves.toBeUndefined();
  expect(provideCodeLenses).toHaveBeenCalledTimes(1);
});

// --- Colors, inlay hints, linked editing, semantic tokens -------------------------------------------

test('colors and their presentations cross with 1-based ranges', async () => {
  const { languages } = await setup();
  const provideColorPresentations = vi.fn((color: vscode.Color, context: { range: vscode.Range }) => {
    const presentation = new ColorPresentation('#ff0000');
    presentation.textEdit = TextEdit.replace(context.range, '#ff0000');
    return [presentation];
  });
  languages().registerColorProvider('lftest', {
    provideDocumentColors: () => [new ColorInformation(new Range(1, 0, 1, 5), new Color(1, 0, 0, 1)), { range: new Range(0, 0, 0, 1), color: { red: 2 } } as never],
    provideColorPresentations,
  });
  await settle();
  const colors = provider('ColorProvider');
  const found = await colors.provideDocumentColors(model(), token());
  expect(found).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }, color: { red: 1, green: 0, blue: 0, alpha: 1 } }]);
  expect(await colors.provideColorPresentations(model(), found[0], token())).toEqual([
    { label: '#ff0000', textEdit: { range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6 }, text: '#ff0000' } },
  ]);
  expect(provideColorPresentations.mock.calls[0][0]).toBeInstanceOf(Color);
});

test('inlay hints: label parts with their location and command, resolving, the change event, and the list released when Monaco disposes it', async () => {
  const { languages, group, executed } = await setup();
  const changed = new (await import('../../common/extHostTypes.js')).EventEmitter<void>();
  languages().registerInlayHintsProvider('lftest', {
    onDidChangeInlayHints: changed.event,
    provideInlayHints: (_document, range) => {
      const part = new InlayHintLabelPart('target');
      part.location = new Location(Uri.from(other) as vscode.Uri, new Range(0, 0, 0, 4));
      part.command = { title: 'Go', command: 'test.first.run' };
      return [new InlayHint(new Position(1, 5), [part], InlayHintKind.Type), new InlayHint(range.end.translate(5), 'outside')];
    },
    resolveInlayHint: hint => {
      hint.tooltip = new MarkdownString('**resolved**');
      return hint;
    },
  });
  await settle();
  const hints = provider('InlayHintsProvider');
  const list = await hints.provideInlayHints(model(), { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }, token());
  expect(list.hints).toHaveLength(1);
  expect(list.hints[0]).toMatchObject({ position: { lineNumber: 2, column: 6 }, kind: 1, label: [{ label: 'target', location: { range: { startLineNumber: 1, endColumn: 5 } } }] });
  expect(list.hints[0].label[0].location.uri.toString()).toBe(other.toString());
  await host!.run(list.hints[0].label[0].command);
  await settle();
  expect(executed.map(entry => entry.id)).toEqual(['test.first.run']);
  const resolved = await hints.resolveInlayHint(list.hints[0], token());
  expect(resolved.tooltip).toEqual({ value: '**resolved**' });
  const asked = vi.fn();
  hints.onDidChangeInlayHints(asked);
  changed.fire();
  await settle();
  expect(asked).toHaveBeenCalled();
  list.dispose();
  await settle();
  expect(group.cacheSize).toBe(0);
});

test('linked editing ranges cross with their word pattern; semantic tokens with their legend, whole or as edits', async () => {
  const { languages } = await setup();
  languages().registerLinkedEditingRangeProvider('lftest', {
    provideLinkedEditingRanges: () => new LinkedEditingRanges([new Range(0, 2, 0, 7), new Range(2, 3, 2, 8)], /[a-z]+/i),
  });
  const legend = new SemanticTokensLegend(['heading', 'word'], ['bold']);
  const provideDocumentSemanticTokensEdits = vi.fn((_document: vscode.TextDocument, previous: string) =>
    new SemanticTokensEdits([new SemanticTokensEdit(0, 5, new Uint32Array([0, 0, 1, 1, 0]))], previous + '+1'));
  languages().registerDocumentSemanticTokensProvider('lftest', {
    provideDocumentSemanticTokens: () => {
      const builder = new SemanticTokensBuilder(legend);
      builder.push(new Range(1, 6, 1, 10), 'word', ['bold']);
      builder.push(new Range(0, 2, 0, 7), 'heading');
      return builder.build('1');
    },
    provideDocumentSemanticTokensEdits,
  }, legend);
  await settle();
  const linked = await provider('LinkedEditingRangeProvider').provideLinkedEditingRanges(model(), { lineNumber: 1, column: 3 }, token());
  expect(linked.ranges).toEqual([
    { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 8 }, { startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 9 },
  ]);
  expect(linked.wordPattern).toEqual(/[a-z]+/i);
  const tokens = provider('DocumentSemanticTokensProvider');
  expect(tokens.getLegend()).toEqual({ tokenTypes: ['heading', 'word'], tokenModifiers: ['bold'] });
  // Sorted, relative: (0,2) heading, then (1,6) word bold.
  await expect(tokens.provideDocumentSemanticTokens(model(), null, token())).resolves.toEqual({ resultId: '1', data: new Uint32Array([0, 2, 5, 0, 0, 1, 6, 4, 1, 1]) });
  await expect(tokens.provideDocumentSemanticTokens(model(), '1', token())).resolves.toEqual({
    resultId: '1+1', edits: [{ start: 0, deleteCount: 5, data: new Uint32Array([0, 0, 1, 1, 0]) }],
  });
  expect(checkSemanticTokens({ data: new Uint32Array(4) })).toBeUndefined();
  expect(checkSemanticTokens({ edits: [{ start: -1, deleteCount: 0 }] })).toBeUndefined();
});

// --- The API commands ------------------------------------------------------------------------------

test('vscode.executeDocumentSymbolProvider gives DocumentSymbol instances with Uri locations; a document that is not open gives nothing', async () => {
  const { languages, apiCommands, addModel } = await setup();
  addModel(model());
  const title = new DocumentSymbol('Title', 'h1', SymbolKind.Module, new Range(0, 0, 4, 3), new Range(0, 2, 0, 7));
  title.children.push(new DocumentSymbol('Inner', '', SymbolKind.String, new Range(2, 0, 3, 5), new Range(2, 3, 2, 8)));
  languages().registerDocumentSymbolProvider('lftest', { provideDocumentSymbols: () => [title] });
  // Another extension's empty answer does not hide the first's symbols.
  languages('2').registerDocumentSymbolProvider({ language: 'lftest', scheme: 'vscode-vfs' }, { provideDocumentSymbols: () => [] });
  await settle();
  const symbols = await apiCommands.execute('1', 'vscode.executeDocumentSymbolProvider', [Uri.from(resource)]) as vscode.DocumentSymbol[];
  expect(symbols).toHaveLength(1);
  expect(symbols[0]).toBeInstanceOf(DocumentSymbol);
  expect(symbols[0].range).toBeInstanceOf(Range);
  expect(symbols[0].range).toEqual(new Range(0, 0, 4, 3));
  expect(symbols[0].children[0]).toBeInstanceOf(DocumentSymbol);
  expect(symbols[0].children[0].selectionRange).toEqual(new Range(2, 3, 2, 8));
  const location = (symbols[0] as unknown as { location: vscode.Location }).location;
  expect(location).toBeInstanceOf(Location);
  expect(URI.isUri(location.uri)).toBe(true);
  await expect(apiCommands.execute('1', 'vscode.executeDocumentSymbolProvider', [Uri.from(closed)])).resolves.toBeUndefined();
  await expect(apiCommands.execute('1', 'vscode.executeDocumentSymbolProvider', ['a.lft'])).rejects.toThrow(TypeError);
});

test('vscode.executeDefinitionProvider, executeReferenceProvider and executeLinkProvider give API instances from every provider', async () => {
  const { languages, apiCommands, addModel, group } = await setup();
  addModel(model());
  languages().registerDefinitionProvider('lftest', { provideDefinition: () => new Location(Uri.from(other) as vscode.Uri, new Range(0, 5, 0, 10)) });
  languages('2').registerDefinitionProvider('lftest', {
    provideDefinition: () => [{ targetUri: Uri.from(other) as vscode.Uri, targetRange: new Range(0, 0, 0, 10), targetSelectionRange: new Range(0, 5, 0, 10) }],
  });
  languages().registerReferenceProvider('lftest', { provideReferences: () => [new Location(Uri.from(other) as vscode.Uri, new Range(0, 5, 0, 10))] });
  languages().registerDocumentLinkProvider('lftest', {
    provideDocumentLinks: () => [new DocumentLink(new Range(1, 0, 1, 5))],
    resolveDocumentLink: link => Object.assign(link, { target: Uri.from(other) }),
  });
  await settle();
  const at = new Position(1, 2);
  const definitions = await apiCommands.execute('1', 'vscode.executeDefinitionProvider', [Uri.from(resource), at]) as (vscode.Location | vscode.LocationLink)[];
  expect(definitions).toHaveLength(2);
  const location = definitions.find(entry => entry instanceof Location) as vscode.Location;
  expect(location.range).toEqual(new Range(0, 5, 0, 10));
  const link = definitions.find(entry => !(entry instanceof Location)) as vscode.LocationLink;
  expect(link.targetSelectionRange).toEqual(new Range(0, 5, 0, 10));
  expect(URI.isUri(link.targetUri)).toBe(true);
  const references = await apiCommands.execute('1', 'vscode.executeReferenceProvider', [Uri.from(resource), at]) as vscode.Location[];
  expect(references.map(reference => reference instanceof Location && reference.uri.toString())).toEqual([other.toString()]);
  const unresolved = await apiCommands.execute('1', 'vscode.executeLinkProvider', [Uri.from(resource)]) as vscode.DocumentLink[];
  expect(unresolved[0]).toBeInstanceOf(DocumentLink);
  expect(unresolved[0].target).toBeUndefined();
  const resolved = await apiCommands.execute('1', 'vscode.executeLinkProvider', [Uri.from(resource), 5]) as vscode.DocumentLink[];
  expect(resolved[0].target?.toString()).toBe(other.toString());
  expect(resolved[0].range).toEqual(new Range(1, 0, 1, 5));
  await settle();
  // The lists the commands asked for are released.
  expect(group.cacheSize).toBe(0);
});

test('the other groups\' API commands: hover, completions, formatting, code actions and a rename that is not applied', async () => {
  const { languages, apiCommands, addModel, bulkEdits } = await setup();
  addModel(model());
  languages().registerHoverProvider('lftest', { provideHover: () => new Hover(new MarkdownString('**alpha**'), new Range(1, 0, 1, 5)) });
  languages().registerCompletionItemProvider('lftest', {
    provideCompletionItems: () => new CompletionList([new CompletionItem('alphabet')], true),
    resolveCompletionItem: item => Object.assign(item, { detail: 'resolved' }),
  });
  languages().registerDocumentFormattingEditProvider('lftest', { provideDocumentFormattingEdits: () => [TextEdit.replace(new Range(0, 0, 0, 1), '#')] });
  languages().registerDocumentRangeFormattingEditProvider('lftest', { provideDocumentRangeFormattingEdits: (_document, range) => [TextEdit.insert(range.start, ' ')] });
  languages().registerCodeActionsProvider('lftest', {
    provideCodeActions: () => {
      const fix = new CodeAction('Fix', CodeActionKind.QuickFix);
      fix.edit = new WorkspaceEdit();
      fix.edit.replace(Uri.from(resource) as vscode.Uri, new Range(0, 0, 0, 1), '#');
      return [fix, { title: 'Run', command: 'test.first.run', arguments: [1] }];
    },
  });
  languages().registerRenameProvider('lftest', {
    provideRenameEdits: (document, position, newName) => {
      const edit = new WorkspaceEdit();
      edit.replace(document.uri, document.getWordRangeAtPosition(position)!, newName);
      return edit;
    },
  });
  await settle();
  const uri = Uri.from(resource);
  const at = new Position(1, 2);
  const hovers = await apiCommands.execute('1', 'vscode.executeHoverProvider', [uri, at]) as vscode.Hover[];
  expect(hovers[0]).toBeInstanceOf(Hover);
  expect((hovers[0].contents[0] as vscode.MarkdownString).value).toBe('**alpha**');
  expect(hovers[0].range).toEqual(new Range(1, 0, 1, 5));
  const list = await apiCommands.execute('1', 'vscode.executeCompletionItemProvider', [uri, at, undefined, 1]) as vscode.CompletionList;
  expect(list).toBeInstanceOf(CompletionList);
  expect(list.isIncomplete).toBe(true);
  expect(list.items[0]).toBeInstanceOf(CompletionItem);
  expect([list.items[0].label, list.items[0].detail]).toEqual(['alphabet', 'resolved']);
  const formatted = await apiCommands.execute('1', 'vscode.executeFormatDocumentProvider', [uri, { tabSize: 2, insertSpaces: true }]) as vscode.TextEdit[];
  expect(formatted[0]).toBeInstanceOf(TextEdit);
  expect(formatted[0].range).toEqual(new Range(0, 0, 0, 1));
  const ranged = await apiCommands.execute('1', 'vscode.executeFormatRangeProvider', [uri, new Range(1, 0, 1, 5), {}]) as vscode.TextEdit[];
  expect(ranged[0].range).toEqual(new Range(1, 0, 1, 0));
  const actions = await apiCommands.execute('1', 'vscode.executeCodeActionProvider', [uri, new Range(0, 0, 0, 1)]) as (vscode.CodeAction | vscode.Command)[];
  expect(actions[0]).toBeInstanceOf(CodeAction);
  expect((actions[0] as vscode.CodeAction).kind?.value).toBe('quickfix');
  expect((actions[0] as vscode.CodeAction).edit).toBeInstanceOf(WorkspaceEdit);
  expect(actions[1]).toEqual({ title: 'Run', command: 'test.first.run', tooltip: undefined, arguments: [1] });
  const rename = await apiCommands.execute('1', 'vscode.executeDocumentRenameProvider', [uri, at, 'omega']) as vscode.WorkspaceEdit;
  expect(rename).toBeInstanceOf(WorkspaceEdit);
  expect(rename.get(uri as vscode.Uri)).toEqual([new TextEdit(new Range(1, 0, 1, 5), 'omega')]);
  // Executing the command never applies the rename.
  expect(bulkEdits.calls).toEqual([]);
});

test('vscode.executeCodeActionProvider: only valid actions of the asked kind, and one that fails to resolve stays as given', async () => {
  const { languages, apiCommands, addModel } = await setup();
  addModel(model());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  languages().registerCodeActionsProvider('lftest', {
    provideCodeActions: () => {
      const broken = new CodeAction('Broken', CodeActionKind.QuickFix);
      const fix = new CodeAction('Fix', CodeActionKind.QuickFix);
      const extract = new CodeAction('Extract', CodeActionKind.RefactorExtract);
      const disabled = new CodeAction('Disabled', CodeActionKind.QuickFix);
      disabled.disabled = { reason: 'not here' };
      return [broken, fix, extract, disabled, { title: 'Run', command: 'test.first.run' }];
    },
    resolveCodeAction: action => {
      if (action.title === 'Broken') {
        throw new Error('cannot resolve');
      }
      return action;
    },
  });
  await settle();
  const uri = Uri.from(resource);
  const quickFixes = await apiCommands.execute('1', 'vscode.executeCodeActionProvider', [uri, new Range(0, 0, 0, 1), 'quickfix', 1]) as vscode.CodeAction[];
  expect(quickFixes.map(action => action.title)).toEqual(['Broken', 'Fix']);
  const all = await apiCommands.execute('1', 'vscode.executeCodeActionProvider', [uri, new Range(0, 0, 0, 1)]) as (vscode.CodeAction | vscode.Command)[];
  expect(all.map(action => action.title)).toEqual(['Broken', 'Fix', 'Extract', 'Run']);
});

test('vscode.executeDocumentRenameProvider: a provider that refuses passes the turn, the reasons of all are the refusal', async () => {
  const { languages, apiCommands, addModel } = await setup();
  addModel(model());
  const refuse = (reason: string) => ({ provideRenameEdits: () => { throw new Error(reason); } });
  languages().registerRenameProvider('lftest', refuse('not here'));
  languages('2').registerRenameProvider('lftest', {
    provideRenameEdits: (document, position, newName) => {
      const edit = new WorkspaceEdit();
      edit.replace(document.uri, document.getWordRangeAtPosition(position)!, newName);
      return edit;
    },
  });
  await settle();
  const uri = Uri.from(resource);
  const rename = await apiCommands.execute('1', 'vscode.executeDocumentRenameProvider', [uri, new Position(1, 2), 'omega']) as vscode.WorkspaceEdit;
  expect(rename.get(uri as vscode.Uri)).toEqual([new TextEdit(new Range(1, 0, 1, 5), 'omega')]);
  host!.dispose();
  const again = await setup();
  again.addModel(model());
  again.languages().registerRenameProvider('lftest', refuse('not here'));
  again.languages('2').registerRenameProvider('lftest', refuse('nor here'));
  await settle();
  await expect(again.apiCommands.execute('1', 'vscode.executeDocumentRenameProvider', [uri, new Position(1, 2), 'omega'])).rejects.toThrow('not here\nnor here');
});

test('a released extension\'s provider event no longer reaches the workbench', async () => {
  const emitted = vi.spyOn(MainThreadNavigation.prototype, '$emitProviderEvent');
  const { languages, release } = await setup();
  const changed = new (await import('../../common/extHostTypes.js')).EventEmitter<void>();
  languages().registerCodeLensProvider('lftest', { onDidChangeCodeLenses: changed.event, provideCodeLenses: () => [] });
  await settle();
  changed.fire();
  await settle();
  expect(emitted).toHaveBeenCalledTimes(1);
  await release('1');
  changed.fire();
  await settle();
  expect(emitted).toHaveBeenCalledTimes(1);
});

test('the API classes keep VS Code\'s signatures and can be extended, as a language client does', () => {
  class ProtocolCodeLens extends CodeLens {
    data = 'kept';
  }
  const lens = new ProtocolCodeLens(new Range(0, 0, 0, 1));
  expect([lens.isResolved, lens.data]).toEqual([false, 'kept']);
  lens.command = { title: 't', command: 'c' };
  expect(lens.isResolved).toBe(true);
  class ProtocolDocumentLink extends DocumentLink {}
  class ProtocolInlayHint extends InlayHint {}
  class ProtocolSymbolInformation extends SymbolInformation {}
  expect(new ProtocolDocumentLink(new Range(0, 0, 0, 1)).target).toBeUndefined();
  expect(new ProtocolInlayHint(new Position(0, 0), 'x').label).toBe('x');
  const info = new ProtocolSymbolInformation('name', SymbolKind.Class, new Range(0, 0, 0, 1), Uri.from(resource) as vscode.Uri);
  expect(info.location).toBeInstanceOf(Location);
  expect(info.containerName).toBe('');
  expect(() => new DocumentSymbol('x', '', SymbolKind.Class, new Range(0, 0, 0, 1), new Range(1, 0, 1, 1))).toThrow();
  expect(() => new SelectionRange(new Range(0, 0, 2, 0), new SelectionRange(new Range(0, 0, 1, 0)))).toThrow();
  expect(new SemanticTokens(new Uint32Array([1]))).toMatchObject({ resultId: undefined });
  const builder = new SemanticTokensBuilder();
  builder.push(2, 1, 3, 0, 0);
  builder.push(2, 6, 1, 1, 2);
  expect(builder.build().data).toEqual(new Uint32Array([2, 1, 3, 0, 0, 0, 5, 1, 1, 2]));
  expect(() => new SemanticTokensBuilder().push(new Range(0, 0, 0, 1), 'x')).toThrow();
});

test('providers are checked when registered, and a provider without a change event gives Monaco none', async () => {
  const { languages } = await setup();
  expect(() => languages().registerDocumentSymbolProvider('lftest', {} as never)).toThrow(TypeError);
  expect(() => languages().registerColorProvider('lftest', { provideDocumentColors: () => [] } as never)).toThrow(TypeError);
  expect(() => languages().registerDocumentSemanticTokensProvider('lftest', { provideDocumentSemanticTokens: () => undefined }, undefined as never)).toThrow(TypeError);
  languages().registerCodeLensProvider('lftest', { provideCodeLenses: () => [] });
  await settle();
  expect(provider('CodeLensProvider').onDidChange).toBeUndefined();
  expect(provider('CodeLensProvider').resolveCodeLens).toBeUndefined();
});
