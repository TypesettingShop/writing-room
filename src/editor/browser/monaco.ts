// The one file that imports `monaco-editor`. The package is large and has workers of its own, so it
// is loaded on demand: the first text editor that opens pays for it, the first paint does not.
import type * as Monaco from 'monaco-editor';
import type { KeyCodeChord } from '../../base/common/keybindings.js';
import { announceEditorLoaded } from '../../platform/theme/browser/editorThemeHook.js';

export type MonacoNamespace = typeof Monaco;
export type IStandaloneCodeEditor = Monaco.editor.IStandaloneCodeEditor;
export type IStandaloneEditorConstructionOptions = Monaco.editor.IStandaloneEditorConstructionOptions;
export type ICodeEditorViewState = Monaco.editor.ICodeEditorViewState;
export type IMonacoTextModel = Monaco.editor.ITextModel;

type WorkerModule = { default: new (options?: { name?: string }) => Worker };

type MonacoKeypress = Pick<KeyCodeChord, 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'> & { readonly keyCode: number };

interface StandaloneKeybindings {
  readonly inChordMode: boolean;
  resolveKeyboardEvent(event: MonacoKeypress): { getDispatchChords(): readonly (string | null)[] };
  softDispatch(event: MonacoKeypress, target: HTMLElement): { kind: number };
  dispatchEvent(event: MonacoKeypress, target: HTMLElement): boolean;
}

// Monaco erases ResultKind in the published JavaScript.
const monacoMoreChordsNeeded = 1;

let dispatchChordPrefix: ((prefix: KeyCodeChord, continuation: KeyboardEvent, target: HTMLElement) => boolean | undefined) | undefined;

/**
 * Lets Monaco finish a workbench prefix with the actual continuation, at once, so Monaco's chord ends with this
 * event. `undefined` when Monaco does not take it (not loaded yet, in a chord of its own, a continuation it
 * cannot read, or no chord for the prefix there); otherwise whether Monaco wants the continuation's default
 * action prevented.
 */
export function forwardMonacoChordPrefix(prefix: KeyCodeChord, continuation: KeyboardEvent, target: HTMLElement): boolean | undefined {
  return dispatchChordPrefix?.(prefix, continuation, target);
}

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
  const [monaco, { StandaloneServices }, { IKeybindingService }, { StandardKeyboardEvent }] = await Promise.all([
    import('monaco-editor'),
    // @ts-expect-error Monaco exports this standalone service entry point without declarations.
    import('monaco-editor/editor/standalone/browser/standaloneServices.js'),
    // @ts-expect-error Monaco exports this service identifier without declarations.
    import('monaco-editor/platform/keybinding/common/keybinding.js'),
    // @ts-expect-error Monaco exports its keyboard event adapter without declarations.
    import('monaco-editor/base/browser/keyboardEvent.js'),
  ]);
  // The theme service gives Monaco the workbench's color theme here, before the first editor exists. A
  // page without one, such as the editor harness, keeps v0.1.0's theme.
  if (!announceEditorLoaded(monaco)) {
    monaco.editor.setTheme('vs-dark');
  }
  // F1 belongs to the workbench's command palette, not to Monaco's own.
  monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: '-editor.action.quickCommand' });

  const keybindings: StandaloneKeybindings = StandaloneServices.get(IKeybindingService);
  dispatchChordPrefix = (prefix, continuation, target) => {
    // Monaco leaves its chord pending when it gets a key it cannot dispatch.
    const key = new StandardKeyboardEvent(continuation);
    if (keybindings.inChordMode || keybindings.resolveKeyboardEvent(key).getDispatchChords()[0] == null) {
      return undefined;
    }
    // The prefix uses the shared KeyCode values; the real continuation uses Monaco's layout and context.
    if (keybindings.softDispatch(prefix, target).kind !== monacoMoreChordsNeeded || !keybindings.dispatchEvent(prefix, target)) {
      return undefined;
    }
    // Resolved here rather than at the editor's own listener: a widget on the way there (a find toggle on
    // Space, the multi-line find input on an arrow) would act on the key and could stop it, leaving the chord
    // pending to eat the next key.
    return keybindings.dispatchEvent(key, target);
  };
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
