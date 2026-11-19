import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import type { IMarker, IMarkerService } from '../../../../platform/markers/common/markers.js';
import type { IViewBody, IViewDescriptor } from '../../../common/views.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';
import { buildMarkersModel } from './markersModel.js';
import type { IMarkersGroup, IMarkersModel } from './markersModel.js';
import './media/markers.css';

export const MARKERS_VIEW_ID = 'workbench.panel.markers.view';
export const MARKERS_CONTAINER_ID = 'workbench.panel.markers';

/** Runs `callback` once, later; the returned handle cancels it. */
export type Schedule = (callback: () => void) => IDisposable;

const animationFrame: Schedule = callback => {
  const handle = requestAnimationFrame(callback);
  return toDisposable(() => cancelAnimationFrame(handle));
};

interface Item {
  readonly key: string;
  readonly element: HTMLElement;
  /** The key of the group the item sits in; a group's own key. */
  readonly group: string;
  readonly marker?: IMarker;
  readonly groupInfo?: IMarkersGroup;
}

const severityNames = new Map([
  [MarkerSeverity.Error, 'error'], [MarkerSeverity.Warning, 'warning'], [MarkerSeverity.Info, 'info'], [MarkerSeverity.Hint, 'hint'],
]);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function sourceAndCode({ source, code }: IMarker): string {
  const value = typeof code === 'object' ? code.value : code;
  return source && value ? `${source}(${value})` : source || value || '';
}

/**
 * The Problems list: markers grouped by resource, one tree. Changes of the marker service are gathered
 * and drawn at most once per frame; focus stays on the same row when it is still there.
 */
export class MarkersView extends Disposable {
  private readonly root: HTMLElement;
  private readonly collapsed = new Set<string>();
  private items: Item[] = [];
  private byElement = new Map<HTMLElement, Item>();
  private focusKey: string | undefined;
  private focusGroup: string | undefined;
  private pending: IDisposable | undefined;

  constructor(
    parent: HTMLElement,
    private readonly markers: IMarkerService,
    private readonly editors: IEditorService,
    private readonly schedule: Schedule = animationFrame,
  ) {
    super();
    this.root = parent.ownerDocument.createElement('div');
    this.root.className = 'markers-view';
    parent.append(this.root);
    this._register(toDisposable(() => this.root.remove()));
    this._register(toDisposable(() => this.pending?.dispose()));
    this.root.addEventListener('click', event => this.onClick(event));
    this.root.addEventListener('keydown', event => this.onKeyDown(event));
    this.root.addEventListener('focusin', event => this.onFocusIn(event));
    this._register(markers.onMarkerChanged(() => this.invalidate()));
    this.render();
  }

  /** Puts focus on the row that is in the tab order. Returns whether there was one. */
  focus(): boolean {
    const item = this.items.find(candidate => candidate.key === this.focusKey);
    item?.element.focus();
    return !!item;
  }

  private invalidate(): void {
    if (!this.pending) {
      this.pending = this.schedule(() => {
        this.pending = undefined;
        this.render();
      });
    }
  }

  private render(): void {
    const document = this.root.ownerDocument;
    const hadFocus = this.root.contains(document.activeElement);
    const scrollTop = this.root.scrollTop;
    const model = buildMarkersModel(this.markers.read());
    const items = this.build(model);
    this.items = items;
    this.byElement = new Map(items.map(item => [item.element, item]));

    if (!items.some(item => item.key === this.focusKey)) {
      // The row went: the nearest thing left is its group, then the first item.
      const fallback = items.find(item => item.key === this.focusGroup) ?? items[0];
      this.focusKey = fallback?.key;
      this.focusGroup = fallback?.group;
    }
    for (const item of items) {
      item.element.tabIndex = item.key === this.focusKey ? 0 : -1;
    }
    if (items.length) {
      const tree = document.createElement('div');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', 'Problems');
      tree.append(...items.map(item => item.element));
      this.root.replaceChildren(tree);
    } else {
      const message = document.createElement('p');
      message.className = 'markers-message';
      message.textContent = 'No problems have been detected in the workspace.';
      this.root.replaceChildren(message);
    }
    this.root.scrollTop = scrollTop;
    if (hadFocus) {
      this.items.find(item => item.key === this.focusKey)?.element.focus({ preventScroll: true });
    }
  }

