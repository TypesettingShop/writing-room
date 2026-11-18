import '../../src/workbench/platformServices.contribution.js';
import '../../src/workbench/browser/parts/editor/editor.contribution.js';
import { Dimension } from '../../src/base/browser/dom.js';
import { loadMonaco } from '../../src/editor/browser/monaco.js';
import { EditorContextKeys } from '../../src/editor/common/editorContextKeys.js';
import { IContextKeyService } from '../../src/platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../../src/platform/instantiation/common/instantiationService.js';
import { Registry } from '../../src/platform/registry/common/platform.js';
import { EditorExtensions } from '../../src/workbench/browser/editor.js';
import type { IEditorPaneRegistry } from '../../src/workbench/browser/editor.js';
import type { EditorPane } from '../../src/workbench/browser/parts/editor/editorPane.js';
import { UntitledTextEditorInput } from '../../src/workbench/services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../src/workbench/services/untitled/common/untitledTextEditorService.js';

const instantiation = new InstantiationService();
const contextKeys = instantiation.invokeFunction(accessor => accessor.get(IContextKeyService));
const untitled = instantiation.invokeFunction(accessor => accessor.get(IUntitledTextEditorService));
const panes = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;

const inputs: UntitledTextEditorInput[] = [];
const select = document.querySelector<HTMLSelectElement>('select')!;
const output = (name: string) => document.querySelector<HTMLOutputElement>(`output[aria-label="${name}"]`)!;
const region = (name: string) => document.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;

interface IHost {
  readonly element: HTMLElement;
  pane: EditorPane | undefined;
  size: Dimension;
}

function createHost(name: string, size: Dimension): IHost {
  const element = region(name).appendChild(document.createElement('div'));
  return { element, pane: undefined, size };
}

const hosts = {
  left: createHost('Left Pane', new Dimension(360, 220)),
  right: createHost('Right Pane', new Dimension(360, 220)),
};

function layout(host: IHost): void {
  host.element.style.width = `${host.size.width}px`;
  host.element.style.height = `${host.size.height}px`;
  host.pane?.layout(host.size);
}

function paneFor(host: IHost, input: UntitledTextEditorInput): EditorPane {
  if (!host.pane) {
    host.pane = panes.getEditorPane(input)!.instantiate(instantiation);
    host.pane.create(host.element);
    layout(host);
  }
  return host.pane;
}

async function show(host: IHost, input: UntitledTextEditorInput | undefined): Promise<void> {
  if (input) {
    const pane = paneFor(host, input);
    await pane.setInput(input, undefined);
    pane.focus();
    await refreshModels();
  }
}

function selected(): UntitledTextEditorInput | undefined {
  return inputs.find(input => input.resource.toString() === select.value);
}

function refreshInputs(): void {
  const live = inputs.filter(input => !input.isDisposed());
  inputs.splice(0, inputs.length, ...live);
  const value = select.value;
  select.replaceChildren(...live.map(input => new Option(input.getName(), input.resource.toString())));
  select.value = live.some(input => input.resource.toString() === value) ? value : live.at(-1)?.resource.toString() ?? '';
  output('Inputs').value = live.map(input => input.getName() + (input.isDirty() ? '*' : '')).join(' ');
}

let monacoLoaded = false;
async function refreshModels(): Promise<void> {
  // Only after an editor asked for it: the harness must not load Monaco on its own.
  if (monacoLoaded) {
    const monaco = await loadMonaco().catch(() => undefined);
    output('Models').value = monaco?.editor.getModels().map(model => model.uri.toString()).join(' ') ?? '';
  }
}

function refreshFocusKeys(): void {
  const context = contextKeys.getContext(document.activeElement);
  output('Focus Keys').value = [EditorContextKeys.editorTextFocus, EditorContextKeys.focus, EditorContextKeys.textInputFocus]
    .filter(key => context.getValue(key.key) === true)
    .map(key => key.key)
    .join(' ');
}

const actions: Record<string, () => unknown> = {
  'New Untitled': async () => {
    const input = new UntitledTextEditorInput(untitled.create());
    inputs.push(input);
    input.onDidChangeDirty(refreshInputs);
    input.onWillDispose(() => queueMicrotask(() => {
      refreshInputs();
      void refreshModels();
    }));
    refreshInputs();
    select.value = input.resource.toString();
    monacoLoaded = true;
    await show(hosts.left, input);
  },
  'Show Left': () => show(hosts.left, selected()),
  'Show Right': () => show(hosts.right, selected()),
  'Clear Left': () => hosts.left.pane?.clearInput(),
  'Clear Right': () => hosts.right.pane?.clearInput(),
  'Close Input': () => selected()?.dispose(),
  'Dispose Left Pane': () => {
    hosts.left.pane?.dispose();
    hosts.left.pane = undefined;
    hosts.left.element.replaceChildren();
  },
  'Resize Left': () => {
    hosts.left.size = new Dimension(520, 300);
    layout(hosts.left);
  },
  'Move Left': () => {
    region('Elsewhere').append(hosts.left.element);
    hosts.left.size = new Dimension(300, 180);
    layout(hosts.left);
  },
  // Same size as before, so only the move asks the editor to draw again.
  'Move Left Back': () => {
    region('Left Pane').append(hosts.left.element);
    layout(hosts.left);
  },
  'Start Workers': async () => {
    const labels = ['editorWorkerService', 'json', 'css', 'html', 'typescript'];
    await loadMonaco();
    const workers = await Promise.all(labels.map(label => globalThis.MonacoEnvironment!.getWorker!('workerMain.js', label)));
    output('Workers').value = `${workers.length} started`;
  },
};

for (const button of document.querySelectorAll('button')) {
  button.addEventListener('click', () => void actions[button.textContent!]());
}
window.addEventListener('focusin', () => setTimeout(refreshFocusKeys));
window.addEventListener('focusout', () => setTimeout(refreshFocusKeys));
