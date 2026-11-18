import { addDisposableListener } from '../../base/browser/dom.js';
import { Orientation, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import type { ISerializedGrid, ISerializedLeafNode, IViewSize } from '../../base/browser/ui/grid/grid.js';
import { Emitter } from '../../base/common/event.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { Parts } from '../services/layout/browser/layoutService.js';
import type { IPartVisibilityChangeEvent, IWorkbenchLayoutService } from '../services/layout/browser/layoutService.js';
import type { Part } from './part.js';

const hiddenKey = {
  [Parts.ACTIVITYBAR_PART]: 'activityBarHidden',
  [Parts.SIDEBAR_PART]: 'sideBarHidden',
  [Parts.PANEL_PART]: 'panelHidden',
  [Parts.STATUSBAR_PART]: 'statusBarHidden',
} as const;
type OptionalPart = keyof typeof hiddenKey;

function isOptionalPart(part: Parts): part is OptionalPart {
  return Object.hasOwn(hiddenKey, part);
}

/** Live layout state. A caller can supply initial values when creating the workbench. */
export class LayoutStateModel {
  sideBarSize?: number;
  panelSize?: number;
  sideBarHidden = false;
  panelHidden = false;
  activityBarHidden = false;
  statusBarHidden = false;
  activeViewlet?: string;
  activePanel?: string;

  constructor(initial: Partial<LayoutStateModel> = {}) {
    // An explicit `undefined` keeps the default instead of replacing a boolean with it.
    Object.assign(this, Object.fromEntries(Object.entries(initial).filter(([, value]) => value !== undefined)));
  }
}

export class Layout extends Disposable implements IWorkbenchLayoutService {
  declare readonly _serviceBrand: undefined;
  readonly mainContainer: HTMLElement;
  readonly layoutState: LayoutStateModel;
  private readonly parts = new Map<Parts, Part>();
  private grid!: SerializableGrid<Part>;

  private readonly didChangePartVisibility = this._register(new Emitter<IPartVisibilityChangeEvent>());
  readonly onDidChangePartVisibility = this.didChangePartVisibility.event;

  constructor(protected readonly parent: HTMLElement, initialState?: Partial<LayoutStateModel>) {
    super();
    this.layoutState = new LayoutStateModel(initialState);
    this.mainContainer = parent.ownerDocument.createElement('div');
    this.mainContainer.className = 'workbench monaco-workbench';
    this.mainContainer.tabIndex = -1;
    this._register(toDisposable(() => this.mainContainer.remove()));
  }

  get mainContainerDimension(): IViewSize {
    return { width: this.mainContainer.clientWidth, height: this.mainContainer.clientHeight };
  }

  get mainContainerOffset(): { top: number; quickPickTop: number } {
    const top = this.getPart(Parts.TITLEBAR_PART).minimumHeight;
    return { top, quickPickTop: top };
  }

  getContainer(part: Parts): HTMLElement {
    return this.getPart(part).element;
  }

  isVisible(part: Parts): boolean {
    return !isOptionalPart(part) || !this.layoutState[hiddenKey[part]];
  }

  setPartHidden(hidden: boolean, part: Parts): void {
    if (!isOptionalPart(part) || this.layoutState[hiddenKey[part]] === hidden) {
      return;
    }
    const view = this.getPart(part);
    const document = view.element.ownerDocument;
    const moveFocus = hidden && view.element.contains(document.activeElement);
    // The state changes first so the layout the grid runs records no size for a part being hidden.
    this.layoutState[hiddenKey[part]] = hidden;
    try {
      this.grid.setViewVisible(view, !hidden);
    } catch (error) {
      this.layoutState[hiddenKey[part]] = !hidden;
      throw error;
    }
    if (moveFocus) {
      const editor = this.parts.get(Parts.EDITOR_PART)?.element;
      editor?.focus({ preventScroll: true });
      if (!editor || document.activeElement !== editor) {
        this.mainContainer.focus({ preventScroll: true });
      }
    }
    this.didChangePartVisibility.fire({ partId: part, visible: !hidden });
  }

  protected registerPart(part: Part): void {
    if (this.parts.has(part.id)) {
      throw new Error(`Workbench part ${part.id} is already registered.`);
    }
    this.parts.set(part.id, this._register(part));
  }

  protected getPart(id: Parts): Part {
    const part = this.parts.get(id);
    if (!part) {
      throw new Error(`Unknown workbench part: ${id}.`);
    }
    return part;
  }

  protected createWorkbenchLayout(): void {
    const sideBar = this.getPart(Parts.SIDEBAR_PART);
    const panel = this.getPart(Parts.PANEL_PART);
    this._register(sideBar.onDidLayout(({ width }) => {
      if (this.isVisible(sideBar.id)) {
        this.layoutState.sideBarSize = width;
      }
    }));
    this._register(panel.onDidLayout(({ height }) => {
      if (this.isVisible(panel.id)) {
        this.layoutState.panelSize = height;
      }
    }));

    this.grid = this._register(SerializableGrid.deserialize(this.createGridDescriptor(), {
      fromJSON: data => this.getPart((data as { type: Parts }).type),
    }, { proportionalLayout: false }));
    this.mainContainer.append(this.grid.element);
    this.layout();
    for (const part of this.parts.values()) {
      part.setVisible(this.isVisible(part.id));
    }

    const window = this.parent.ownerDocument.defaultView!;
    if (window.ResizeObserver) {
      // The observer also sees window resizes, since the main container fills the viewport.
      const observer = new window.ResizeObserver(([entry]) => {
        if (entry.target.clientWidth !== this.grid.width || entry.target.clientHeight !== this.grid.height) {
          this.layout();
        }
      });
      observer.observe(this.mainContainer);
      this._register(toDisposable(() => observer.disconnect()));
    } else {
      this._register(addDisposableListener(window, 'resize', () => this.layout()));
    }
  }

  layout(): void {
    const { width, height } = this.mainContainerDimension;
    if (width === 0 || height === 0) {
      // A hidden or detached container has no size: laying out would squeeze every part to its
      // minimum and the sidebar and panel would remember those sizes.
      return;
    }
    this.grid.layout(width, height);
  }

  private createGridDescriptor(): ISerializedGrid {
    const { width, height } = this.mainContainerDimension;
    const title = this.getPart(Parts.TITLEBAR_PART);
    const activity = this.getPart(Parts.ACTIVITYBAR_PART);
    const sidebar = this.getPart(Parts.SIDEBAR_PART);
    const editor = this.getPart(Parts.EDITOR_PART);
    const panel = this.getPart(Parts.PANEL_PART);
    const status = this.getPart(Parts.STATUSBAR_PART);
    const middleHeight = Math.max(0, height - title.minimumHeight - (this.isVisible(status.id) ? status.minimumHeight : 0));
    const activityWidth = this.isVisible(activity.id) ? activity.minimumWidth : 0;
    const centerMinimum = Math.max(editor.minimumWidth, this.isVisible(panel.id) ? panel.minimumWidth : 0);

    const size = (requested: number | undefined, fallback: number, min: number, max: number) => {
      const value = requested !== undefined && Number.isFinite(requested) ? requested : fallback;
      return Math.max(min, Math.min(Math.round(value), max));
    };
    const sidebarWidth = size(this.layoutState.sideBarSize, Math.min(300, width / 4), sidebar.minimumWidth,
      Math.min(sidebar.maximumWidth, width - activityWidth - centerMinimum));
    const panelHeight = size(this.layoutState.panelSize, height / 3, panel.minimumHeight,
      Math.min(panel.maximumHeight, middleHeight - editor.minimumHeight));
    this.layoutState.sideBarSize = sidebarWidth;
    this.layoutState.panelSize = panelHeight;

    const leaf = (part: Part, size: number): ISerializedLeafNode => ({
      type: 'leaf', data: part.toJSON(), size, visible: this.isVisible(part.id),
    });
    return {
      orientation: Orientation.VERTICAL, width, height,
      root: {
        type: 'branch', size: width,
        data: [
          leaf(title, title.minimumHeight),
          {
            type: 'branch', size: middleHeight, data: [
              leaf(activity, activity.minimumWidth),
              leaf(sidebar, sidebarWidth),
              {
                type: 'branch',
                size: Math.max(centerMinimum, width - activityWidth - (this.isVisible(sidebar.id) ? sidebarWidth : 0)),
                data: [
                  leaf(editor, Math.max(editor.minimumHeight, middleHeight - (this.isVisible(panel.id) ? panelHeight : 0))),
                  leaf(panel, panelHeight),
                ],
              },
            ],
          },
          leaf(status, status.minimumHeight),
        ],
      },
    };
  }
}
