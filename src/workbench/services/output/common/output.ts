import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

/** The Output view and its view container share this id, as in VS Code. */
export const OUTPUT_VIEW_ID = 'workbench.panel.output';

/**
 * The most a channel keeps, in UTF-16 code units (JavaScript string length), counting one per line
 * feed. A channel past it drops its oldest lines; a single line longer than it keeps only its end.
 */
export const OUTPUT_CHANNEL_LIMIT = 1024 * 1024;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Drops the head of `text` so that at most `length` code units remain, without splitting a surrogate pair. */
function keepTail(text: string, length: number): string {
  let start = Math.max(0, text.length - length);
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start))) {
    start++;
  }
  return text.slice(start);
}

/**
 * The text of one channel, kept in memory: the finished lines (without their line feed) in a ring and the
 * unfinished last line. A line ends at `\n`; a `\r` before it is dropped.
 *
 * Lines are numbered from the last reset, so a reader can tell which lines it already has: the kept lines
 * are `firstLine` up to `firstLine + lineCount`. `generation` changes whenever the kept lines change other
 * than by adding at the end or dropping at the start (a clear, a replace, a cut in the first line).
 */
export class OutputChannelModel {
  private lines: string[] = [];
  private start = 0;
  private unfinished = '';
  private _size = 0;
  private _firstLine = 0;
  private _generation = 0;
  private readonly didChange = new Emitter<void>();
  readonly onDidChange: Event<void> = this.didChange.event;

  constructor(private readonly limit = OUTPUT_CHANNEL_LIMIT) {}

  /** Code units kept, counting one per finished line for its line feed. Never above the limit. */
  get size(): number {
    return this._size;
  }

  get lineCount(): number {
    return this.lines.length - this.start;
  }

  get firstLine(): number {
    return this._firstLine;
  }

  get generation(): number {
    return this._generation;
  }

  /** The text after the last line feed. */
  get partialLine(): string {
    return this.unfinished;
  }

  /** A finished line by its number, from `firstLine`. */
  getLine(line: number): string | undefined {
    const index = line - this._firstLine;
    return index >= 0 && index < this.lineCount ? this.lines[this.start + index] : undefined;
  }

  getText(): string {
    const lines = this.lines.slice(this.start);
    return lines.length ? lines.join('\n') + '\n' + this.unfinished : this.unfinished;
  }

  append(text: string): void {
    if (this.write(text)) {
      this.didChange.fire();
    }
  }

  clear(): void {
    if (this._size || this.lineCount) {
      this.reset();
      this.didChange.fire();
    }
  }

  replace(text: string): void {
    this.reset();
    this.write(text);
    this.didChange.fire();
  }

  dispose(): void {
    this.didChange.dispose();
  }

  private reset(): void {
    this.lines = [];
    this.start = 0;
    this.unfinished = '';
    this._size = 0;
    this._firstLine = 0;
    this._generation++;
  }

  private write(text: string): boolean {
    if (typeof text !== 'string' || !text) {
      return false;
    }
    this._size -= this.unfinished.length;
    let index = 0;
    for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', index)) {
      let line = this.unfinished + text.slice(index, end);
      this.unfinished = '';
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      this.lines.push(line);
      this._size += line.length + 1;
      index = end + 1;
      // A long burst of lines drops the oldest as it goes instead of holding them all first.
      if (this._size > this.limit * 2) {
        this.trim();
      }
    }
    this.unfinished += text.slice(index);
    this._size += this.unfinished.length;
    this.trim();
    return true;
  }

  private trim(): void {
    while (this._size > this.limit) {
      const count = this.lineCount;
      if (count === 0) {
        this.unfinished = keepTail(this.unfinished, this.limit);
        this._size = this.unfinished.length;
      } else if (count === 1 && this.unfinished.length < this.limit) {
        // The only finished line is longer than the room left: keep its end.
        const line = this.lines[this.start];
        const kept = keepTail(line, line.length - (this._size - this.limit));
        this.lines[this.start] = kept;
        this._size -= line.length - kept.length;
        this._generation++;
      } else {
        this._size -= this.lines[this.start].length + 1;
        this.lines[this.start++] = '';
        this._firstLine++;
      }
    }
    if (this.start > 1024 && this.start * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.start);
      this.start = 0;
    }
  }
}

export interface IOutputChannelDescriptor {
  readonly id: string;
  /** The name shown in the Output view. */
  readonly label: string;
  /** The extension that created the channel. */
  readonly extensionId?: string;
  /** Shown after the label when another channel has the same label. */
  readonly extensionName?: string;
}

export interface IOutputChannel {
  readonly id: string;
  readonly label: string;
  readonly descriptor: IOutputChannelDescriptor;
  /** The text, for reading. Write through the channel. */
  readonly model: OutputChannelModel;
  append(output: string): void;
  clear(): void;
  replace(output: string): void;
  /** Removes the channel from the Output view. */
  dispose(): void;
}

export const IOutputService = createDecorator<IOutputService>('outputService');

export interface IOutputService extends BrandedService {
  readonly onDidRegisterChannel: Event<IOutputChannelDescriptor>;
  readonly onDidRemoveChannel: Event<IOutputChannelDescriptor>;
  /** The id of the new active channel, or `undefined` when no channel is left. */
  readonly onActiveOutputChannel: Event<string | undefined>;
  /** Adds a channel. The first channel, or one added while none is active, becomes active. Throws for a used id. */
  registerChannel(descriptor: IOutputChannelDescriptor): IOutputChannel;
  getChannel(id: string): IOutputChannel | undefined;
  getChannelDescriptor(id: string): IOutputChannelDescriptor | undefined;
  /** In the order they were added. */
  getChannelDescriptors(): IOutputChannelDescriptor[];
  getActiveChannel(): IOutputChannel | undefined;
  setActiveChannel(id: string): void;
  /** Makes the channel active and opens the Output view; the view takes focus unless `preserveFocus`. */
  showChannel(id: string, preserveFocus?: boolean): Promise<void>;
  /** Closes the Output view's part if the view is showing this channel; otherwise does nothing. */
  hideChannel(id: string): void;
}
