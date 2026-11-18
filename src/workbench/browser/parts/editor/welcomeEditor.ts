import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
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

/**
 * The pane of the Welcome page: a plain page, with no state of its own. VS Code's Getting Started
 * page lives in `contrib/welcomeGettingStarted`; this one is a small page beside the editor part.
 */
export class WelcomeEditorPane extends EditorPane {
  static readonly ID = 'gettingStartedPage';

  private page!: HTMLElement;

  constructor(@ICommandService private readonly commandService: ICommandService) {
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
  }

  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void {
    this.page.focus({ preventScroll: true });
  }

  override dispose(): void {
    super.dispose();
    this.page?.remove();
  }
}

/** Opens the Welcome page in the first group when the workbench starts with no editor open. */
export class WelcomePageContribution extends Disposable {
  static readonly ID = 'workbench.contrib.welcomePage';

  constructor(@IEditorGroupsService editorGroupsService: IEditorGroupsService) {
    super();
    const group = editorGroupsService.activeGroup;
    if (editorGroupsService.count === 1 && group.isEmpty) {
      void group.openEditor(new WelcomeEditorInput(), { preserveFocus: true });
    }
  }
}
