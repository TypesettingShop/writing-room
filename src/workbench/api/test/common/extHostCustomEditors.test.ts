import { describe, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../base/common/event.js';
import type * as vscode from 'vscode';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import type { CustomTextEditorResolveData, MainThreadCustomEditorsShape } from '../../common/extHost.protocol.customEditor.js';
import { ExtHostCustomEditors } from '../../common/extHostCustomEditors.js';
import type { ExtHostDocuments } from '../../common/extHostDocuments.js';

const resource = URI.parse('vscode-vfs://writing-room/workspace/a.md');
const origin = { origin: 'https://webview.example.test' };

function extension(key: string, viewTypes: string[]): HostExtensionDescription {
  return {
    key, id: 'test.ext' + key, location: 'https://example.test/', entry: 'https://example.test/extension.js', activationEvents: [],
    manifest: { name: 'ext' + key, publisher: 'test', version: '1.0.0', contributes: { customEditors: viewTypes.map(viewType => ({ viewType })) } },
  };
}

function setup() {
  const proxy = {
    $registerTextEditorProvider: vi.fn(async () => {}),
    $registerCustomEditorProvider: vi.fn(async () => {}),
    $unregisterProvider: vi.fn(async () => {}),
    $onDidEdit: vi.fn(async () => {}),
    $onDidChangeContent: vi.fn(async () => {}),
    $setHtml: vi.fn(async () => {}),
    $setOptions: vi.fn(async () => {}),
    $postMessage: vi.fn(async () => true),
    $reveal: vi.fn(async () => {}),
    $disposeEditor: vi.fn(async () => {}),
  } satisfies MainThreadCustomEditorsShape;
  const document = { uri: resource } as unknown as vscode.TextDocument;
  const documents = {
    get: (id: string) => id === 'model-1' ? document : undefined,
    canRead: () => true,
  } as unknown as ExtHostDocuments;
  const editors = new ExtHostCustomEditors(proxy, documents);
  const data: CustomTextEditorResolveData = {
    viewType: 'test.editor', resource, documentId: 'model-1', title: 'a.md', options: {}, contentOptions: { enableScripts: true },
    viewState: { active: true, visible: true, viewColumn: 1 },
  };
  return { proxy, document, editors, data };
}

describe('registering a custom editor provider', () => {
  test('takes a text provider for a viewType the extension contributes, once', () => {
    const { proxy, editors } = setup();
    const provider = { resolveCustomTextEditor: () => {} };
    const registration = editors.registerProvider(extension('1', ['test.editor']), 'test.editor', provider,
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true });
    expect(proxy.$registerTextEditorProvider).toHaveBeenCalledWith('1', 'test.editor',
      { enableFindWidget: false, retainContextWhenHidden: true }, true);
    expect(() => editors.registerProvider(extension('1', ['test.editor']), 'test.editor', provider)).toThrow(/already registered/);
    expect(() => editors.registerProvider(extension('2', ['other']), 'test.editor', provider)).toThrow(/not contributed/);
    registration.dispose();
    expect(proxy.$unregisterProvider).toHaveBeenCalledWith('1', 'test.editor');
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', provider);
    expect(proxy.$registerTextEditorProvider).toHaveBeenCalledTimes(2);
  });

  test('refuses another extension\'s viewType and an object that is no provider', () => {
    const { proxy, editors } = setup();
    expect(() => editors.registerProvider(extension('1', []), 'test.editor', { resolveCustomTextEditor: () => {} }))
      .toThrow(/not contributed/);
    expect(() => editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {} as vscode.CustomTextEditorProvider))
      .toThrow(/resolveCustomTextEditor, or openCustomDocument/);
    expect(proxy.$registerTextEditorProvider).not.toHaveBeenCalled();
  });
});

