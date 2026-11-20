import { parseKeybinding } from '../../../../base/common/keybindingParser.js';
import type { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IKeybindingContribution } from '../../../../platform/extensions/common/extensions.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { contributionEntries, contributionRecord, contributionWhen } from '../../extensions/common/contributionValidation.js';
import type { IExtensionPointUser } from '../../extensions/common/extensionsRegistry.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { getKeybindingPlatform } from '../../../../base/common/keybindings.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { forwardMonacoChordPrefix } from '../../../../editor/browser/monaco.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
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
    @ICodeEditorService editors: ICodeEditorService,
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

      const path = event.composedPath();
      const target = path[0] ?? activeTarget();
      const typing = isTextInput(target);
      inputFocus.set(typing);
      // A pending chord owns the next key, so `ctrl+k z` completes (and swallows z) inside an editor too.
      if (typing && key.mightType && !this.inChordMode) {
        return;
      }
      const result = this.dispatch(key.chord, this.context.getContext(target));
      if (result === 'unhandled') {
        return;
      }
      // Monaco may finish an unmatched chord for a bubbling event on a registered editor's path, and then
      // decides the default action. The key reaches nothing else either way.
      let preventDefault = true;
      if (result !== 'handled' && event.bubbles && target instanceof HTMLElement
        && editors.listCodeEditors().some(editor => path.includes(editor.getContainerDomNode()))) {
        preventDefault = forwardMonacoChordPrefix(result.unmatchedPrefix, event, target) ?? true;
      }
      if (preventDefault) {
        event.preventDefault();
      }
      event.stopPropagation();
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

export function registerExtensionKeybindings(
  users: readonly IExtensionPointUser<unknown>[], registrations: DisposableStore,
): void {
  for (const user of users) {
    const base = 'contributes.keybindings';
    for (const [index, value] of contributionEntries(user.value, base, user).entries()) {
      const path = base + '.' + index;
      const entry = contributionRecord<IKeybindingContribution>(value, path, user, ['command', 'key'], ['mac', 'win', 'linux', 'when']);
      if (!entry) {
        continue;
      }
      const invalid = (['key', 'mac', 'win', 'linux'] as const).find(key => {
        const binding = entry[key];
        return binding !== undefined && !parseKeybinding(binding);
      });
      if (invalid) {
        user.collector.error(path + '.' + invalid, 'Invalid keybinding.');
        continue;
      }
      const when = contributionWhen(entry.when, path + '.when', user);
      if (when === false) {
        continue;
      }
      const weight = (user.description.isBuiltin ? KeybindingWeight.BuiltinExtension : KeybindingWeight.ExternalExtension) + index;
      registrations.add(KeybindingsRegistry.registerKeybindingRule({
        id: entry.command, key: entry.key, weight, when, args: entry.args,
        mac: entry.mac ? { key: entry.mac } : undefined,
        win: entry.win ? { key: entry.win } : undefined,
        linux: entry.linux ? { key: entry.linux } : undefined,
      }));
    }
  }
}
