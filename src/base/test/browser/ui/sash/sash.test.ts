import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { $ } from '../../../../browser/dom.js';
import { Orientation, Sash, SashState } from '../../../../browser/ui/sash/sash.js';

let container: HTMLElement;
let sash: Sash;

beforeEach(() => {
  container = $('.container');
  document.body.append(container);
  sash = new Sash(container, { getVerticalSashLeft: () => 100, getVerticalSashHeight: () => 300 }, { orientation: Orientation.VERTICAL });
});

afterEach(() => {
  sash.dispose();
  container.remove();
});

function pointer(type: string, clientX: number, init: PointerEventInit = {}): void {
  sash.el.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX, clientY: 10, bubbles: true, cancelable: true, ...init }));
}

test('the strip is centred on its boundary and as thick as the global size', () => {
  sash.layout();
  expect(Sash.size).toBe(4);
  expect(sash.el.style.left).toBe('98px');
  expect(sash.el.style.width).toBe('4px');
  expect(sash.el.style.height).toBe('300px');
});

test('a drag reports its start, every move and its end', () => {
  const start = vi.fn();
  const change = vi.fn();
  const end = vi.fn();
  sash.onDidStart(start);
  sash.onDidChange(change);
  sash.onDidEnd(end);

  pointer('pointerdown', 100);
  pointer('pointermove', 130);
  pointer('pointermove', 160);
  pointer('pointerup', 160);
  pointer('pointermove', 200);

  expect(start).toHaveBeenCalledWith(expect.objectContaining({ startX: 100, currentX: 100 }));
  expect(change.mock.calls.map(([event]) => event.currentX)).toEqual([130, 160]);
  expect(end).toHaveBeenCalledTimes(1);
});

test('a cancelled pointer or a lost capture ends the drag', () => {
  const end = vi.fn();
  sash.onDidEnd(end);
  pointer('pointerdown', 100);
  pointer('pointercancel', 100);
  pointer('pointerdown', 100);
  sash.el.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }));
  expect(end).toHaveBeenCalledTimes(2);
});

test('moves from another pointer and secondary buttons are ignored', () => {
  const start = vi.fn();
  const change = vi.fn();
  sash.onDidStart(start);
  sash.onDidChange(change);
  pointer('pointerdown', 100, { button: 2 });
  expect(start).not.toHaveBeenCalled();
  pointer('pointerdown', 100);
  pointer('pointermove', 150, { pointerId: 2 });
  expect(change).not.toHaveBeenCalled();
});

test('a disabled sash does not start a drag, and disabling one mid-drag ends it', () => {
  const start = vi.fn();
  const end = vi.fn();
  sash.onDidStart(start);
  sash.onDidEnd(end);
  sash.state = SashState.Disabled;
  expect(sash.el.classList.contains('disabled')).toBe(true);
  pointer('pointerdown', 100);
  expect(start).not.toHaveBeenCalled();

  sash.state = SashState.Enabled;
  pointer('pointerdown', 100);
  sash.state = SashState.Disabled;
  expect(end).toHaveBeenCalledTimes(1);
});

test('dispose removes the strip and stops reporting', () => {
  const change = vi.fn();
  sash.onDidChange(change);
  const element = sash.el;
  pointer('pointerdown', 100);
  sash.dispose();
  expect(element.isConnected).toBe(false);
  element.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 150 }));
  expect(change).not.toHaveBeenCalled();
  expect(document.body.classList.contains('monaco-sash-dragging-vertical')).toBe(false);
});
