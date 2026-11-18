import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { $, append } from '../../../../../base/browser/dom.js';
import type { Dimension } from '../../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../../../../platform/dnd/browser/dnd.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { CompositeDragAndDropObserver, DraggedCompositeIdentifier, DraggedEditorGroupIdentifier, DraggedEditorIdentifier, EditorDragAndDropObserver } from '../../../../browser/dnd.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../../browser/editor.js';
import { setEditorPartOptionsProvider } from '../../../../browser/parts/editor/editor.js';
import type { IEditorGroupView } from '../../../../browser/parts/editor/editor.js';
import { getSplitDirection } from '../../../../browser/parts/editor/editorDropTarget.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import '../../../../workbench.web.main.js';

const { UP, DOWN, LEFT, RIGHT } = GroupDirection;

describe('getSplitDirection', () => {
  // A body of 1000 x 500: 10 % is 100 x 50, 30 % of the width is 300, a third 333.3, half 250.
  const tab = (x: number, y: number, vertical = true) => getSplitDirection(x, y, 1000, 500, false, vertical);
  const group = (x: number, y: number, vertical = true) => getSplitDirection(x, y, 1000, 500, true, vertical);

  test('a tab moves into the group inside the box 10 % in from every edge, exclusive', () => {
    expect(tab(500, 250)).toBeUndefined();
    expect(tab(100.5, 250)).toBeUndefined();
    expect(tab(899.5, 250)).toBeUndefined();
    expect(tab(500, 50.5)).toBeUndefined();
    expect(tab(500, 449.5)).toBeUndefined();
    expect(tab(100.5, 50.5)).toBeUndefined();
  });

  test('a tab splits on the 10 % edges themselves and outside them', () => {
    expect(tab(100, 250)).toBe(LEFT);
    expect(tab(0, 250)).toBe(LEFT);
    expect(tab(900, 250)).toBe(RIGHT);
    expect(tab(1000, 250)).toBe(RIGHT);
    expect(tab(500, 50)).toBe(UP);
    expect(tab(500, 0)).toBe(UP);
    expect(tab(500, 450)).toBe(DOWN);
    expect(tab(500, 500)).toBe(DOWN);
  });

  test('a group merges inside the box 30 % in from the sides and 10 % from top and bottom', () => {
    expect(group(500, 250)).toBeUndefined();
    expect(group(300.5, 250)).toBeUndefined();
    expect(group(699.5, 250)).toBeUndefined();
    expect(group(500, 50.5)).toBeUndefined();
    expect(group(500, 449.5)).toBeUndefined();
    expect(group(300, 250)).toBe(LEFT);
    expect(group(700, 250)).toBe(RIGHT);
    expect(group(200, 250)).toBe(LEFT);
    expect(group(800, 250)).toBe(RIGHT);
    expect(group(500, 50)).toBe(UP);
    expect(group(500, 450)).toBe(DOWN);
    // Where a group still splits, a tab already moves.
    expect(tab(200, 250)).toBeUndefined();
    expect(tab(800, 250)).toBeUndefined();
  });

  test('outside the box, the outer thirds split left and right before up and down', () => {
    expect(tab(333, 10)).toBe(LEFT);
    expect(tab(333.5, 10)).toBe(UP);
    expect(tab(666.5, 10)).toBe(UP);
    expect(tab(667, 10)).toBe(RIGHT);
    expect(tab(333, 490)).toBe(LEFT);
    expect(tab(333.5, 490)).toBe(DOWN);
    expect(tab(667, 490)).toBe(RIGHT);
    expect(tab(50, 10)).toBe(LEFT);
    expect(tab(950, 490)).toBe(RIGHT);
    expect(group(333.5, 40)).toBe(UP);
    expect(group(666.5, 460)).toBe(DOWN);
  });

  test('the middle third splits up in the top band and down in the bottom band', () => {
    // Outside the centre box, the middle third is only reachable within 10 % of the top or bottom,
    // so the half-height line between up and down always falls inside the box.
    expect(tab(500, 49.9)).toBe(UP);
    expect(tab(500, 450.1)).toBe(DOWN);
    expect(group(334, 0)).toBe(UP);
    expect(group(666, 500)).toBe(DOWN);
  });

  test('preferring horizontal splits swaps the axes: thirds up and down, halves left and right', () => {
    expect(tab(10, 166, false)).toBe(UP);
    expect(tab(10, 167, false)).toBe(LEFT);
    expect(tab(10, 334, false)).toBe(DOWN);
    expect(tab(499.9, 490, false)).toBe(DOWN);
    expect(tab(990, 250, false)).toBe(RIGHT);
    expect(tab(10, 250, false)).toBe(LEFT);
    // A group's wide band is then the top and bottom 30 %.
    expect(group(500, 150, false)).toBe(UP);
    expect(group(500, 150.5, false)).toBeUndefined();
    expect(group(100.5, 250, false)).toBeUndefined();
    expect(group(100, 250, false)).toBe(LEFT);
  });
});

