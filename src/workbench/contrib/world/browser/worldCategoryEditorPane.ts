import { $, addDisposableListener, append, type Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { WorldItem } from '../../../../platform/world/common/world.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { CharacterTemplateFieldList } from '../../characters/browser/characterTemplateFieldList.js';
import { WorldCategoryEditorInput } from './worldCategoryEditorInput.js';
import { worldCategoryOptionProblem, worldCategoryProblems, type WorldCategoryFieldsModel } from './worldCategoryFieldsModel.js';
import '../../characters/browser/media/characterCard.css';
import '../../characters/browser/media/characterTemplate.css';

export class WorldCategoryEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.worldCategoryFields';
  private readonly listeners = this._register(new DisposableStore());
  private readonly list = this._register(new MutableDisposable<CharacterTemplateFieldList>());
  private page!: HTMLElement;
  private heading!: HTMLElement;
  private status!: HTMLElement;
  private problems!: HTMLButtonElement;
  private retry!: HTMLButtonElement;
  private content!: HTMLDivElement;
  private boundModel: WorldCategoryFieldsModel | undefined;

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @IWorldService private readonly world: IWorldService,
  ) {
    super(WorldCategoryEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.page = append(parent, $('section.character-template', { 'aria-label': 'Category fields', tabindex: -1 }));
    this.heading = append(this.page, $('h1'));
    this.status = append(this.page, $('p.character-template-status', { role: 'status' }));
    const actions = append(this.page, $('.character-template-actions'));
    this.problems = append(actions, $('button', { type: 'button', hidden: true }));
    this.retry = append(actions, $('button', { type: 'button', hidden: true }, 'Retry'));
    this.content = append(this.page, $('div', { class: 'character-template-content' }));
    this._register(addDisposableListener(this.page, 'focusout', event => {
      if (this.input instanceof WorldCategoryEditorInput &&
          (!(event.relatedTarget instanceof Node) || !this.page.contains(event.relatedTarget))) {
        this.input.model?.scheduleAutoSave(0);
      }
    }));
    this._register(addDisposableListener(this.retry, 'click', () => {
      if (this.input instanceof WorldCategoryEditorInput) {
        void this.input.retry();
      }
    }));
    this._register(addDisposableListener(this.problems, 'click', () => {
      if (this.input instanceof WorldCategoryEditorInput) {
        this.focusProblem(this.input);
      }
    }));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    this.clearInput();
    await super.setInput(input, options);
    if (this.input !== input || !(input instanceof WorldCategoryEditorInput) || input.isDisposed()) {
      return;
    }
    const items = async () => {
      const tree = await this.world.store.getTree(input.workId);
      return tree.nodes.filter((node): node is WorldItem => node.kind === 'item' && node.parentId === input.categoryId);
    };
    this.list.value = this.instantiation.createInstance(CharacterTemplateFieldList, this.content, input, {
      reservedIds: async () => new Set((await items()).flatMap(item => Object.keys(item.values))),
      countValues: async id => {
        try {
          return (await items()).filter(item => Object.hasOwn(item.values, id) && !!item.values[id]).length;
        } catch {
          return undefined;
        }
      },
      addedLabel: '',
      addError: 'Could not read the items to add a field. Try again.',
      deleteDetail: count => {
        const affected = count === undefined ? 'The number of items with a value could not be checked.'
          : count === 1 ? '1 item has a value in this field.' : `${count} items have a value in this field.`;
        return affected + ' Values stay saved. There is no command to restore this field.';
      },
      validation: () => {
        const fields = input.fields;
        return fields ? worldCategoryProblems(fields).map(problem => {
          const index = fields.findIndex(field => field.id === problem.fieldId);
          return { fieldIndex: index >= 0 ? index : undefined, detail: problem.message };
        }) : [];
      },
    });
    this.listeners.add(input.onDidChangeState(() => this.render(input)));
    this.render(input);
    void input.resolve();
  }

  override clearInput(): void {
    this.listeners.clear();
    this.list.clear();
    this.boundModel = undefined;
    super.clearInput();
  }

  // The page scrolls inside the editor. Without a size it grows past the group, which clips it.
  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void { this.page.focus({ preventScroll: true }); }

  private focusProblem(input: WorldCategoryEditorInput): void {
    const fields = input.fields;
    const first = fields && worldCategoryProblems(fields)[0];
    if (first) {
      const field = fields.find(candidate => candidate.id === first.fieldId);
      this.list.value?.focusProblem(first.fieldId, field && worldCategoryOptionProblem(field));
    }
  }

  private render(input: WorldCategoryEditorInput): void {
    const { model } = input;
    if (model && this.boundModel !== model) {
      this.boundModel = model;
      this.listeners.add(model.onDidRequestSaveBlockFocus(() => this.focusProblem(input)));
    }
    this.heading.textContent = input.getName();
    this.status.textContent = input.missing ? 'Category deleted'
      : input.readFailed ? 'Could not load the category fields.'
      : model ? model.dirty ? 'Unsaved changes' : 'Saved' : 'Loading fields…';
    this.retry.hidden = !input.readFailed || input.missing;
    const count = input.fields ? worldCategoryProblems(input.fields).length : 0;
    this.problems.hidden = count === 0;
    this.problems.textContent = count ? `Not saved: ${count} ${count === 1 ? 'problem' : 'problems'}` : '';
  }
}
