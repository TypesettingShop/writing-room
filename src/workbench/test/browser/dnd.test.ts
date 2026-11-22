import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../../platform/dnd/browser/dnd.js';
import { CompositeDragAndDropObserver, DraggedCompositeIdentifier } from '../../browser/dnd.js';

function transfer() {
  return {
    types: [] as string[],
    effectAllowed: 'none',
    dropEffect: 'none',
    setData(type: string) { this.types.push(type); },
  };
}

function dispatch(element: HTMLElement, type: string, dataTransfer: ReturnType<typeof transfer>) {
  const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer });
  element.dispatchEvent(event);
  return event;
}

describe('CompositeDragAndDropObserver', () => {
  let disposables: DisposableStore;
  let source: HTMLElement;
  let target: HTMLElement;
  let child: HTMLElement;
  const observer = CompositeDragAndDropObserver.INSTANCE;
  const selection = LocalSelectionTransfer.getInstance<DraggedCompositeIdentifier>();

  beforeEach(() => {
    disposables = new DisposableStore();
    source = document.createElement('button');
    target = document.createElement('div');
    child = document.createElement('span');
    target.append(child);
    document.body.append(source, target);
    disposables.add(toDisposable(() => { source.remove(); target.remove(); }));
    disposables.add(observer.registerDraggable(source, () => new DraggedCompositeIdentifier('explorer')));
  });

  afterEach(() => disposables.dispose());

  it('ignores editor-tab and file drags, including during a container drag', () => {
    const onDragOver = vi.fn(() => true);
    const onDrop = vi.fn();
    disposables.add(observer.registerTarget(target, { onDragOver, onDrop, onDragLeave() {} }));
    dispatch(source, 'dragstart', transfer());

    for (const type of ['application/x-editor-tab', 'Files']) {
      const data = transfer();
      data.setData(type);
      expect(dispatch(target, 'dragover', data).defaultPrevented).toBe(false);
      expect(dispatch(target, 'drop', data).defaultPrevented).toBe(false);
    }
    expect(onDragOver).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('accepts the first valid dragenter, including one into a descendant of a refused target', () => {
    const onDrop = vi.fn();
    const onDragOver = vi.fn((event: DragEvent) => event.target === child);
    disposables.add(observer.registerTarget(target, { onDragOver, onDrop, onDragLeave() {} }));

    const data = transfer();
    dispatch(source, 'dragstart', data);
    expect(dispatch(target, 'dragenter', data).defaultPrevented).toBe(false);
    expect(data.dropEffect).toBe('none');
    expect(dispatch(child, 'dragenter', data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe('move');
    expect(dispatch(child, 'drop', data).defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(expect.any(Event), new DraggedCompositeIdentifier('explorer'));
    expect(selection.hasData(DraggedCompositeIdentifier.prototype)).toBe(false);
  });

  it('preserves a view container drag through window blur and accepts the drop', () => {
    const onDrop = vi.fn();
    disposables.add(observer.registerTarget(target, { onDragOver: () => true, onDrop, onDragLeave() {} }));
    const data = transfer();
    dispatch(source, 'dragstart', data);
    expect(dispatch(child, 'dragover', data).defaultPrevented).toBe(true);

    window.dispatchEvent(new Event('blur'));
    data.dropEffect = 'none';
    expect(dispatch(child, 'dragover', data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe('move');
    expect(dispatch(child, 'drop', data).defaultPrevented).toBe(true);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(expect.any(Event), new DraggedCompositeIdentifier('explorer'));
    expect(selection.hasData(DraggedCompositeIdentifier.prototype)).toBe(false);
  });

  it('cleans the target and typed payload on drop and on dragend', () => {
    const onDragLeave = vi.fn();
    const onDrop = vi.fn();
    disposables.add(observer.registerTarget(target, { onDragOver: () => true, onDrop, onDragLeave }));

    const data = transfer();
    dispatch(source, 'dragstart', data);
    dispatch(target, 'dragenter', data);
    dispatch(child, 'dragenter', data);
    dispatch(target, 'dragleave', data);
    expect(onDragLeave).not.toHaveBeenCalled();
    expect(dispatch(child, 'dragover', data).defaultPrevented).toBe(true);
    expect(data.dropEffect).toBe('move');
    dispatch(child, 'drop', data);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(expect.any(Event), new DraggedCompositeIdentifier('explorer'));
    expect(onDragLeave).toHaveBeenCalledTimes(1);
    expect(selection.hasData(DraggedCompositeIdentifier.prototype)).toBe(false);

    const canceled = transfer();
    dispatch(source, 'dragstart', canceled);
    dispatch(target, 'dragenter', canceled);
    dispatch(source, 'dragend', canceled);
    expect(onDragLeave).toHaveBeenCalledTimes(2);
    expect(selection.hasData(DraggedCompositeIdentifier.prototype)).toBe(false);
    expect(dispatch(target, 'dragover', canceled).defaultPrevented).toBe(false);

    // The canceled drag never left the target. The next drag still leaves it on its first dragleave.
    const next = transfer();
    dispatch(source, 'dragstart', next);
    onDragLeave.mockClear();
    dispatch(target, 'dragenter', next);
    dispatch(target, 'dragleave', next);
    expect(onDragLeave).toHaveBeenCalledOnce();
    dispatch(source, 'dragend', next);
  });
});
