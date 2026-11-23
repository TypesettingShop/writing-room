import { addDisposableListener } from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Disposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { checkFieldValue, type CharacterFieldDefinition, type CharacterFieldKind } from '../../../../platform/characters/common/characterFields.js';
import { characterTypes, type CharacterType } from '../../../../platform/characters/common/characters.js';
import type { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import type { CharacterCardModel } from './characterCardModel.js';
import { characterTypeIcon } from './characterIcons.js';
import { FieldInput } from './fieldInputs.js';

function isSupported(kind: string): kind is CharacterFieldKind {
  return kind === 'text' || kind === 'longText' || kind === 'choice';
}

/** Keep the elements that are already in order attached, including the active input. */
function placeChildren(parent: HTMLElement, elements: readonly HTMLElement[]): void {
  let next = parent.firstElementChild;
  for (const element of elements) {
    if (element === next) {
      next = next.nextElementSibling;
    } else if (parent.isConnected && element.isConnected && parent.moveBefore) {
      parent.moveBefore(element, next);
    } else {
      parent.insertBefore(element, next);
    }
  }
}

interface CardSection {
  readonly element: HTMLElement;
  readonly body: HTMLDivElement;
}

interface CardField {
  readonly definition: CharacterFieldDefinition;
  readonly input: FieldInput;
}

export class CharacterCardForm extends Disposable {
  private readonly name: FieldInput;
  private readonly types = new Map<CharacterType, HTMLButtonElement>();
  private readonly status: HTMLParagraphElement;
  private readonly body: HTMLDivElement;
  private fields = new Map<string, CardField>();
  private sections = new Map<string, CardSection>();
  private template: readonly CharacterFieldDefinition[] = [];
  private templateChanged = false;
  private loadingMessage = 'Loading fields…';
  private composing = 0;
  private disposed = false;

  constructor(
    private readonly card: HTMLElement,
    private readonly model: CharacterCardModel,
    private readonly keybindings: IKeybindingService,
  ) {
    super();
    const document = card.ownerDocument;
    const header = card.appendChild(document.createElement('header'));
    header.className = 'character-card-header';
    this.name = this._register(this.makeInput('text', title => model.edit({ ...model.draft, title })));
    this.name.update({ label: 'Name', placeholder: 'Untitled' });
    this.name.control.classList.add('character-card-name');
    header.append(this.name.element);

    const types = header.appendChild(document.createElement('div'));
    types.className = 'character-card-types';
    types.setAttribute('role', 'group');
    types.setAttribute('aria-label', 'Character type');
    for (const type of characterTypes) {
      const button = types.appendChild(document.createElement('button'));
      button.type = 'button';
      const icon = characterTypeIcon(type);
      button.title = icon.label;
      button.setAttribute('aria-label', icon.label);
      const image = renderIcon(icon);
      if (image) {
        image.setAttribute('aria-hidden', 'true');
        button.append(image);
      }
      this._register(addDisposableListener(button, 'click', () => {
        model.edit({ ...model.draft, type });
      }));
      this.types.set(type, button);
    }
    this.status = card.appendChild(document.createElement('p'));
    this.status.hidden = true;
    this.status.className = 'character-card-status';
    this.status.setAttribute('role', 'status');
    this.body = card.appendChild(document.createElement('div'));
    this.body.className = 'character-card-fields';

    this._register(model.onDidChange(() => this.renderValues()));
    this._register(addDisposableListener(card, 'focusout', event => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !card.contains(next)) {
        model.scheduleAutoSave(0);
      }
    }));
    this.renderValues();
  }

  setTemplate(template: readonly CharacterFieldDefinition[]): void {
    this.template = template;
    this.templateChanged = true;
    this.loadingMessage = '';
    this.renderTemplate();
  }

  showTemplateError(): void {
    this.loadingMessage = 'Could not load character fields.';
    this.renderValues();
  }

  private makeInput(kind: CharacterFieldKind, change: (value: string) => void): FieldInput {
    let composition: IDisposable | undefined;
    return new FieldInput(this.card.ownerDocument, kind, {
      change,
      compositionStart: () => {
        this.composing++;
        composition = this.model.beginComposition();
      },
      compositionEnd: () => {
        this.composing--;
        composition?.dispose();
        composition = undefined;
        this.renderTemplate();
      },
    }, this.keybindings);
  }

  private renderTemplate(): void {
    if (this.disposed || this.composing) {
      return;
    }
    if (!this.templateChanged) {
      this.renderValues();
      return;
    }
    this.templateChanged = false;
    const document = this.card.ownerDocument;
    const active = document.activeElement;
    const sections = new Map<string, { section: CardSection; controls: HTMLElement[] }>();
    const fields = new Map<string, CardField>();
    const sectionOccurrences = new Map<string, number>();
    let previousSection: string | undefined;
    let group: { section: CardSection; controls: HTMLElement[] } | undefined;

    for (const definition of this.template) {
      const { id, kind } = definition;
      if (!isSupported(kind)) {
        continue;
      }
      const heading = definition.section ?? '';
      if (!group || previousSection !== heading) {
        const occurrence = sectionOccurrences.get(heading) ?? 0;
        sectionOccurrences.set(heading, occurrence + 1);
        const key = heading + '\0' + occurrence;
        const section = this.sections.get(key) ?? this.createSection(heading);
        group = { section, controls: [] };
        sections.set(key, group);
        previousSection = heading;
      }
      let input = this.fields.get(id)?.input;
      if (!input || input.kind !== kind) {
        input?.dispose();
        input = this.makeInput(kind, value => {
          this.model.edit({ ...this.model.draft, values: { ...this.model.draft.values, [id]: value } });
        });
      }
      input.update(definition);
      fields.set(id, { input, definition });
      group.controls.push(input.element);
    }

    for (const [id, field] of this.fields) {
      if (!fields.has(id)) {
        field.input.dispose();
      }
    }
    placeChildren(this.body, [...sections.values()].map(({ section }) => section.element));
    for (const { section, controls } of sections.values()) {
      placeChildren(section.body, controls);
    }
    for (const [key, section] of this.sections) {
      if (!sections.has(key)) {
        section.element.remove();
      }
    }
    this.fields = fields;
    this.sections = new Map([...sections].map(([key, { section }]) => [key, section]));

    if (active instanceof HTMLElement && this.card.contains(active) && document.activeElement !== active) {
      active.focus({ preventScroll: true });
    }
    this.renderValues();
  }

  private createSection(heading: string): CardSection {
    const document = this.card.ownerDocument;
    const element = document.createElement('section');
    element.className = 'character-card-section';
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
    for (const [type, button] of this.types) {
      button.disabled = deleted;
      button.setAttribute('aria-pressed', String(draft.type === type));
    }
    const message = deleted ? 'Character deleted' : this.loadingMessage;
    if (this.status.textContent !== message) {
      this.status.textContent = message;
      this.status.hidden = !message;
    }
    for (const [id, { definition, input }] of this.fields) {
      const value = draft.values[id];
      // Preserve obsolete values even when the current template no longer accepts them.
      const invalid = value !== undefined && value !== '' && !checkFieldValue(definition, value);
      input.setValue(value ?? '', deleted || (invalid && input.kind === 'text'));
    }
  }

  override dispose(): void {
    this.disposed = true;
    for (const { input } of this.fields.values()) {
      input.dispose();
    }
    super.dispose();
    this.card.replaceChildren();
  }
}