  private build(model: IMarkersModel): Item[] {
    const items: Item[] = [];
    const seen = new Map<string, number>();
    const unique = (base: string) => {
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return count ? `${base}#${count}` : base;
    };
    for (const group of model.groups) {
      const groupKey = 'g:' + group.key;
      const expanded = !this.collapsed.has(group.key);
      items.push({ key: groupKey, group: groupKey, element: this.renderGroup(group, expanded), groupInfo: group });
      if (!expanded) {
        continue;
      }
      for (const marker of group.markers) {
        const key = unique(['m', group.key, marker.owner, marker.severity, marker.startLineNumber, marker.startColumn,
          marker.endLineNumber, marker.endColumn, marker.message, sourceAndCode(marker)].join('|'));
        items.push({ key, group: groupKey, marker, element: this.renderMarker(marker) });
      }
    }
    if (model.hidden > 0) {
      const element = this.row(2);
      element.textContent = `${plural(model.hidden, 'more problem')} not shown`;
      element.setAttribute('aria-label', element.textContent);
      items.push({ key: 'more', group: 'more', element });
    }
    return items;
  }

  private row(level: number): HTMLElement {
    const element = this.root.ownerDocument.createElement('div');
    element.className = 'markers-row';
    element.setAttribute('role', 'treeitem');
    element.setAttribute('aria-level', String(level));
    element.style.paddingInlineStart = (level - 1) * 18 + 'px';
    return element;
  }

  private part(element: HTMLElement, className: string, text: string): HTMLElement {
    const span = this.root.ownerDocument.createElement('span');
    span.className = className;
    span.textContent = text;
    element.append(span);
    return span;
  }

