import { addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { getWorldPresets } from '../../../../platform/world/common/worldPresets.js';
import type { WorldViewState } from './worldViewState.js';
import './media/world.css';

export function renderWorldPresetPicker(parent: HTMLElement, state: WorldViewState): DisposableStore {
  const disposables = new DisposableStore();
  const document = parent.ownerDocument;
  const hint = parent.appendChild(document.createElement('p'));
  hint.textContent = 'Choose a starting point for this world.';
  const list = parent.appendChild(document.createElement('ul'));
  list.className = 'world-presets';
  const buttons = getWorldPresets().map(({ id, label, description }) => {
    const item = list.appendChild(document.createElement('li'));
    const button = item.appendChild(document.createElement('button'));
    button.type = 'button';
    const name = button.appendChild(document.createElement('span'));
    name.textContent = label;
    const detail = button.appendChild(document.createElement('span'));
    detail.textContent = description;
    detail.className = 'world-preset-description';
    disposables.add(addDisposableListener(button, 'click', () => {
      if (!state.busy) {
        void state.applyPreset(id);
      }
    }));
    return button;
  });
  const updateBusy = () => {
    list.setAttribute('aria-busy', String(state.busy));
    for (const button of buttons) {
      // Keep the selected button focused so a failed save can be retried from the keyboard.
      button.setAttribute('aria-disabled', String(state.busy));
    }
  };
  disposables.add(state.onDidChange(updateBusy));
  updateBusy();
  return disposables;
}
