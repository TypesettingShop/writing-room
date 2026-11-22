import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';

export function usesMarkdownlintDocumentAliases(extension: HostExtensionDescription): boolean {
  return extension.id.toLowerCase() === 'davidanson.vscode-markdownlint' && extension.manifest.version === '0.62.1';
}

/** markdownlint 0.62.1 accepts gist documents and lints their in-memory text without probing a file system. */
export class ExtHostMarkdownlintDocuments {
  private readonly documents = new WeakMap<vscode.TextDocument, vscode.TextDocument>();
  private readonly editors = new WeakMap<vscode.TextEditor, vscode.TextEditor>();
  private readonly resources = new WeakMap<vscode.Uri, vscode.Uri>();

  document(document: vscode.TextDocument): vscode.TextDocument {
    if (document.uri.scheme !== 'manuscript') {
      return document;
    }
    let view = this.documents.get(document);
    if (!view) {
      const original = document.uri;
      const uri = URI.from({
        scheme: 'gist', authority: 'writing-room-manuscript', path: '/' + original.authority + original.path,
      }) as unknown as vscode.Uri;
      view = withProperties(document, { uri, fileName: uri.fsPath });
      this.documents.set(document, view);
      this.resources.set(uri, original);
    }
    return view;
  }

  editor(editor: vscode.TextEditor): vscode.TextEditor {
    const document = this.document(editor.document);
    if (document === editor.document) {
      return editor;
    }
    let view = this.editors.get(editor);
    if (!view) {
      view = withProperties(editor, { document });
      this.editors.set(editor, view);
    }
    return view;
  }

  resource(uri: vscode.Uri): vscode.Uri {
    // Only URIs issued by this host are aliases. A parsed or fabricated gist URI remains a gist URI.
    return this.resources.get(uri) ?? uri;
  }
}

function withProperties<T extends object>(value: T, replacements: Partial<T>): T {
  // Keep the live document and editor getters, as well as editor setters and methods bound to their model.
  return Object.freeze(Object.defineProperties({}, {
    ...Object.getOwnPropertyDescriptors(value),
    ...Object.getOwnPropertyDescriptors(replacements),
  })) as T;
}