// --- the part in jsdom: which drags the editor area takes

const PANE_ID = 'test.dropTargetPane';
const INPUT_ID = 'test.dropTargetInput';

class TestInput extends EditorInput {
  constructor(readonly name: string) { super(); }
  override get typeId(): string { return INPUT_ID; }
  override get resource(): undefined { return undefined; }
  override getName(): string { return this.name; }
}

class TestPane extends EditorPane {
  element!: HTMLElement;
  constructor() { super(PANE_ID); }
  protected createEditor(parent: HTMLElement): void {
    this.element = append(parent, $('.test-pane'));
  }
  layout(_dimension: Dimension): void {}
}

/** A stand-in for the browser's `DataTransfer`, which jsdom lacks. */
function transfer() {
  return {
    types: [] as string[],
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type: string) { this.types.push(type); },
  };
}

type Transfer = ReturnType<typeof transfer>;

function dispatch(element: EventTarget, type: string, dataTransfer: Transfer, point: { clientX?: number; clientY?: number } = {}) {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer, clientX: 0, clientY: 0, ...point });
  element.dispatchEvent(event);
  return event as unknown as DragEvent;
}

const registry = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!;
const disposables = new DisposableStore();
let part: EditorPart;
let left: IEditorGroupView;
let right: IEditorGroupView;
let a: TestInput;
let b: TestInput;
let c: TestInput;

const tabOf = (group: IEditorGroupView, name: string) => [...group.element.querySelectorAll('[role="tab"]')]
  .find(tab => tab.textContent === name)!.parentElement!;
const bodyOf = (group: IEditorGroupView) => (group.activeEditorPane as TestPane).element;
const overlay = () => document.querySelector('[data-editor-drop-position]');

/** Gives a group's element a box: a body of 1000 x 500 below the 35 px strip, at the origin. */
function placeGroup(group: IEditorGroupView): void {
  vi.spyOn(group.element, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, right: 1000, bottom: 535, width: 1000, height: 535, x: 0, y: 0, toJSON() {} } as DOMRect,
  );
}

beforeEach(async () => {
  disposables.add(registry.registerEditorPane(EditorPaneDescriptor.create(TestPane, PANE_ID, 'Test'), [INPUT_ID]));
  const services = new ServiceCollection();
  const instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add(toDisposable(() => container.remove()));
  left = part.activeGroup;
  [a, b] = [new TestInput('a'), new TestInput('b')];
  await left.openEditor(a);
  await left.openEditor(b);
  right = part.addGroup(left, GroupDirection.RIGHT);
  c = new TestInput('c');
  await right.openEditor(c);
});

afterEach(() => {
  EditorDragAndDropObserver.INSTANCE.endDrag();
  disposables.clear();
  vi.restoreAllMocks();
});

