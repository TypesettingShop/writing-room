// The one file that imports `monaco-editor`. The package is large and has workers of its own, so it
// is loaded on demand: the first text editor that opens pays for it, the first paint does not.
import type * as Monaco from 'monaco-editor';
import type { KeyCodeChord } from '../../base/common/keybindings.js';
import type { ITextModel } from '../common/model.js';
import { announceEditorLoaded } from '../../platform/theme/browser/editorThemeHook.js';
import { installCodeActionStateOrder } from './codeActionStateOrder.js';
import { editorTextModelResolver } from './textModelServiceHook.js';

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

interface MonacoModelReference {
  readonly object: { readonly textEditorModel: unknown };
  dispose(): void;
}

/** Monaco's standalone text model service: models that exist already, and synthetic documents it owns. */
interface InMemoryTextModelServiceClass {
  new (...services: never[]): { createModelReference(resource: { toString(): string }): Promise<MonacoModelReference> };
}

/**
 * Monaco's text model service with the workbench in front: a resource the workbench resolves (an
 * unopened workspace file, say) comes from the workbench's resolver under its reference; everything else
 * (no workbench on the page, `inmemory` synthetic documents) stays with Monaco's own service.
 */
function workbenchTextModelService(InMemoryTextModelService: InMemoryTextModelServiceClass) {
  return class WorkbenchTextModelService extends InMemoryTextModelService {
    override createModelReference(resource: { toString(): string }): Promise<MonacoModelReference> {
      const resolver = editorTextModelResolver();
      const uri = resource.toString();
      if (!resolver?.canResolve(uri)) {
        return super.createModelReference(resource);
      }
      return resolver.resolve(uri).then(({ model, dispose }) => ({ object: { textEditorModel: model }, dispose }));
    }
  };
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

let removeUndoHistory: ((resource: string) => void) | undefined;

/** Starts a new Monaco undo history without replacing, detaching or dirtying the text model. */
export function clearMonacoUndoHistory(model: ITextModel): void {
  removeUndoHistory?.(model.uri.toString());
}

async function load(): Promise<MonacoNamespace> {
  // Monaco reads the environment when it starts its first worker, so it has to stand before then.
  globalThis.MonacoEnvironment = {
    getWorker: async (_workerId, label) => {
      const { default: WorkerConstructor } = await importWorker(label);
      return new WorkerConstructor({ name: label });
    },
  };
  const [
    monaco, { StandaloneServices }, { IKeybindingService }, { StandardKeyboardEvent },
    { InMemoryTextModelService }, { SyncDescriptor }, codeActions, { IUndoRedoService },
  ] = await Promise.all([
    import('monaco-editor'),
    // @ts-expect-error Monaco exports this standalone service entry point without declarations.
    import('monaco-editor/editor/standalone/browser/standaloneServices.js'),
    // @ts-expect-error Monaco exports this service identifier without declarations.
    import('monaco-editor/platform/keybinding/common/keybinding.js'),
    // @ts-expect-error Monaco exports its keyboard event adapter without declarations.
    import('monaco-editor/base/browser/keyboardEvent.js'),
    // @ts-expect-error Monaco exports its standalone text model service without declarations.
    import('monaco-editor/editor/common/services/inMemoryTextModelService.js'),
    // @ts-expect-error Monaco exports its service descriptor without declarations.
    import('monaco-editor/platform/instantiation/common/descriptors.js'),
    // @ts-expect-error Monaco exports its standalone code action model without declarations.
    import('monaco-editor/editor/contrib/codeAction/browser/codeActionModel.js'),
    // @ts-expect-error Monaco exports its resource undo service without declarations.
    import('monaco-editor/platform/undoRedo/common/undoRedo.js'),
  ]);
  installCodeActionStateOrder(codeActions.CodeActionModel?.prototype);
  // Monaco takes overrides only when it first makes its services, which the theme below already does;
  // later ones (the third argument of editor.create) are ignored without a word. So this comes first.
  StandaloneServices.initialize({ textModelService: new SyncDescriptor(workbenchTextModelService(InMemoryTextModelService)) });
  // The theme service gives Monaco the workbench's color theme here, before the first editor exists. A
  // page without one, such as the editor harness, keeps v0.1.0's theme.
  if (!announceEditorLoaded(monaco)) {
    monaco.editor.setTheme('vs-dark');
  }
  // F1 belongs to the workbench's command palette, not to Monaco's own.
  monaco.editor.addKeybindingRule({ keybinding: monaco.KeyCode.F1, command: '-editor.action.quickCommand' });

  removeUndoHistory = resource => {
    const undoRedo: { removeElements(resource: ReturnType<typeof monaco.Uri.parse>): void } = StandaloneServices.get(IUndoRedoService);
    undoRedo.removeElements(monaco.Uri.parse(resource));
  };
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
