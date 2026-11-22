import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { manuscriptNodeTypes, normalizeManuscriptTitle } from '../../../../platform/manuscript/common/manuscript.js';
import { labelOf } from '../common/manuscriptTree.js';
import { IManuscriptViewState, type ManuscriptViewState } from './manuscriptViewState.js';
import './media/properties.css';

const kindLabels = { part: 'Part', chapter: 'Chapter', document: 'Document' };
let nextPropertiesId = 0;

interface PropertyField {
  readonly row: HTMLDivElement;
  readonly value: HTMLElement;
}

interface Draft {
  readonly nodeId: string;
  revision: number;
}

export class PropertiesView extends Disposable {
  private readonly hint: HTMLParagraphElement;
  private readonly fields: HTMLDListElement;
  private readonly title: HTMLInputElement;
  private readonly message: HTMLDivElement;
  private readonly kind: PropertyField;
  private readonly label: PropertyField;
  private readonly created: PropertyField;
  private readonly updated: PropertyField;
  private readonly contents: PropertyField;
  private nodeId: string | undefined;
  private draft: Draft | undefined;

  constructor(parent: HTMLElement, @IManuscriptViewState private readonly state: ManuscriptViewState) {
    super();
    const document = parent.ownerDocument;
    const id = `manuscript-properties-${++nextPropertiesId}`;
    parent.classList.add('manuscript-properties');
    this.hint = document.createElement('p');
    this.hint.className = 'manuscript-properties-hint';
    this.fields = document.createElement('dl');

    this.title = document.createElement('input');
    this.title.type = 'text';
    this.title.id = id + '-title';
    this.title.setAttribute('aria-describedby', id + '-error');
    const titleLabel = document.createElement('label');
    titleLabel.htmlFor = this.title.id;
    titleLabel.textContent = 'Title';
    const titleField = this.field(titleLabel);
    this.message = document.createElement('div');
    this.message.setAttribute('role', 'alert');
    this.message.id = id + '-error';
    this.message.hidden = true;
    titleField.value.append(this.title, this.message);

    this.kind = this.field('Kind');
    this.label = this.field('Label');
    this.created = this.field('Created');
    this.updated = this.field('Updated');
    this.contents = this.field('Contents');
    parent.append(this.hint, this.fields);

    this._register(this.state.onDidChange(() => this.render()));
    this._register(addDisposableListener(this.title, 'input', () => {
      if (!this.draft && this.nodeId && this.state.revision !== undefined) {
        this.draft = { nodeId: this.nodeId, revision: this.state.revision };
      }
      this.showError('');
    }));
    this._register(addDisposableListener(this.title, 'keydown', event => {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void this.commit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.discard();
      }
    }));
    this._register(addDisposableListener(this.title, 'blur', () => void this.commit()));
    // A pointer can blur the field before the row's click changes the selection.
    // Treat this gesture as leaving the selection, even if blur runs first.
    this._register(addDisposableListener(document, 'pointerdown', event => {
      const target = event.target as HTMLElement | null;
      const item = target?.closest<HTMLElement>('.manuscript-row');
      if (item && !target?.closest('button') && this.draft &&
          (item.dataset.key !== this.draft.nodeId || event.ctrlKey || event.metaKey)) {
        this.discard();
      }
    }, true));
    this.render();
    void this.state.ensureLoaded();
  }

  private field(name: string | HTMLLabelElement): PropertyField {
    const document = this.fields.ownerDocument;
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    term.append(name);
    row.append(term, value);
    this.fields.append(row);
    return { row, value };
  }

  private render(): void {
    const node = this.state.singleSelection();
    const index = this.state.index;
    const count = this.state.selected.size;
    if (this.nodeId !== node?.id) {
      this.nodeId = node?.id;
      this.draft = undefined;
      this.showError('');
    }
    this.hint.hidden = !!node;
    this.hint.textContent = count > 1 ? `${count} items selected.` : 'Select one item in the Navigator.';
    this.fields.hidden = !node;
    if (!node || !index) {
      return;
    }
    if (!this.draft && this.title.value !== node.title) {
      this.title.value = node.title;
    }
    this.title.readOnly = this.state.busy;
    this.kind.value.textContent = kindLabels[node.kind];
    this.label.value.textContent = labelOf(node, index);
    this.created.value.textContent = new Date(node.createdAt).toLocaleString();
    this.updated.value.textContent = new Date(node.updatedAt).toLocaleString();
    this.contents.row.hidden = !manuscriptNodeTypes[node.kind].container;
    this.contents.value.textContent = `${index.children.get(node.id)?.length ?? 0} items`;
  }

  private discard(): void {
    this.draft = undefined;
    this.showError('');
    this.render();
  }

  private showError(message: string): void {
    this.message.textContent = message;
    this.message.hidden = !message;
    this.title.setAttribute('aria-invalid', String(!!message));
  }

  private async commit(): Promise<void> {
    const draft = this.draft;
    if (!draft || this.nodeId !== draft.nodeId || this.state.busy) {
      return;
    }
    let value: string;
    try {
      value = normalizeManuscriptTitle(this.title.value, true);
    } catch {
      this.showError('Enter a title of up to 200 characters on one line.');
      return;
    }
    if (this.state.revision === draft.revision && value === this.state.singleSelection()?.title) {
      this.discard();
      return;
    }

    const result = await this.state.rename(draft.nodeId, value, draft.revision);
    if (this.draft !== draft) {
      return;
    }
    if (result) {
      this.discard();
    } else if (this.state.revision !== undefined && this.state.revision !== draft.revision) {
      draft.revision = this.state.revision;
      this.showError('The manuscript was reloaded. Press Enter to save your title again.');
    } else {
      this.showError('Could not save the title. Press Enter to try again.');
    }
  }
}
