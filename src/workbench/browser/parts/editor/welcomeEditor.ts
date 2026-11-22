import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ManuscriptWork } from '../../../../platform/manuscript/common/manuscript.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../common/editor.js';
import type { IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IManuscriptService } from '../../../services/manuscript/common/manuscriptService.js';
import { IWorkService } from '../../../services/work/common/work.js';
import { EditorPane } from './editorPane.js';
import './media/welcomeEditor.css';

/** The Welcome page. There is one: every Welcome input matches every other. */
export class WelcomeEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.gettingStartedInput';

  override get typeId(): string {
    return WelcomeEditorInput.ID;
  }

  override get resource(): URI | undefined {
    return undefined;
  }

  override getName(): string {
    return 'Welcome';
  }

  override matches(other: EditorInput): boolean {
    return other instanceof WelcomeEditorInput;
  }
}

/** Reuse the Welcome tab even when it is in another group. */
export function openWelcome(groups: IEditorGroupsService, preserveFocus = false) {
  for (const group of [groups.activeGroup, ...groups.groups]) {
    const existing = group.editors.find(editor => editor instanceof WelcomeEditorInput);
    if (existing) {
      return group.openEditor(existing, { preserveFocus });
    }
  }
  return groups.activeGroup.openEditor(new WelcomeEditorInput(), { preserveFocus });
}

export class WelcomePageContribution {
  static readonly ID = 'workbench.contrib.welcomePage';

  constructor(@IEditorGroupsService groups: IEditorGroupsService) {
    if (window.location.hash === '#works') {
      void this.openWorks(groups).catch(console.error);
    } else if (!groups.hasStoredState) {
      void openWelcome(groups, true).catch(console.error);
    }
  }

  private async openWorks(groups: IEditorGroupsService): Promise<void> {
    try {
      const pane = await openWelcome(groups);
      if (pane instanceof WelcomeEditorPane && window.location.hash === '#works') {
        pane.focusWorks();
      }
    } finally {
      // Consume the hash even when the Welcome did not open, so a later reload does not try again.
      if (window.location.hash === '#works') {
        const url = new URL(window.location.href);
        url.hash = '';
        window.history.replaceState(window.history.state, '', url);
      }
    }
  }
}

/** The Welcome page, including the works the current account can open. */
export class WelcomeEditorPane extends EditorPane {
  static readonly ID = 'gettingStartedPage';

  private page!: HTMLElement;
  private works!: HTMLElement;
  private worksStatus!: HTMLElement;
  private worksList!: HTMLUListElement;
  private readonly workButtons = this._register(new DisposableStore());
  private renderedWorks: string | undefined;
  private generation = 0;
  private lastRefresh = 0;

  constructor(
    @ICommandService private readonly commandService: ICommandService,
    @IManuscriptService private readonly manuscript: IManuscriptService,
    @IWorkService private readonly work: IWorkService,
  ) {
    super(WelcomeEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.page = append(parent, $('.welcome-page', { role: 'document', 'aria-label': 'Welcome', tabindex: -1 }));
    append(this.page, $('h1', null, 'writing-room'));
    append(this.page, $('p', null, 'A VS Code style workbench in the browser.'));
    append(this.page, $('h2', null, 'Start'));
    const start = append(this.page, $('ul'));
    const newFile = append(append(start, $('li')), $('button', { type: 'button' }, 'New Text File...'));
    this._register(addDisposableListener(newFile, 'click', () => {
      void this.commandService.executeCommand('workbench.action.files.newUntitledFile');
    }));

    this.works = append(this.page, $('section', { 'aria-label': 'Works', tabindex: -1 }));
    append(this.works, $('h2', null, 'Works'));
    append(this.works, $('.welcome-works-account'));
    const newWork = append(this.works, $('button', { type: 'button' }, 'New Work...'));
    this._register(addDisposableListener(newWork, 'click', () => {
      void this.commandService.executeCommand('work.new');
    }));
    this.worksStatus = append(this.works, $('p', { role: 'status' }));
    this.worksList = append(this.works, $('ul'));
    // A request that never settles must not stop later reads, so only the 30-second spacing limits them.
    this._register(addDisposableListener(parent.ownerDocument.defaultView!, 'focus', () => {
      if (this.input && Date.now() - this.lastRefresh >= 30_000) {
        void this.refreshWorks();
      }
    }));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    const wasVisible = this.input === input;
    await super.setInput(input, options);
    if (!wasVisible && this.input === input) {
      void this.refreshWorks();
    }
  }

  override clearInput(): void {
    super.clearInput();
    this.generation++;
  }

  private async refreshWorks(): Promise<void> {
    const generation = ++this.generation;
    this.lastRefresh = Date.now();
    // Keep the buttons until the answer arrives. The click that brings the window back fires `focus`
    // first, and clearing the list then would drop that click.
    if (!this.worksList.childElementCount) {
      this.worksStatus.textContent = 'Loading Works...';
    }

    try {
      const works = await this.manuscript.store.listWorks();
      if (generation === this.generation) {
        this.renderWorks(works);
      }
    } catch {
      if (generation === this.generation) {
        this.clearWorks();
        this.worksStatus.textContent = this.manuscript.availability === 'signedOut'
          ? 'Sign in to see your Works.'
          : 'The Works server is not available.';
      }
    }
  }

  private clearWorks(): void {
    this.renderedWorks = undefined;
    this.workButtons.clear();
    this.worksList.replaceChildren();
  }

  private renderWorks(works: ManuscriptWork[]): void {
    this.worksStatus.textContent = works.length ? '' : 'No Works yet.';
    const recent = [...works].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    const entries: [label: string, id?: string][] = recent.slice(0, 20).map(entry =>
      [entry.title + (entry.id === this.work.current?.id ? ' (current)' : ''), entry.id]);
    if (recent.length > 20) {
      entries.push(['More...']);
    }
    // An unchanged list keeps its buttons, so a press in progress still ends in a click.
    const rendered = JSON.stringify(entries);
    if (rendered === this.renderedWorks) {
      return;
    }
    this.clearWorks();
    this.renderedWorks = rendered;
    for (const [label, id] of entries) {
      this.addWorkButton(label, id);
    }
  }

  private addWorkButton(label: string, id?: string): void {
    const button = append(append(this.worksList, $('li')), $('button', { type: 'button' }));
    button.textContent = label;
    this.workButtons.add(addDisposableListener(button, 'click', () => {
      void this.commandService.executeCommand('work.open', id);
    }));
  }

  focusWorks(): void {
    this.works.focus();
  }

  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void {
    this.page.focus({ preventScroll: true });
  }

  override dispose(): void {
    this.clearInput();
    super.dispose();
    this.page?.remove();
  }
}

class WelcomeEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof WelcomeEditorInput;
  }

  serialize(): string {
    return '';
  }

  deserialize(_instantiationService: unknown, value: string): EditorInput | undefined {
    return value === '' ? new WelcomeEditorInput() : undefined;
  }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(WelcomeEditorInput.ID, WelcomeEditorSerializer);
