import { expect, test, vi } from 'vitest';
import { $, addDisposableListener, append, clearNode, Dimension } from '../../browser/dom.js';

test('creates elements with shorthand classes and id and appends text and nodes', () => {
  const child = $('button', { type: 'button' }, 'Open');
  const parent = $('section.one#workbench.two', { 'data-count': 0, 'aria-expanded': false }, 'Before ', child);

  expect(parent.tagName).toBe('SECTION');
  expect(parent.id).toBe('workbench');
  expect([...parent.classList]).toEqual(['one', 'two']);
  expect(parent.dataset.count).toBe('0');
  expect(parent.getAttribute('aria-expanded')).toBe('false');
  expect(parent.textContent).toBe('Before Open');
  const extra = $('span');
  expect(append(parent, extra)).toBe(extra);
  expect(parent.lastChild).toBe(extra);
  clearNode(parent);
  expect(parent.childNodes).toHaveLength(0);
});

test('removes a listener using the capture flag it was installed with', () => {
  const button = $('button');
  const options = { capture: true };
  const listener = vi.fn();
  const subscription = addDisposableListener(button, 'click', listener, options);
  button.click();
  options.capture = false;
  subscription.dispose();
  button.click();

  expect(listener).toHaveBeenCalledTimes(1);
});

test('dimensions hold explicit sizes independent of the DOM', () => {
  expect(new Dimension(220, 70)).toMatchObject({ width: 220, height: 70 });
  expect(Dimension.None).toMatchObject({ width: 0, height: 0 });
});
