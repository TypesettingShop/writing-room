// The one file that imports `monaco-editor`. The package is large and has workers of its own, so it
// is loaded on demand: the first text editor that opens pays for it, the first paint does not.
import type * as Monaco from 'monaco-editor';
import { announceEditorLoaded } from '../../platform/theme/browser/editorThemeHook.js';

export type MonacoNamespace = typeof Monaco;
export type IStandaloneCodeEditor = Monaco.editor.IStandaloneCodeEditor;
export type IStandaloneEditorConstructionOptions = Monaco.editor.IStandaloneEditorConstructionOptions;
export type ICodeEditorViewState = Monaco.editor.ICodeEditorViewState;
export type IMonacoTextModel = Monaco.editor.ITextModel;

type WorkerModule = { default: new (options?: { name?: string }) => Worker };

/**
 * The worker for a label Monaco asks for. Each import names the file the package's `exports` map
 * resolves (`./*.js` is `./esm/vs/*.js`), so the bundler emits each worker as its own chunk.
 */
function importWorker(label: string): Promise<WorkerModule> {
  switch (label) {
    case 'json':
      return import('monaco-editor/language/json/json.worker.js?worker');
    case 'css':
    case 'scss':
    case 'less':
      return import('monaco-editor/language/css/css.worker.js?worker');
    case 'html':
    case 'handlebars':
    case 'razor':
      return import('monaco-editor/language/html/html.worker.js?worker');
    case 'typescript':
    case 'javascript':
      return import('monaco-editor/language/typescript/ts.worker.js?worker');
    default:
      return import('monaco-editor/editor/editor.worker.js?worker');
  }
}

async function load(): Promise<MonacoNamespace> {
  // Monaco reads the environment when it starts its first worker, so it has to stand before then.
  globalThis.MonacoEnvironment = {
    getWorker: async (_workerId, label) => {
      const { default: WorkerConstructor } = await importWorker(label);
      return new WorkerConstructor({ name: label });
    },
  };
  const monaco = await import('monaco-editor');
  // The theme service gives Monaco the workbench's color theme here, before the first editor exists. A
  // page without one, such as the editor harness, keeps v0.1.0's theme.
  if (!announceEditorLoaded(monaco)) {
    monaco.editor.setTheme('vs-dark');
  }
  // F1 belongs to the workbench's command palette, not to Monaco's own.
  monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: '-editor.action.quickCommand' });
  return monaco;
}

let loading: Promise<MonacoNamespace> | undefined;

/**
 * Loads the package once and returns its namespace. Loading is a network request; when it fails the
 * returned promise rejects and the next call tries again.
 */
export function loadMonaco(): Promise<MonacoNamespace> {
  loading ??= load().catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}
