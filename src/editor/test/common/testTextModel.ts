import { Emitter } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../common/languages/language.js';
import type {
  IModelContentChange, IModelContentChangedEvent, IModelLanguageChangedEvent, IPosition, IRange, ISingleEditOperation, ITextModel,
} from '../../common/model.js';
import type { IModelLanguageChangedEvent as IServiceLanguageChangedEvent, IModelService } from '../../common/services/model.js';

let nextModelId = 1;

/** A text model without Monaco, for jsdom. It keeps `\n` line breaks and counts versions as Monaco does. */
export class TestTextModel implements ITextModel {
  readonly id = `$test${nextModelId++}`;
  private readonly changed = new Emitter<IModelContentChangedEvent>();
  private readonly languageChanged = new Emitter<IModelLanguageChangedEvent>();
  private readonly willDispose = new Emitter<void>();
  private disposed = false;
  private versionId = 1;

  constructor(readonly uri: URI, private value: string, private language: string = PLAINTEXT_LANGUAGE_ID) {}

  get languageId(): string { return this.language; }

  getVersionId(): number { return this.versionId; }
  getValue(): string { return this.value; }
  getValueLength(): number { return this.value.length; }
  getLineCount(): number { return this.getLinesContent().length; }
  getLinesContent(): string[] { return this.value.split('\n'); }
  getEOL(): string { return '\n'; }
  getLanguageId(): string { return this.language; }

  getLineContent(lineNumber: number): string {
    const lines = this.getLinesContent();
    if (lineNumber < 1 || lineNumber > lines.length) {
      throw new Error(`Illegal value for lineNumber: ${lineNumber}`);
    }
    return lines[lineNumber - 1];
  }

  getOffsetAt({ lineNumber, column }: IPosition): number {
    const lines = this.getLinesContent();
    const line = Math.min(Math.max(lineNumber, 1), lines.length);
    let offset = 0;
    for (let index = 0; index < line - 1; index++) {
      offset += lines[index].length + 1;
    }
    return offset + Math.min(Math.max(column, 1), lines[line - 1].length + 1) - 1;
  }

  getPositionAt(offset: number): IPosition {
    let remaining = Math.min(Math.max(offset, 0), this.value.length);
    const lines = this.getLinesContent();
    for (let index = 0; index < lines.length; index++) {
      if (remaining <= lines[index].length) {
        return { lineNumber: index + 1, column: remaining + 1 };
      }
      remaining -= lines[index].length + 1;
    }
    return { lineNumber: lines.length, column: lines[lines.length - 1].length + 1 };
  }

  getValueInRange(range: IRange): string {
    const start = this.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    return this.value.slice(start, end);
  }

  setValue(value: string): void {
    const range = this.fullRange();
    const rangeLength = this.value.length;
    this.value = value;
    this.fire([{ range, rangeOffset: 0, rangeLength, text: value }], true);
  }

  applyEdits(operations: readonly ISingleEditOperation[]): void {
    // Applied from the end, so each range still means what it meant in the old text.
    const edits = operations.map(({ range, text }) => ({
      range,
      text: text ?? '',
      start: this.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      end: this.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
    })).sort((a, b) => b.start - a.start);
    const changes: IModelContentChange[] = [];
    for (const edit of edits) {
      this.value = this.value.slice(0, edit.start) + edit.text + this.value.slice(edit.end);
      changes.push({ range: edit.range, rangeOffset: edit.start, rangeLength: edit.end - edit.start, text: edit.text });
    }
    if (changes.length > 0) {
      this.fire(changes, false);
    }
  }

  /** What `monaco.editor.setModelLanguage` does to a Monaco model. */
  setLanguage(languageId: string): void {
    const oldLanguage = this.language;
    if (oldLanguage !== languageId) {
      this.language = languageId;
      this.languageChanged.fire({ oldLanguage, newLanguage: languageId });
    }
  }

  private fullRange(): IRange {
    const lines = this.getLinesContent();
    return { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: lines[lines.length - 1].length + 1 };
  }

  private fire(changes: IModelContentChange[], isFlush: boolean): void {
    this.versionId++;
    this.changed.fire({ changes, eol: '\n', versionId: this.versionId, isUndoing: false, isRedoing: false, isFlush });
  }

  onDidChangeContent(listener: (event: IModelContentChangedEvent) => void): IDisposable {
    return this.changed.event(listener);
  }

  onDidChangeLanguage(listener: (event: IModelLanguageChangedEvent) => void): IDisposable {
    return this.languageChanged.event(listener);
  }

  onWillDispose(listener: () => void): IDisposable {
    return this.willDispose.event(listener);
  }

  isDisposed(): boolean { return this.disposed; }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.willDispose.fire();
    this.disposed = true;
    this.changed.dispose();
    this.languageChanged.dispose();
    this.willDispose.dispose();
  }
}

/** A model service over `TestTextModel`, with the real service's events. */
export class TestModelService implements IModelService {
  declare readonly _serviceBrand: undefined;
  readonly created: TestTextModel[] = [];
  /** When set, `createModel` waits for it. */
  gate: Promise<void> | undefined;

  private readonly added = new Emitter<TestTextModel>();
  readonly onModelAdded = this.added.event;
  private readonly removed = new Emitter<TestTextModel>();
  readonly onModelRemoved = this.removed.event;
  private readonly languageChanged = new Emitter<IServiceLanguageChangedEvent>();
  readonly onModelLanguageChanged = this.languageChanged.event;
  /** Models on their way out: as in the real service, they leave the list before `onModelRemoved`. */
  private readonly removing = new Set<TestTextModel>();

  async createModel(value: string, languageId: string | undefined, resource: URI): Promise<TestTextModel> {
    await this.gate;
    if (this.getModel(resource)) {
      throw new Error(`A model for ${resource} already exists.`);
    }
    const model = new TestTextModel(resource, value, languageId ?? PLAINTEXT_LANGUAGE_ID);
    this.created.push(model);
    model.onDidChangeLanguage(({ oldLanguage, newLanguage }) =>
      this.languageChanged.fire({ model, oldLanguageId: oldLanguage, newLanguageId: newLanguage }));
    model.onWillDispose(() => {
      this.removing.add(model);
      this.removed.fire(model);
    });
    this.added.fire(model);
    return model;
  }

  getModel(resource: URI): TestTextModel | null {
    return this.getModels().find(model => model.uri.toString() === resource.toString()) ?? null;
  }

  getModels(): TestTextModel[] {
    return this.created.filter(model => !model.isDisposed() && !this.removing.has(model));
  }

  setModelLanguage(model: ITextModel, languageId: string): void {
    const own = this.getModels().find(candidate => candidate === model);
    if (!own) {
      throw new Error(`${model.uri} is not a model of the model service.`);
    }
    own.setLanguage(languageId);
  }
}
