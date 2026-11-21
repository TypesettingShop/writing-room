import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IViewBody } from '../../../common/views.js';
import { IOutputService } from '../../../services/output/common/output.js';
import type { IOutputChannel, IOutputChannelDescriptor } from '../../../services/output/common/output.js';
import './output.css';

/** Code units of a line drawn on screen, as the editor's `stopRenderingLineAfter`. The rest is counted, not drawn. */
export const MAX_RENDERED_LINE_LENGTH = 10_000;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** The names in the channel list: a label that more than one channel has gets its extension's name. */
export function channelDisplayLabels(descriptors: readonly IOutputChannelDescriptor[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const { label } of descriptors) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return new Map(descriptors.map(({ id, label, extensionName, extensionId }) => {
    const source = extensionName || extensionId;
    return [id, counts.get(label)! > 1 && source ? `${label} (${source})` : label];
  }));
}

interface Rendered {
  readonly channel: IOutputChannel | undefined;
  readonly generation: number;
  /** The number of the first finished line drawn, and one past the last. */
  first: number;
  end: number;
  partial: string;
}

let nextViewId = 0;

/**
 * The Output view: a list to choose a channel and the channel's text, read-only. Changes wait while the
 * view is hidden (a closed part, another tab) and are drawn at once when it shows again; the part lays
 * the view out each time it shows. The text follows new output only while it is scrolled to the end.
 */
export class OutputView extends Disposable implements IViewBody {
  readonly element: HTMLElement;
  readonly channelList: HTMLElement;
  readonly log: HTMLElement;
  private readonly idPrefix = `output-view-${++nextViewId}-`;
  private readonly optionIds = new Map<string, string>();
  /** Never reused: a removed channel's number would otherwise go to the next new one while another has it. */
  private nextOptionId = 0;
  private readonly modelListener = this._register(new MutableDisposable());
  private lines: HTMLElement[] = [];
  private lineStart = 0;
  private partialElement: HTMLElement | undefined;
  private rendered: Rendered = { channel: undefined, generation: -1, first: 0, end: 0, partial: '' };
  private channelsChanged = true;
  private order: string[] = [];
  private scheduled = false;
  private disposed = false;
  private follow = true;
  private scrollTop = 0;

  constructor(
    parent: HTMLElement,
    @IOutputService private readonly output: IOutputService,
  ) {
    super();
    const document = parent.ownerDocument;
    this.element = document.createElement('div');
    this.element.className = 'output-view';

    this.channelList = document.createElement('div');
    this.channelList.className = 'output-channels';
    this.channelList.setAttribute('role', 'listbox');
    this.channelList.setAttribute('aria-label', 'Output Channels');
    this.channelList.tabIndex = 0;

    this.log = document.createElement('div');
    this.log.className = 'output-log';
    this.log.setAttribute('role', 'log');
    this.log.setAttribute('aria-label', 'Output');
    this.log.setAttribute('aria-readonly', 'true');
    this.log.tabIndex = 0;

    this.element.append(this.channelList, this.log);
    parent.append(this.element);
    this._register(toDisposable(() => this.element.remove()));

    this._register(addDisposableListener(this.channelList, 'click', event => {
      const option = (event.target as Element | null)?.closest?.('[role=option]');
      const id = option instanceof HTMLElement ? option.dataset.channel : undefined;
      if (id) {
        this.output.setActiveChannel(id);
      }
    }));
    this._register(addDisposableListener(this.channelList, 'keydown', event => this.onListKey(event)));
    this._register(addDisposableListener(this.log, 'scroll', () => {
      if (this.isVisible()) {
        this.scrollTop = this.log.scrollTop;
        this.follow = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 2;
      }
    }));
    // Opening the view with focus focuses its pane; the text is what takes it.
    const pane = parent.closest('.view-pane');
    if (pane) {
      this._register(addDisposableListener(pane, 'focus', event => {
        if (event.target === pane) {
          this.log.focus();
        }
      }));
    }

    const channelsChanged = () => {
      this.channelsChanged = true;
      this.schedule();
    };
    this._register(output.onDidRegisterChannel(channelsChanged));
    this._register(output.onDidRemoveChannel(channelsChanged));
    this._register(output.onActiveOutputChannel(() => {
      this.watchActiveChannel();
      channelsChanged();
    }));
    this.watchActiveChannel();
    this.sync();
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }

  layoutBody(_height: number, width: number): void {
    this.element.classList.toggle('narrow', width > 0 && width < 420);
    this.sync();
  }

  focus(): void {
    this.log.focus();
  }

  /** Whether the view is on screen: in the document and inside no hidden part or container. */
  isVisible(): boolean {
    return this.element.isConnected && !this.element.closest('[hidden]');
  }

  private watchActiveChannel(): void {
    this.modelListener.value = this.output.getActiveChannel()?.model.onDidChange(() => this.schedule());
  }

