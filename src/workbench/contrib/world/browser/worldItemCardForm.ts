import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { checkFieldValue, type CharacterFieldDefinition, type CharacterFieldKind } from '../../../../platform/characters/common/characterFields.js';
import { CommandsRegistry, type ICommandService } from '../../../../platform/commands/common/commands.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { FieldInput } from '../../../browser/fieldCard/fieldInputs.js';
import type { WorldItemCardModel } from './worldItemCardModel.js';
import type { WorldItemEditorInput } from './worldItemEditorInput.js';
import type { WorldViewState } from './worldViewState.js';

interface Row {
  readonly element: HTMLElement;
  readonly input: FieldInput;
  readonly warning: HTMLElement;
  definition: CharacterFieldDefinition;
}

interface Section {
  readonly element: HTMLElement;
  readonly body: HTMLElement;
}

function placeChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
  let next = parent.firstElementChild;
  for (const element of children) {
    if (element === next) {
      next = next.nextElementSibling;
    } else if (parent.isConnected && element.isConnected && parent.moveBefore) {
      parent.moveBefore(element, next);
    } else {
      parent.insertBefore(element, next);
    }
  }
}

export class WorldItemCardForm extends Disposable {
  private readonly name: FieldInput;
  private readonly path: HTMLElement;
  private readonly status: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly editCategory: HTMLButtonElement;
  private readonly rows = new Map<string, Row>();
  private sections = new Map<string, Section>();
  private definitions: readonly CharacterFieldDefinition[] | undefined;
  private composing = 0;
  private disposed = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly editor: WorldItemEditorInput,
    private readonly model: WorldItemCardModel,
    private readonly keybindings: IKeybindingService,
    commands: ICommandService,
    state: WorldViewState,
  ) {
    super();
    const document = root.ownerDocument;
    this.path = root.appendChild(document.createElement('p'));
    this.path.className = 'world-card-path';
    this.name = this._register(this.createField('text', title => model.edit({ ...model.draft, title })));
    this.name.update({ label: 'Name', placeholder: 'Untitled' });
    root.append(this.name.element);
    this.status = root.appendChild(document.createElement('p'));
    this.status.setAttribute('role', 'status');
    this.body = root.appendChild(document.createElement('div'));
    this.empty = root.appendChild(document.createElement('div'));
    this.empty.appendChild(document.createElement('p')).textContent = 'This category has no fields yet.';
    this.editCategory = this.empty.appendChild(document.createElement('button'));
    this.editCategory.type = 'button';
    this.editCategory.textContent = 'Edit Category Fields';
    this._register(addDisposableListener(this.editCategory, 'click', () => {
      state.reveal(editor.itemId);
      void commands.executeCommand('world.editCategoryFields');
    }));
    this._register(model.onDidChange(() => this.renderValues()));
    this._register(editor.onDidChangePresentation(() => this.renderFields()));
    this._register(addDisposableListener(root, 'focusout', event => {
      if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) {
        model.scheduleAutoSave(0);
      }
    }));
    this.renderFields();
  }

  private createField(kind: CharacterFieldKind, change: (value: string) => void): FieldInput {
    let composition: IDisposable | undefined;
    return new FieldInput(this.root.ownerDocument, kind, {
      change,
      compositionStart: () => {
        this.composing++;
        composition = this.model.beginComposition();
      },
      compositionEnd: () => {
        this.composing--;
        composition?.dispose();
        composition = undefined;
        this.renderFields();
      },
    }, this.keybindings);
  }

  private renderFields(): void {
    if (this.disposed || this.composing) {
      return;
    }
    const path = this.editor.categoryPath;
    if (this.path.textContent !== path) {
      this.path.textContent = path;
    }
    const definitions = this.editor.fields;
    if (this.definitions !== definitions) {
      this.definitions = definitions;
      this.reconcileFields(definitions);
    }
    this.renderValues();
  }

  private reconcileFields(definitions: readonly CharacterFieldDefinition[]): void {
    const document = this.root.ownerDocument;
    const active = document.activeElement;
    const sections = new Map<string, { section: Section; rows: HTMLElement[] }>();
    const seen = new Set<string>();
    const occurrences = new Map<string, number>();
    let group: { section: Section; rows: HTMLElement[] } | undefined;
    let previous: string | undefined;

    for (const definition of definitions) {
      const { id, kind } = definition;
      if (kind !== 'text' && kind !== 'longText' && kind !== 'choice') {
        continue;
      }
      const heading = definition.section ?? '';
      if (!group || previous !== heading) {
        const occurrence = occurrences.get(heading) ?? 0;
        occurrences.set(heading, occurrence + 1);
        const key = heading + '\0' + occurrence;
        const section = this.sections.get(key) ?? this.createSection(heading);
        group = { section, rows: [] };
        sections.set(key, group);
        previous = heading;
      }
      let row = this.rows.get(id);
      if (row?.input.kind !== kind) {
        if (row) {
          row.input.dispose();
          row.element.remove();
        }
        const element = document.createElement('div');
        element.className = 'world-card-field';
        const warning = element.appendChild(document.createElement('p'));
        warning.setAttribute('role', 'status');
        warning.className = 'world-card-warning';
        const input = this.createField(kind, value => {
          const current = this.model.draft;
          this.model.edit({ ...current, values: { ...current.values, [id]: value } });
        });
        element.append(input.element);
        row = { element, warning, input, definition };
        this.rows.set(id, row);
      }
      row.definition = definition;
      row.input.update(definition);
      seen.add(id);
      group.rows.push(row.element);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.input.dispose();
        row.element.remove();
        this.rows.delete(id);
      }
    }
    placeChildren(this.body, [...sections.values()].map(({ section }) => section.element));
    for (const { section, rows } of sections.values()) {
      placeChildren(section.body, rows);
    }
    for (const [key, section] of this.sections) {
      if (!sections.has(key)) {
        section.element.remove();
      }
    }
    this.sections = new Map([...sections].map(([key, { section }]) => [key, section]));
    if (active instanceof HTMLElement && this.root.contains(active) && active !== document.activeElement) {
      active.focus({ preventScroll: true });
    }
  }

  private createSection(heading: string): Section {
    const document = this.root.ownerDocument;
    const element = document.createElement('section');
    if (heading) {
      element.appendChild(document.createElement('h2')).textContent = heading;
    }
    return { element, body: element.appendChild(document.createElement('div')) };
  }

  private renderValues(): void {
    if (this.disposed) {
      return;
    }
    const { draft, deleted } = this.model;
    this.name.setValue(draft.title, deleted);
    this.status.hidden = !deleted;
    this.status.textContent = deleted ? 'Item deleted' : '';
    this.empty.hidden = deleted || this.rows.size !== 0;
    this.editCategory.hidden = !CommandsRegistry.getCommand('world.editCategoryFields');
    for (const [id, { definition, input, warning }] of this.rows) {
      const value = draft.values[id] ?? '';
      const invalid = !!value && !checkFieldValue(definition, value);
      const message = invalid ? 'The original value does not match this field: ' + value : '';
      if (warning.textContent !== message) {
        warning.textContent = message;
      }
      warning.hidden = !invalid;
      input.setValue(invalid && definition.kind === 'text' ? '' : value, deleted);
      if (invalid && input.control instanceof HTMLSelectElement) {
        const option = input.control.selectedOptions.item(0);
        if (option?.value === value) {
          option.disabled = true;
        }
      }
    }
  }

  override dispose(): void {
    this.disposed = true;
    for (const row of this.rows.values()) {
      row.input.dispose();
    }
    super.dispose();
    this.root.replaceChildren();
  }
}
