import { addDisposableListener } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getKeybindingPlatform } from '../../../../base/common/keybindings.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AbstractKeybindingService } from '../../../../platform/keybinding/common/abstractKeybindingService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';

function isTextInput(target: EventTarget | null): boolean {
  for (let node = target as Node | null; node?.nodeType; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
    if (node instanceof HTMLElement) {
      if (node.matches('input, textarea, [role~="textbox"]')) {
        return true;
      }
      const editable = node.getAttribute('contenteditable')?.toLowerCase();
      if (editable === '' || editable === 'true' || editable === 'plaintext-only') {
        return true;
      }
      if (editable === 'false') {
        return false;
      }
    }
  }
  return false;
}

export class WorkbenchKeybindingService extends AbstractKeybindingService {
  constructor(
    @ICommandService commands: ICommandService,
    @IContextKeyService private readonly context: IContextKeyService,
  ) {
    super(commands, getKeybindingPlatform(window.navigator.platform));
    const inputFocus = InputFocusedContext.bindTo(context);
    const activeTarget = () => {
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const onFocus = (event: FocusEvent) => inputFocus.set(isTextInput(event.composedPath()[0] ?? null));
    const onBlur = (event: FocusEvent) => inputFocus.set(isTextInput(event.relatedTarget));
    const onWindowBlur = () => {
      inputFocus.reset();
      this.cancelChord();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
        this.cancelChord();
        return;
      }
      const key = new StandardKeyboardEvent(event);
      if (!key.chord) {
        return;
      }

      const target = event.composedPath()[0] ?? activeTarget();
      const typing = isTextInput(target);
      inputFocus.set(typing);
      // A pending chord owns the next key, so `ctrl+k z` completes (and swallows z) inside an editor too.
      if (typing && key.mightType && !this.inChordMode) {
        return;
      }
      if (this.dispatch(key.chord, this.context.getContext(target))) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    inputFocus.set(isTextInput(activeTarget()));
    this._register(addDisposableListener(window, 'keydown', onKeyDown, true));
    this._register(addDisposableListener(window, 'focusin', onFocus, true));
    this._register(addDisposableListener(window, 'focusout', onBlur, true));
    this._register(addDisposableListener(window, 'blur', onWindowBlur));
    this._register(toDisposable(() => inputFocus.reset()));
  }
}

registerSingleton(IKeybindingService, WorkbenchKeybindingService);
