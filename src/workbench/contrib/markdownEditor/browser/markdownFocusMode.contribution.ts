import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { getMarkdownEditorMode, MarkdownEditorModeContext } from '../common/markdownEditor.js';

const ID = 'markdownEditor.toggleFocusMode';
const focusMode = new RawContextKey<boolean>('markdownEditor.focusMode', false);
const active = focusMode.isEqualTo(true);
const available = ContextKeyExpr.or(active, MarkdownEditorModeContext.isEqualTo('wysiwyg'));
const parts = [Parts.SIDEBAR_PART, Parts.PANEL_PART, Parts.ACTIVITYBAR_PART, Parts.STATUSBAR_PART] as const;

const IMarkdownFocusMode = createDecorator<IMarkdownFocusMode>('markdownFocusMode');
interface IMarkdownFocusMode extends BrandedService {
  toggle(): void;
  exit(): void;
}

class MarkdownFocusMode extends Disposable implements IMarkdownFocusMode {
  declare readonly _serviceBrand: undefined;
  private readonly enabled;

  constructor(
    @IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
    @IEditorService private readonly editors: IEditorService,
    @IContextKeyService context: IContextKeyService,
  ) {
    super();
    this.enabled = focusMode.bindTo(context);
    this._register(editors.onDidActiveEditorChange(() => {
      if (getMarkdownEditorMode(editors.activeEditor) !== 'wysiwyg') this.exit();
    }));
  }

  toggle(): void {
    if (this.enabled.get()) {
      this.exit();
    } else if (getMarkdownEditorMode(this.editors.activeEditor) === 'wysiwyg') {
      this.setEnabled(true);
    }
    this.editors.activeEditorPane?.focus();
  }

  exit(): void {
    if (this.enabled.get()) this.setEnabled(false);
  }

  private setEnabled(enabled: boolean): void {
    this.layout.mainContainer.classList.toggle('markdown-focus-mode', enabled);
    for (const part of parts) this.layout.setPartHidden(enabled, part, { transient: true });
    this.enabled.set(enabled);
  }

  override dispose(): void {
    this.exit();
    this.enabled.reset();
    super.dispose();
  }
}

registerSingleton(IMarkdownFocusMode, MarkdownFocusMode);
registerAction2(class extends Action2 {
  constructor() {
    super({ id: ID, title: 'Toggle Focus Mode', category: 'Markdown', f1: true, precondition: available, toggled: active });
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IMarkdownFocusMode).toggle();
  }
});

MenuRegistry.appendMenuItem(MenuId.MenubarAppearanceMenu, {
  group: '2_workbench_layout', order: 5, when: available, command: { id: ID, title: 'Markdown Focus Mode', toggled: active },
});

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: 'markdownEditor.exitFocusMode', title: 'Exit Markdown Focus Mode', precondition: active,
      keybinding: { primary: KeyCode.Escape, weight: KeybindingWeight.WorkbenchContrib },
    });
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IMarkdownFocusMode).exit();
  }
});
