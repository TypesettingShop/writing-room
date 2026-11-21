// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, expect, test } from 'vitest';
import { Position, Range, SnippetString } from '../../common/extHostEditorTypes.js';
import {
  CallHierarchyItem, createReceiveOnlyGroup, DocumentDropEdit, DocumentDropOrPasteEditKind, DocumentPasteEdit, InlineValueVariableLookup,
  receiveOnlyProviders, TypeHierarchyItem,
} from '../../common/extHostLanguageFeaturesReceiveOnly.js';
import type { ExtHostReceiveOnly } from '../../common/extHostLanguageFeaturesReceiveOnly.js';
import { Uri } from '../../common/extHostTypes.js';
import { createTestExtensionApi } from '../common/testExtensionHost.js';
import { createLanguageFeatureTestHost, settle } from './languageFeaturesTestHost.js';

/*
 * The providers that are registered and kept but never asked (wr-c9d8.kxn). Each test names the
 * failure it catches.
 */

/**
 * The `languages.register*` functions that vscode.markdown-language-features 1.95.3 (the third main
 * acceptance extension) has in its browser bundle, measured by name (wr-c9d8.kxn): calling one that is
 * missing throws during activation.
 */
const measured = [
  'registerCallHierarchyProvider', 'registerCodeActionsProvider', 'registerCodeLensProvider', 'registerColorProvider',
  'registerCompletionItemProvider', 'registerDeclarationProvider', 'registerDefinitionProvider', 'registerDocumentDropEditProvider',
  'registerDocumentFormattingEditProvider', 'registerDocumentHighlightProvider', 'registerDocumentLinkProvider',
  'registerDocumentPasteEditProvider', 'registerDocumentRangeFormattingEditProvider', 'registerDocumentRangeSemanticTokensProvider',
  'registerDocumentSemanticTokensProvider', 'registerDocumentSymbolProvider', 'registerFoldingRangeProvider', 'registerHoverProvider',
  'registerImplementationProvider', 'registerInlayHintsProvider', 'registerInlineValuesProvider', 'registerLinkedEditingRangeProvider',
  'registerOnTypeFormattingEditProvider', 'registerReferenceProvider', 'registerRenameProvider', 'registerSelectionRangeProvider',
  'registerSignatureHelpProvider', 'registerTypeDefinitionProvider', 'registerTypeHierarchyProvider', 'registerWorkspaceSymbolProvider',
] as const;

type Host = Awaited<ReturnType<typeof createLanguageFeatureTestHost>>;
let host: Host | undefined;
afterEach(() => {
  host?.dispose();
  host = undefined;
});

async function setup() {
  host = await createLanguageFeatureTestHost({ hostGroups: [createReceiveOnlyGroup], mainGroups: [] });
  const group = host.host.groups[0] as ExtHostReceiveOnly;
  return { ...host, group, languages: (key = '1') => host!.api(key) as unknown as Record<string, (...args: unknown[]) => vscode.Disposable> };
}

test('every registration function the third acceptance extension has is in vscode.languages, and the receive-only list is part of it', async () => {
  const extension = await createTestExtensionApi();
  try {
    const languages = extension.api.languages as unknown as Record<string, unknown>;
    expect(measured.length).toBe(30);
    expect(measured.filter(name => typeof languages[name] !== 'function')).toEqual([]);
    expect(receiveOnlyProviders.filter(({ name }) => typeof languages[name] !== 'function')).toEqual([]);
    // The classes the language client extends or builds while it loads.
    const api = extension.api as unknown as Record<string, unknown>;
    expect(['CallHierarchyItem', 'TypeHierarchyItem', 'DocumentDropEdit', 'DocumentPasteEdit', 'DocumentDropOrPasteEditKind', 'InlineValueText',
      'InlineValueVariableLookup', 'InlineValueEvaluatableExpression', 'CallHierarchyIncomingCall', 'CallHierarchyOutgoingCall']
      .filter(name => typeof api[name] !== 'function')).toEqual([]);
  } finally {
    extension.dispose();
  }
});

test('no function is both receive-only and given by another feature group', async () => {
  const { group, api } = await setup();
  const all = Object.keys(api('1'));
  expect(all.sort()).toEqual(receiveOnlyProviders.map(({ name }) => name).sort());
  expect(new Set(receiveOnlyProviders.map(({ name }) => name)).size).toBe(receiveOnlyProviders.length);
  expect(group.count()).toBe(0);
});

test('a registration gives a disposable and is kept until it is disposed or the extension is released; nothing reaches the workbench', async () => {
  const { group, features, languages, providers } = await setup();
  const registrations = receiveOnlyProviders.map(({ name }) => languages()[name]('lftest', {}, { providedPasteEditKinds: [] }));
  for (const registration of registrations) {
    expect(typeof registration.dispose).toBe('function');
  }
  expect(group.count()).toBe(receiveOnlyProviders.length);
  expect(group.count('registerDocumentPasteEditProvider')).toBe(1);
  expect(features.size).toBe(receiveOnlyProviders.length);
  registrations[0].dispose();
  registrations[0].dispose();
  expect(group.count()).toBe(receiveOnlyProviders.length - 1);
  expect(group.count(receiveOnlyProviders[0].name)).toBe(0);

  languages('2').registerDocumentDropEditProvider('lftest', {});
  features.release('1');
  group.release('1');
  await settle();
  expect(group.count()).toBe(1);
  expect(features.size).toBe(1);
  // Monaco never got a provider.
  expect(providers).toEqual([]);
});

test('a selector of another shape throws, as any registration does', async () => {
  const { languages, group } = await setup();
  expect(() => languages().registerCallHierarchyProvider(42, {})).toThrow();
  expect(group.count()).toBe(0);
});

test('the API classes construct as upstream; a drop or paste kind appends, contains and intersects', () => {
  const uri = Uri.parse('vscode-vfs://writing-room/workspace/a.md') as vscode.Uri;
  const range = new Range(1, 0, 1, 4);
  const item = new CallHierarchyItem(5, 'name', 'detail', uri, range, range);
  expect(item).toMatchObject({ kind: 5, name: 'name', detail: 'detail', uri, range, selectionRange: range });
  expect(new TypeHierarchyItem(4, 'type', '', uri, range, range).name).toBe('type');
  expect(new InlineValueVariableLookup(range).caseSensitiveLookup).toBe(true);

  const text = DocumentDropOrPasteEditKind.Text;
  expect(DocumentDropOrPasteEditKind.Empty.value).toBe('');
  expect(text.value).toBe('text');
  expect(DocumentDropOrPasteEditKind.TextUpdateImports.value).toBe('text.updateImports');
  expect(text.append('uri', 'markdown').value).toBe('text.uri.markdown');
  expect(text.contains(text.append('uri'))).toBe(true);
  expect(text.append('uri').contains(text)).toBe(false);
  expect(text.contains(DocumentDropOrPasteEditKind.Empty.append('textual'))).toBe(false);
  expect(text.append('uri').intersects(text)).toBe(true);

  const drop = new DocumentDropEdit(new SnippetString('[$1](a.md)'), 'Insert link', text.append('link'));
  expect(drop).toMatchObject({ title: 'Insert link', kind: { value: 'text.link' } });
  expect(new DocumentPasteEdit('x', 'Paste', text).insertText).toBe('x');
  expect(new Position(0, 0)).toBeDefined();
});
