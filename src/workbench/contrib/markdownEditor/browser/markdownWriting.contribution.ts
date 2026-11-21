import type { Node } from 'prosemirror-model';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IStandaloneCodeEditor } from '../../../../editor/browser/monaco.js';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { viewContainersRegistry, viewsRegistry } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import { EXPLORER_VIEWLET_ID } from '../../files/browser/explorerActions.js';
import { getMarkdownEditorMode } from '../common/markdownEditor.js';
import { currentMarkdownHeading, markdownCounts, markdownHeadings } from '../common/markdownWriting.js';
import type { MarkdownCounts, MarkdownHeading } from '../common/markdownWriting.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';
import { sourceWritingPositions } from './markdownEditorSelection.js';

interface WritingState {
  readonly doc: Node;
  readonly from: number;
  readonly to: number;
  readonly head: number;
  readonly selected: boolean;
  /** Brings a pending source reparse up to date before positions are used. */
  sync?(): void;
  reveal(position: number): void;
}

class MarkdownOutline extends Disposable {
  private readonly root: HTMLUListElement;
  private readonly empty: HTMLParagraphElement;
  private headings: readonly MarkdownHeading[] = [];
  private buttons: HTMLButtonElement[] = [];
  private active = -1;

  constructor(parent: HTMLElement, reveal: (index: number) => void) {
    super();
    parent.classList.add('markdown-outline');
    this.root = parent.appendChild(parent.ownerDocument.createElement('ul'));
    this.root.setAttribute('aria-label', 'Document headings');
    this.empty = parent.appendChild(parent.ownerDocument.createElement('p'));
    this.empty.textContent = 'No Markdown headings';
    const click = (event: MouseEvent) => {
      const target = (event.target as Element).closest('button[data-heading-index]');
      if (target) reveal(Number(target.getAttribute('data-heading-index')));
    };
    this.root.addEventListener('click', click);
    this._register(toDisposable(() => this.root.removeEventListener('click', click)));
  }

  render(headings: readonly MarkdownHeading[], active: number): void {
    if (this.headings !== headings) {
      if (this.headings.length !== headings.length || headings.some(({ level, label }, index) =>
        level !== this.headings[index].level || label !== this.headings[index].label)) {
        this.root.replaceChildren();
        this.buttons = [];
        this.active = -1;
        const document = this.root.ownerDocument;
        const parents: { level: number; item: HTMLLIElement; list?: HTMLUListElement }[] = [];
        headings.forEach(({ level, label }, index) => {
          while (parents.length && parents.at(-1)!.level >= level) parents.pop();
          const parent = parents.at(-1);
          const list = parent ? parent.list ??= parent.item.appendChild(document.createElement('ul')) : this.root;
          const item = list.appendChild(document.createElement('li'));
          const button = item.appendChild(document.createElement('button'));
          button.type = 'button';
          button.textContent = label;
          button.title = label;
          button.dataset.headingIndex = String(index);
          this.buttons.push(button);
          parents.push({ level, item });
        });
      }
      this.headings = headings;
    }
    this.empty.hidden = headings.length !== 0;
    if (active !== this.active) {
      this.buttons[this.active]?.removeAttribute('aria-current');
      this.buttons[active]?.setAttribute('aria-current', 'location');
      this.active = active;
    }
  }
}

class MarkdownWritingContribution extends Disposable {
  private readonly outlineViews = new Set<MarkdownOutline>();
  private readonly reading = this._register(new DisposableStore());
  private readonly sourceControl = this._register(new DisposableStore());
  private readonly sourceListeners = this._register(new DisposableStore());
  private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
  private state: WritingState | undefined;
  private cachedDoc: Node | undefined;
  private counts: MarkdownCounts | undefined;
  private headings: readonly MarkdownHeading[] = [];
  private active = -1;
  private status = '';
  /** Edits to the document being followed recount after typing pauses; a new document counts at once. */
  private readonly recount = this._register(new RunOnceScheduler(() => this.refresh(), 300));
  private immediate = true;

  constructor(
    @IEditorService private readonly editors: IEditorService,
    @IStatusbarService private readonly statusbar: IStatusbarService,
  ) {
    super();
    const explorer = viewContainersRegistry.get(EXPLORER_VIEWLET_ID);
    if (explorer) {
      const descriptor = {
        id: 'workbench.views.markdownOutline', name: 'Outline',
        renderBody: (parent: HTMLElement) => {
          const outline = new MarkdownOutline(parent, index => {
            this.state?.sync?.();
            if (this.recount.isScheduled()) this.refresh();
            const heading = this.headings[index];
            if (heading) this.state?.reveal(heading.position);
          });
          this.outlineViews.add(outline);
          outline.render(this.headings, this.active);
          return { dispose: () => { this.outlineViews.delete(outline); outline.dispose(); } };
        },
      };
      viewsRegistry.registerViews([descriptor], explorer);
      this._register(toDisposable(() => viewsRegistry.deregisterViews([descriptor], explorer)));
    }
    this._register(editors.onDidActiveEditorChange(() => this.followEditor()));
    this.followEditor();
  }