  private renderGroup(group: IMarkersGroup, expanded: boolean): HTMLElement {
    const element = this.row(1);
    element.setAttribute('aria-expanded', String(expanded));
    element.setAttribute('aria-label', [group.label, group.description].filter(Boolean).join(' ') + ', ' + plural(group.total, 'problem'));
    const twistie = this.part(element, 'markers-twistie codicon ' + (expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'), '');
    twistie.setAttribute('aria-hidden', 'true');
    this.part(element, 'markers-label', group.label);
    if (group.description) {
      this.part(element, 'markers-description', group.description);
    }
    this.part(element, 'markers-count', String(group.total));
    return element;
  }

  private renderMarker(marker: IMarker): HTMLElement {
    const element = this.row(2);
    const name = severityNames.get(marker.severity) ?? 'info';
    const icon = this.part(element, `markers-severity markers-severity-${name} codicon codicon-${name === 'hint' ? 'info' : name}`, '');
    icon.setAttribute('aria-hidden', 'true');
    this.part(element, 'markers-message-text', marker.message);
    const origin = sourceAndCode(marker);
    if (origin) {
      this.part(element, 'markers-source', origin);
    }
    const position = `[Ln ${marker.startLineNumber}, Col ${marker.startColumn}]`;
    this.part(element, 'markers-position', position);
    const label = `${name[0].toUpperCase()}${name.slice(1)}: ${marker.message}${origin ? ' ' + origin : ''} ${position}`;
    element.setAttribute('aria-label', label);
    return element;
  }

  private itemOf(target: EventTarget | null): Item | undefined {
    for (let node = target as HTMLElement | null; node && node !== this.root; node = node.parentElement) {
      const item = this.byElement.get(node);
      if (item) {
        return item;
      }
    }
    return undefined;
  }

  private onFocusIn(event: FocusEvent): void {
    const item = this.itemOf(event.target);
    if (item && item.key !== this.focusKey) {
      this.items.find(candidate => candidate.key === this.focusKey)?.element.setAttribute('tabindex', '-1');
      this.focusKey = item.key;
      this.focusGroup = item.group;
      item.element.tabIndex = 0;
    }
  }

  private onClick(event: MouseEvent): void {
    const item = this.itemOf(event.target);
    if (item) {
      item.element.focus();
      this.activate(item);
    }
  }

  private activate(item: Item): void {
    if (item.marker) {
      this.open(item.marker);
    } else if (item.groupInfo) {
      this.setCollapsed(item, !this.collapsed.has(item.groupInfo.key));
    }
  }

  private setCollapsed(item: Item, collapsed: boolean): void {
    const group = item.groupInfo!;
    if (this.collapsed.has(group.key) !== collapsed) {
      if (collapsed) {
        this.collapsed.add(group.key);
      } else {
        this.collapsed.delete(group.key);
      }
      this.render();
    }
  }

  private open(marker: IMarker): void {
    const { startLineNumber, startColumn, endLineNumber, endColumn } = marker;
    this.editors.openEditor({
      resource: marker.resource,
      options: { selection: { startLineNumber, startColumn, endLineNumber, endColumn } },
    }).catch(error => console.error('Could not open the problem.', error));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const index = this.items.findIndex(item => item.element === event.target);
    const item = this.items[index];
    if (!item || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    let next = index;
    switch (event.key) {
      case 'ArrowDown': next = Math.min(this.items.length - 1, index + 1); break;
      case 'ArrowUp': next = Math.max(0, index - 1); break;
      case 'Home': next = 0; break;
      case 'End': next = this.items.length - 1; break;
      case 'ArrowRight':
        if (item.groupInfo) {
          if (this.collapsed.has(item.groupInfo.key)) {
            this.setCollapsed(item, false);
          } else if (this.items[index + 1]?.group === item.key) {
            next = index + 1;
          }
        }
        break;
      case 'ArrowLeft':
        if (item.groupInfo && !this.collapsed.has(item.groupInfo.key)) {
          this.setCollapsed(item, true);
        } else if (!item.groupInfo) {
          next = this.items.findIndex(candidate => candidate.key === item.group);
        }
        break;
      case 'Enter':
        this.activate(item);
        break;
      default: return;
    }
    event.preventDefault();
    if (next !== index && next >= 0) {
      this.items[next].element.focus();
    }
  }
}

interface IMarkersViewServices {
  readonly markers: IMarkerService;
  readonly editors: IEditorService;
}

let services: IMarkersViewServices | undefined;
const waiting = new Set<() => void>();
let current: MarkersView | undefined;

/**
 * `renderBody` gets no services, and the workbench starts its contributions after the panel restored
 * its views. The contribution calls this when it starts; a view rendered before then finishes here.
 */
export function provideMarkersViewServices(provided: IMarkersViewServices): IDisposable {
  services = provided;
  for (const start of [...waiting]) {
    start();
  }
  return toDisposable(() => { if (services === provided) { services = undefined; } });
}

/** Focuses the Problems list, when a view is shown and has a row. */
export function focusMarkersView(): void {
  current?.focus();
}

export const markersViewDescriptor: IViewDescriptor = {
  id: MARKERS_VIEW_ID,
  name: 'Problems',
  renderBody(parent: HTMLElement): IViewBody {
    const store = new DisposableStore();
    const host = parent.ownerDocument.createElement('div');
    host.className = 'markers-host';
    host.style.height = '100%';
    parent.append(host);
    const start = () => {
      waiting.delete(start);
      if (services && !store.isDisposed) {
        const view = store.add(new MarkersView(host, services.markers, services.editors));
        current = view;
        store.add(toDisposable(() => { if (current === view) { current = undefined; } }));
      }
    };
    if (services) {
      start();
    } else {
      waiting.add(start);
      store.add(toDisposable(() => waiting.delete(start)));
    }
    return { dispose: () => { store.dispose(); host.remove(); } };
  },
};