describe('resolving a custom text editor', () => {
  test('hands the provider the very document and a live panel, which closes the editor when disposed', async () => {
    const { proxy, document, editors, data } = setup();
    let panel: vscode.WebviewPanel | undefined;
    let received: vscode.TextDocument | undefined;
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {
      resolveCustomTextEditor: (doc, webviewPanel) => { received = doc; panel = webviewPanel; webviewPanel.webview.html = '<p>hi</p>'; },
    });
    await editors.$resolveTextEditor('1', 'h1', data, origin, new CancellationTokenSource().token);
    expect(received).toBe(document);
    expect(panel!.viewType).toBe('test.editor');
    expect(panel!.viewColumn).toBe(1);
    expect(panel!.webview.options.enableScripts).toBe(true);
    expect(proxy.$setHtml).toHaveBeenCalledWith('1', 'h1', '<p>hi</p>');
    const disposed = vi.fn();
    panel!.onDidDispose(disposed);
    await editors.$onViewState('1', 'h1', { active: false, visible: false, viewColumn: 2 });
    expect([panel!.active, panel!.visible, panel!.viewColumn]).toEqual([false, false, 2]);
    // Another extension cannot reach the handle.
    await editors.$onDisposed('2', 'h1');
    expect(disposed).not.toHaveBeenCalled();
    panel!.dispose();
    panel!.dispose();
    await editors.$onDisposed('1', 'h1');
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(proxy.$disposeEditor).toHaveBeenCalledTimes(1);
    await expect(panel!.webview.postMessage('late')).resolves.toBe(false);
  });

  test('refuses a document that is not the one named, and a provider of another extension', async () => {
    const { editors, data } = setup();
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', { resolveCustomTextEditor: () => {} });
    const token = new CancellationTokenSource().token;
    await expect(editors.$resolveTextEditor('1', 'h1', { ...data, documentId: 'model-2' }, origin, token)).rejects.toThrow(/unavailable/);
    await expect(editors.$resolveTextEditor('1', 'h1', { ...data, resource: URI.parse('vscode-vfs://writing-room/workspace/b.md') }, origin, token))
      .rejects.toThrow(/unavailable/);
    await expect(editors.$resolveTextEditor('2', 'h1', data, origin, token)).rejects.toThrow(/No custom editor provider/);
  });

  test('a cancelled resolution disposes its panel, and a provider that throws rejects', async () => {
    const { editors, data } = setup();
    let release!: () => void;
    let panel: vscode.WebviewPanel | undefined;
    let tokenSeen: vscode.CancellationToken | undefined;
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {
      resolveCustomTextEditor: (_document, webviewPanel, token) => {
        panel = webviewPanel;
        tokenSeen = token;
        return new Promise<void>(resolve => { release = resolve; });
      },
    });
    const source = new CancellationTokenSource();
    const pending = editors.$resolveTextEditor('1', 'h1', data, origin, source.token);
    await Promise.resolve();
    const disposed = vi.fn();
    panel!.onDidDispose(disposed);
    source.cancel();
    await pending;
    expect(tokenSeen!.isCancellationRequested).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
    release();

    const failing = setup();
    failing.editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {
      resolveCustomTextEditor: () => { throw new Error('broken'); },
    });
    await expect(failing.editors.$resolveTextEditor('1', 'h2', failing.data, origin, new CancellationTokenSource().token))
      .rejects.toThrow('broken');
  });

  test('releasing the extension closes its panels and unregisters its providers', async () => {
    const { proxy, editors, data } = setup();
    let panel: vscode.WebviewPanel | undefined;
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {
      resolveCustomTextEditor: (_document, webviewPanel) => { panel = webviewPanel; },
    });
    await editors.$resolveTextEditor('1', 'h1', data, origin, new CancellationTokenSource().token);
    const disposed = vi.fn();
    panel!.onDidDispose(disposed);
    editors.release('1');
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(proxy.$unregisterProvider).toHaveBeenCalledWith('1', 'test.editor');
    expect(proxy.$disposeEditor).not.toHaveBeenCalled();
  });
});