  private followEditor(): void {
    this.immediate = true;
    this.reading.clear();
    this.sourceControl.clear();
    this.sourceListeners.clear();
    const pane = this.editors.activeEditorPane;
    const mode = getMarkdownEditorMode(this.editors.activeEditor);
    if (mode === 'wysiwyg' && pane instanceof MarkdownEditorPane) {
      const update = () => {
        const state = pane.writingState;
        const selection = state?.selection;
        this.update(state && selection ? {
          doc: state.doc, from: selection.from, to: selection.to, head: selection.head, selected: !selection.empty,
          reveal: position => pane.revealWritingPosition(position),
        } : undefined);
      };
      this.reading.add(pane.onDidChangeWritingState(update));
      update();
    } else if (mode === 'source' && pane instanceof TextFileEditor) {
      let control: IStandaloneCodeEditor | undefined;
      const followControl = () => {
        const nextControl = pane.getControl();
        if (nextControl === control) return;
        control = nextControl;
        this.sourceControl.clear();
        const followModel = () => {
          this.immediate = true;
          this.sourceListeners.clear();
          if (nextControl) this.followSource(nextControl);
          else this.update(undefined);
        };
        if (nextControl) this.sourceControl.add(nextControl.onDidChangeModel(followModel));
        followModel();
      };
      this.update(undefined);
      this.reading.add(pane.onDidChangeControl(followControl));
      followControl();
    } else {
      this.update(undefined);
    }
  }

  private followSource(control: IStandaloneCodeEditor): void {
    const model = control.getModel();
    if (!model) {
      this.update(undefined);
      return;
    }
    let version = -1;
    let parsed: ReturnType<typeof parseMarkdownWithSource>;
    let positions: ReturnType<typeof sourceWritingPositions>;
    // Parsing the whole source is the expensive part, so typing reparses only after a pause.
    const reparse = new RunOnceScheduler(() => update(), 300);
    this.sourceListeners.add(reparse);
    const update = () => {
      reparse.cancel();
      if (version !== model.getVersionId()) {
        version = model.getVersionId();
        parsed = parseMarkdownWithSource(model.getValue());
        positions = sourceWritingPositions(model, parsed);
      }
      const selection = control.getSelection();
      const from = selection ? positions.toDocument(model.getOffsetAt(selection.getStartPosition())) : 0;
      const to = selection ? positions.toDocument(model.getOffsetAt(selection.getEndPosition())) : from;
      const head = selection ? positions.toDocument(model.getOffsetAt(selection.getPosition())) : from;
      this.immediate = true;
      this.update({
        doc: parsed.doc, from, to, head, selected: selection ? !selection.isEmpty() : false,
        sync: () => {
          if (version !== model.getVersionId()) update();
        },
        reveal: position => {
          const source = model.getPositionAt(positions.toSource(position));
          control.setPosition(source);
          control.revealPositionInCenter(source);
          control.focus();
        },
      });
    };
    this.sourceListeners.add(model.onDidChangeContent(() => reparse.schedule()));
    this.sourceListeners.add(control.onDidChangeCursorSelection(() => {
      if (version === model.getVersionId()) update();
      else reparse.schedule();
    }));
    update();
  }

  private update(state: WritingState | undefined): void {
    this.state = state;
    const immediate = this.immediate || !state || !this.counts;
    this.immediate = false;
    if (state?.doc === this.cachedDoc) {
      this.render();
    } else if (immediate) {
      this.refresh();
    } else {
      this.recount.schedule();
      this.render();
    }
  }

  private refresh(): void {
    const { state } = this;
    if (state?.doc !== this.cachedDoc) {
      this.recount.cancel();
      this.cachedDoc = state?.doc;
      this.counts = state && markdownCounts(state.doc);
      this.headings = state ? markdownHeadings(state.doc) : [];
    }
    this.render();
  }

  private render(): void {
    const { state } = this;
    this.active = state ? currentMarkdownHeading(this.headings, state.head) : -1;
    for (const outline of this.outlineViews) outline.render(this.headings, this.active);
    if (!state || !this.counts) {
      this.entry.clear();
      this.status = '';
      return;
    }
    const { characters, nonWhitespace, words } = state.selected ? markdownCounts(state.doc, state.from, state.to) : this.counts;
    const wordLabel = words === 1 ? 'word' : 'words';
    const characterLabel = characters === 1 ? 'character' : 'characters';
    const text = `${state.selected ? 'Selection · ' : ''}${words} ${wordLabel} · ${characters} ${characterLabel} · ${nonWhitespace} without spaces`;
    if (text === this.status) return;
    this.status = text;
    const entry = { name: 'Markdown Word Count', text, ariaLabel: text, tooltip: text };
    if (this.entry.value) this.entry.value.update(entry);
    else this.entry.value = this.statusbar.addEntry(entry, 'status.markdown.counts', StatusbarAlignment.RIGHT, 100);
  }
}

registerWorkbenchContribution2('workbench.contrib.markdownWriting', MarkdownWritingContribution);