  private schedule(): void {
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.disposed) {
          this.sync();
        }
      });
    }
  }

  private sync(): void {
    if (!this.isVisible()) {
      return;
    }
    if (this.channelsChanged) {
      this.channelsChanged = false;
      this.renderChannels();
    }
    const changed = this.renderText();
    if (this.follow) {
      if (changed || this.log.scrollTop + this.log.clientHeight < this.log.scrollHeight) {
        this.log.scrollTop = this.log.scrollHeight;
      }
    } else if (this.log.scrollTop !== this.scrollTop) {
      // A hidden element can lose its scroll position.
      this.log.scrollTop = this.scrollTop;
    }
  }

  private renderChannels(): void {
    const document = this.element.ownerDocument;
    const descriptors = this.output.getChannelDescriptors();
    const labels = channelDisplayLabels(descriptors);
    const active = this.output.getActiveChannel()?.id;
    const ordered = descriptors.map(({ id }) => id)
      .sort((a, b) => labels.get(a)!.localeCompare(labels.get(b)!) || a.localeCompare(b));
    this.order = ordered;
    const options = ordered.map(id => {
      let optionId = this.optionIds.get(id);
      if (!optionId) {
        optionId = this.idPrefix + this.nextOptionId++;
        this.optionIds.set(id, optionId);
      }
      const option = document.createElement('div');
      option.id = optionId;
      option.className = 'output-channel';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(id === active));
      option.dataset.channel = id;
      option.textContent = labels.get(id)!;
      option.title = labels.get(id)!;
      return option;
    });
    for (const id of [...this.optionIds.keys()]) {
      if (!labels.has(id)) {
        this.optionIds.delete(id);
      }
    }
    this.channelList.replaceChildren(...options);
    const selected = active && this.optionIds.get(active);
    if (selected) {
      this.channelList.setAttribute('aria-activedescendant', selected);
      document.getElementById(selected)?.scrollIntoView?.({ block: 'nearest' });
    } else {
      this.channelList.removeAttribute('aria-activedescendant');
    }
  }

  private onListKey(event: KeyboardEvent): void {
    if (!this.order.length) {
      return;
    }
    const current = this.order.indexOf(this.output.getActiveChannel()?.id ?? '');
    const last = this.order.length - 1;
    const next = event.key === 'ArrowDown' ? Math.min(last, current + 1)
      : event.key === 'ArrowUp' ? Math.max(0, current - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : undefined;
    if (next !== undefined) {
      event.preventDefault();
      this.output.setActiveChannel(this.order[next]);
    }
  }

  /** Draws what changed in the active channel's text. Returns whether anything did. */
  private renderText(): boolean {
    const channel = this.output.getActiveChannel();
    const model = channel?.model;
    const rendered = this.rendered;
    const end = model ? model.firstLine + model.lineCount : 0;
    const partial = model?.partialLine ?? '';
    if (channel !== rendered.channel || model?.generation !== rendered.generation) {
      if (channel !== rendered.channel) {
        this.follow = true;
      }
      this.renderAll(channel);
      return true;
    }
    if (!model || (rendered.first === model.firstLine && rendered.end === end && rendered.partial === partial)) {
      return false;
    }
    const drawn = rendered.end - rendered.first;
    if (model.firstLine - rendered.first > drawn / 2) {
      this.renderAll(channel);
      return true;
    }
    for (; rendered.first < model.firstLine; rendered.first++) {
      this.lines[this.lineStart++].remove();
    }
    if (this.lineStart > 1024 && this.lineStart * 2 > this.lines.length) {
      this.lines = this.lines.slice(this.lineStart);
      this.lineStart = 0;
    }
    const fragment = this.element.ownerDocument.createDocumentFragment();
    for (let line = rendered.end; line < end; line++) {
      const element = this.createLine(model.getLine(line)!);
      this.lines.push(element);
      fragment.append(element);
    }
    rendered.end = end;
    this.partialElement?.remove();
    this.partialElement = partial ? this.createLine(partial) : undefined;
    rendered.partial = partial;
    if (this.partialElement) {
      fragment.append(this.partialElement);
    }
    this.log.append(fragment);
    return true;
  }

  private renderAll(channel: IOutputChannel | undefined): void {
    const model = channel?.model;
    const first = model?.firstLine ?? 0;
    const end = model ? first + model.lineCount : 0;
    const partial = model?.partialLine ?? '';
    this.lines = [];
    this.lineStart = 0;
    const fragment = this.element.ownerDocument.createDocumentFragment();
    for (let line = first; line < end; line++) {
      const element = this.createLine(model!.getLine(line)!);
      this.lines.push(element);
      fragment.append(element);
    }
    this.partialElement = partial ? this.createLine(partial) : undefined;
    if (this.partialElement) {
      fragment.append(this.partialElement);
    }
    this.log.replaceChildren(fragment);
    this.rendered = { channel, generation: model?.generation ?? -1, first, end, partial };
  }

  private createLine(text: string): HTMLElement {
    const document = this.element.ownerDocument;
    const line = document.createElement('div');
    line.className = 'output-line';
    if (text.length <= MAX_RENDERED_LINE_LENGTH) {
      line.textContent = text;
      return line;
    }
    let cut = MAX_RENDERED_LINE_LENGTH;
    if (isHighSurrogate(text.charCodeAt(cut - 1))) {
      cut--;
    }
    const marker = document.createElement('span');
    marker.className = 'output-line-truncated';
    marker.textContent = ` … ${(text.length - cut).toLocaleString('en-US')} more characters not shown`;
    line.append(document.createTextNode(text.slice(0, cut)), marker);
    return line;
  }
}