describe('custom documents', () => {
  function editableProvider() {
    const changes = new Emitter<vscode.CustomDocumentEditEvent | vscode.CustomDocumentContentChangeEvent>();
    const log: string[] = [];
    const provider: vscode.CustomEditorProvider = {
      onDidChangeCustomDocument: changes.event as vscode.Event<vscode.CustomDocumentEditEvent>,
      openCustomDocument: uri => { log.push('open'); return { uri, dispose: () => log.push('dispose') }; },
      resolveCustomEditor: (document, panel) => { log.push('resolve ' + document.uri.path); panel.webview.html = 'doc'; },
      saveCustomDocument: async () => { log.push('save'); },
      saveCustomDocumentAs: async (_document, target) => { log.push('saveAs ' + target.path); },
      revertCustomDocument: async () => { log.push('revert'); },
      backupCustomDocument: async () => ({ id: 'x', delete: () => {} }),
    };
    return { provider, changes, log };
  }

  test('opens a document once, resolves editors over it, routes edits, undo, save and revert, and disposes it', async () => {
    const { proxy, editors, data } = setup();
    const { provider, changes, log } = editableProvider();
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', provider);
    expect(proxy.$registerCustomEditorProvider).toHaveBeenCalledWith('1', 'test.editor',
      { enableFindWidget: false, retainContextWhenHidden: false }, false, true);
    const token = new CancellationTokenSource().token;
    await editors.$createCustomDocument('1', 'test.editor', resource, token);
    await expect(editors.$createCustomDocument('1', 'test.editor', resource, token)).rejects.toThrow(/already open/);
    await editors.$resolveCustomEditor('1', 'h1', data, origin, token);
    expect(log).toEqual(['open', 'resolve ' + resource.path]);

    // Events about documents the host does not know are not passed on.
    changes.fire({ document: { uri: resource as vscode.Uri, dispose: () => {} } });
    expect(proxy.$onDidChangeContent).not.toHaveBeenCalled();
    // The document the provider opened, as the host keeps it.
    const opened = [...(editors as unknown as { documentEntries: Map<string, { document: vscode.CustomDocument }> }).documentEntries.values()][0]!.document;
    const undo = vi.fn();
    const redo = vi.fn();
    changes.fire({ document: opened, undo, redo });
    changes.fire({ document: opened });
    expect(proxy.$onDidEdit).toHaveBeenCalledWith('1', 'test.editor', resource, 1);
    expect(proxy.$onDidChangeContent).toHaveBeenCalledWith('1', 'test.editor', resource);
    await editors.$undo('1', 'test.editor', resource, 1);
    await editors.$redo('1', 'test.editor', resource, 1);
    expect([undo.mock.calls.length, redo.mock.calls.length]).toEqual([1, 1]);
    await expect(editors.$undo('2', 'test.editor', resource, 1)).rejects.toThrow();
    await editors.$save('1', 'test.editor', resource, token);
    await editors.$saveAs('1', 'test.editor', resource, URI.parse('vscode-vfs://writing-room/workspace/b.bin'), token);
    await editors.$revert('1', 'test.editor', resource, token);
    await expect(editors.$undo('1', 'test.editor', resource, 1)).rejects.toThrow(/unknown/);
    await editors.$disposeCustomDocument('1', 'test.editor', resource);
    expect(log.slice(2)).toEqual(['save', 'saveAs /workspace/b.bin', 'revert', 'dispose']);
    await expect(editors.$resolveCustomEditor('1', 'h2', data, origin, token)).rejects.toThrow(/unavailable/);
  });

  test('a read-only provider registers as not editable, and a released extension disposes its documents', async () => {
    const { proxy, editors } = setup();
    const log: string[] = [];
    editors.registerProvider(extension('1', ['test.editor']), 'test.editor', {
      openCustomDocument: uri => ({ uri, dispose: () => log.push('dispose') }),
      resolveCustomEditor: () => {},
    });
    expect(proxy.$registerCustomEditorProvider).toHaveBeenCalledWith('1', 'test.editor', expect.anything(), false, false);
    await editors.$createCustomDocument('1', 'test.editor', resource, new CancellationTokenSource().token);
    await expect(editors.$save('1', 'test.editor', resource, new CancellationTokenSource().token)).rejects.toThrow();
    editors.release('1');
    expect(log).toEqual(['dispose']);
  });
});