describe('the editor area and the composite bars tell their drags apart', () => {
  test('a dragged view container gets no overlay, no marker and no drop on the editor area', () => {
    const icon = document.body.appendChild(document.createElement('button'));
    disposables.add(toDisposable(() => icon.remove()));
    disposables.add(CompositeDragAndDropObserver.INSTANCE.registerDraggable(icon, () => new DraggedCompositeIdentifier('workbench.view.explorer')));
    const data = transfer();
    dispatch(icon, 'dragstart', data);
    expect(LocalSelectionTransfer.getInstance().hasData(DraggedCompositeIdentifier.prototype)).toBe(true);

    for (const target of [bodyOf(right), bodyOf(left), tabOf(right, 'c'), right.titleContainer]) {
      dispatch(target, 'dragenter', data);
      const over = dispatch(target, 'dragover', data);
      expect(overlay()).toBeNull();
      expect(document.querySelector('[data-tab-drop-position]')).toBeNull();
      // Refused rather than ignored, so the browser does nothing with it either.
      expect(over.defaultPrevented).toBe(true);
      expect(data.dropEffect).toBe('none');
      expect(EditorDragAndDropObserver.INSTANCE.getDraggedItem(over, target)).toBeUndefined();
      dispatch(target, 'drop', data);
    }
    expect([left.editors, right.editors]).toEqual([[a, b], [c]]);
    expect(part.count).toBe(2);
    dispatch(icon, 'dragend', data);
  });

  test('a dragged tab is not taken by a composite bar, and a dragged group neither', () => {
    const bar = document.body.appendChild(document.createElement('div'));
    disposables.add(toDisposable(() => bar.remove()));
    const onDragOver = vi.fn(() => true);
    const onDrop = vi.fn();
    disposables.add(CompositeDragAndDropObserver.INSTANCE.registerTarget(bar, { onDragOver, onDrop, onDragLeave() {} }));

    for (const source of [tabOf(left, 'a'), left.element.querySelector<HTMLElement>('[role="tablist"]')!]) {
      const data = transfer();
      dispatch(source, 'dragstart', data);
      expect(data.types).toContain('text/plain');
      expect(data.effectAllowed).toBe('move');
      dispatch(bar, 'dragenter', data);
      expect(dispatch(bar, 'dragover', data).defaultPrevented).toBe(false);
      expect(dispatch(bar, 'drop', data).defaultPrevented).toBe(false);
      dispatch(source, 'dragend', data);
    }
    expect(onDragOver).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  test('a dragged tab and a dragged group are what the editor area reads them as', () => {
    const data = transfer();
    const tab = tabOf(left, 'a');
    dispatch(tab, 'dragstart', data);
    const over = dispatch(bodyOf(right), 'dragover', data);
    expect(EditorDragAndDropObserver.INSTANCE.getDraggedItem(over, tab)).toEqual(new DraggedEditorIdentifier({ groupId: left.id, editor: a }));
    dispatch(tab, 'dragend', data);
    expect(EditorDragAndDropObserver.INSTANCE.getDraggedItem(over, tab)).toBeUndefined();

    const strip = left.element.querySelector<HTMLElement>('[role="tablist"]')!;
    const groupData = transfer();
    dispatch(strip, 'dragstart', groupData);
    const groupOver = dispatch(bodyOf(right), 'dragover', groupData);
    expect(EditorDragAndDropObserver.INSTANCE.getDraggedItem(groupOver, strip)).toEqual(new DraggedEditorGroupIdentifier(left.id));
    // The composite payload slot does not hold it.
    expect(LocalSelectionTransfer.getInstance().hasData(DraggedCompositeIdentifier.prototype)).toBe(false);
  });
});

describe('dropping on a group body', () => {
  test('a tab dropped in the centre of another group moves there, active, in the active group', () => {
    placeGroup(right);
    const data = transfer();
    dispatch(tabOf(left, 'a'), 'dragstart', data);
    const enter = dispatch(bodyOf(right), 'dragenter', data, { clientX: 500, clientY: 300 });
    expect(enter.defaultPrevented).toBe(true);
    expect(overlay()?.getAttribute('data-editor-drop-position')).toBe('center');
    // The overlay sits over the body and takes the events from here on.
    const overlayElement = overlay()!.parentElement!;
    expect(dispatch(overlayElement, 'dragover', data, { clientX: 500, clientY: 300 }).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe('move');
    dispatch(overlayElement, 'drop', data, { clientX: 500, clientY: 300 });

    expect(overlay()).toBeNull();
    expect([left.editors, right.editors]).toEqual([[b], [c, a]]);
    expect(right.activeEditor).toBe(a);
    expect(part.activeGroup).toBe(right);
    expect(LocalSelectionTransfer.getInstance().hasData(DraggedEditorIdentifier.prototype)).toBe(false);
  });

  test('a tab dropped on an edge splits the target; a group\'s only tab moves its group instead', () => {
    placeGroup(right);
    const data = transfer();
    dispatch(tabOf(left, 'a'), 'dragstart', data);
    dispatch(bodyOf(right), 'dragenter', data, { clientX: 990, clientY: 300 });
    expect(overlay()?.getAttribute('data-editor-drop-position')).toBe('right');
    dispatch(overlay()!.parentElement!, 'drop', data, { clientX: 990, clientY: 300 });
    expect(part.count).toBe(3);
    const added = part.activeGroup;
    expect(added.editors).toEqual([a]);
    expect([left.editors, right.editors]).toEqual([[b], [c]]);

    // `c` is the only editor of `right`: dropped below `left`, the group itself moves.
    placeGroup(left);
    const only = transfer();
    dispatch(tabOf(right, 'c'), 'dragstart', only);
    dispatch(bodyOf(left), 'dragenter', only, { clientX: 500, clientY: 530 });
    expect(overlay()?.getAttribute('data-editor-drop-position')).toBe('down');
    const element = right.element;
    dispatch(overlay()!.parentElement!, 'drop', only, { clientX: 500, clientY: 530 });
    expect(part.count).toBe(3);
    expect(part.getGroup(right.id)).toBe(right);
    expect(right.element).toBe(element);
    expect(right.editors).toEqual([c]);
    expect(part.activeGroup).toBe(right);
  });

  test('a group\'s only tab and a group over itself get no overlay, and their drops do nothing', () => {
    placeGroup(right);
    for (const source of [tabOf(right, 'c'), right.element.querySelector<HTMLElement>('[role="tablist"]')!]) {
      const data = transfer();
      dispatch(source, 'dragstart', data);
      const over = dispatch(bodyOf(right), 'dragover', data, { clientX: 990, clientY: 300 });
      expect(overlay()).toBeNull();
      expect(data.dropEffect).toBe('none');
      expect(over.defaultPrevented).toBe(true);
      dispatch(bodyOf(right), 'drop', data, { clientX: 990, clientY: 300 });
      dispatch(source, 'dragend', data);
    }
    expect(part.count).toBe(2);
    expect(right.editors).toEqual([c]);
  });

  test('the overlay and the payload go on Escape, and the next drop finds nothing', () => {
    placeGroup(right);
    const data = transfer();
    dispatch(tabOf(left, 'a'), 'dragstart', data);
    dispatch(bodyOf(right), 'dragenter', data, { clientX: 500, clientY: 300 });
    const overlayElement = overlay()!.parentElement!;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay()).toBeNull();
    expect(LocalSelectionTransfer.getInstance().hasData(DraggedEditorIdentifier.prototype)).toBe(false);
    dispatch(overlayElement, 'drop', data, { clientX: 500, clientY: 300 });
    dispatch(bodyOf(right), 'drop', data, { clientX: 500, clientY: 300 });
    expect([left.editors, right.editors]).toEqual([[a, b], [c]]);
  });

  test('the overlay goes when the group it covers goes', () => {
    placeGroup(right);
    const data = transfer();
    dispatch(tabOf(left, 'a'), 'dragstart', data);
    dispatch(bodyOf(right), 'dragenter', data, { clientX: 500, clientY: 300 });
    expect(overlay()).not.toBeNull();
    part.removeGroup(right);
    expect(overlay()).toBeNull();
  });
});

describe('the strip', () => {
  test('marks the hovered half and drops a tab from another group there, uncorrected', () => {
    const data = transfer();
    dispatch(tabOf(right, 'c'), 'dragstart', data);
    const target = tabOf(left, 'a');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
    expect(dispatch(target, 'dragover', data, { clientX: 80 }).defaultPrevented).toBe(true);
    expect(target.getAttribute('data-tab-drop-position')).toBe('after');
    dispatch(target, 'drop', data, { clientX: 80 });
    expect(target.hasAttribute('data-tab-drop-position')).toBe(false);
    expect(left.editors).toEqual([a, c, b]);
    expect(left.activeEditor).toBe(c);
    expect(part.count).toBe(1);
    expect(part.activeGroup).toBe(left);
  });

  test('a group dropped on another strip merges at the marker; on its own strip it is refused', () => {
    const strip = right.element.querySelector<HTMLElement>('[role="tablist"]')!;
    const own = transfer();
    dispatch(strip, 'dragstart', own);
    expect(dispatch(tabOf(right, 'c'), 'dragover', own).defaultPrevented).toBe(false);
    expect(document.querySelector('[data-tab-drop-position]')).toBeNull();
    dispatch(strip, 'dragend', own);

    const data = transfer();
    dispatch(strip, 'dragstart', data);
    const target = tabOf(left, 'a');
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
    dispatch(target, 'dragover', data, { clientX: 20 });
    expect(target.getAttribute('data-tab-drop-position')).toBe('before');
    dispatch(target, 'drop', data, { clientX: 20 });
    expect(part.count).toBe(1);
    expect(left.editors).toEqual([c, a, b]);
    expect(left.activeEditor).toBe(c);
  });
});

describe('splitting a group narrower than two minimum widths', () => {
  const lefts = () => part.getGroups().map(group => Number.parseFloat(group.element.parentElement!.style.left));
  const widths = () => part.getGroups().map(group => Number.parseFloat(group.element.style.width));

  function expectRow(total: number): void {
    const order = part.getGroups().map((_, i) => i).sort((i, j) => lefts()[i] - lefts()[j]);
    let offset = 0;
    for (const i of order) {
      expect(widths()[i]).toBeGreaterThanOrEqual(0);
      // Each group starts where the one before it ends: none overlaps another.
      expect(lefts()[i]).toBe(offset);
      offset += widths()[i];
    }
    expect(offset).toBe(total);
  }

  test.each(['auto', 'split', 'distribute'] as const)('with %s sizing, the neighbours give up the space', splitSizing => {
    disposables.add(setEditorPartOptionsProvider(() => ({ splitSizing })));
    part.layout(900, 600, 0, 0);
    part.addGroup(right, GroupDirection.RIGHT);
    const narrow = part.getGroups().find(group => Number.parseFloat(group.element.style.width) < 440)!;
    expect(narrow).toBeDefined();
    part.addGroup(narrow, GroupDirection.RIGHT);
    expect(part.count).toBe(4);
    expect(Math.min(...widths())).toBeGreaterThanOrEqual(220);
    expectRow(900);
  });

  test('when the neighbours cannot give enough, the groups keep their minimum side by side without overlapping', () => {
    disposables.add(setEditorPartOptionsProvider(() => ({ splitSizing: 'split' })));
    part.layout(500, 600, 0, 0);
    part.addGroup(right, GroupDirection.RIGHT);
    expect(part.minimumWidth).toBe(660);
    expect(Math.min(...widths())).toBeGreaterThanOrEqual(220);
    const order = part.getGroups().map((_, i) => i).sort((i, j) => lefts()[i] - lefts()[j]);
    let offset = 0;
    for (const i of order) {
      expect(lefts()[i]).toBe(offset);
      offset += widths()[i];
    }
  });
});
