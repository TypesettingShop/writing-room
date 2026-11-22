import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../base/common/resources.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommands.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { DEFAULT_EDITOR_ID, IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { isTextFileResource } from '../../../services/textfile/common/textfiles.js';
import { FileEditorInput } from '../../files/browser/editors/fileEditorInput.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import {
  getMarkdownEditorMode, isMarkdownResource, MARKDOWN_EDITOR_DEFAULT_MODE,
  defaultMarkdownFocusWidth, MARKDOWN_EDITOR_FOCUS_DIM, MARKDOWN_EDITOR_FOCUS_WIDTH, MARKDOWN_EDITOR_FONT_FAMILY,
  defaultMarkdownContentLayout, MARKDOWN_EDITOR_CONTENT_LAYOUT, MARKDOWN_EDITOR_CONTENT_WIDTH, MARKDOWN_EDITOR_TYPEWRITER,
  defaultMarkdownFonts, MARKDOWN_EDITOR_FONT_SIZE, markdownContentLayouts, markdownContentWidth,
  MarkdownEditorModeContext, markdownFontFamilies, markdownFontSizes,
} from '../common/markdownEditor.js';
import { MarkdownEditorInput, MarkdownEditorInputSerializer } from './markdownEditorInput.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';
import './markdownEditorToolbar.contribution.js';
import './markdownEditorContextMenu.contribution.js';
import './markdownWriting.contribution.js';
import './markdownFocusMode.contribution.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(MarkdownEditorPane, MarkdownEditorPane.ID, 'Manuscript Editor'), [MarkdownEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(MarkdownEditorInput.ID, MarkdownEditorInputSerializer);

configurationRegistry.registerConfiguration({
  id: 'markdownEditor',
  title: 'Manuscript Editor',
  properties: {
    [MARKDOWN_EDITOR_CONTENT_WIDTH]: {
      type: 'integer',
      default: markdownContentWidth.defaultValue,
      minimum: markdownContentWidth.min,
      maximum: markdownContentWidth.max,
      description: 'Maximum line width in ch for centered visual Markdown outside Focus Mode, excluding padding and borders.',
    },
    [MARKDOWN_EDITOR_CONTENT_LAYOUT]: {
      type: 'string',
      enum: [...markdownContentLayouts],
      default: defaultMarkdownContentLayout,
      description: 'Centers visual Markdown or fills the editor width outside Focus Mode.',
    },
    [MARKDOWN_EDITOR_FOCUS_WIDTH]: {
      type: 'string',
      default: defaultMarkdownFocusWidth,
      description: 'Maximum width of the Markdown writing surface in Focus Mode, as a CSS length.',
    },
    [MARKDOWN_EDITOR_FOCUS_DIM]: {
      type: 'boolean',
      default: true,
      description: 'Dims Markdown blocks outside the current paragraph in Focus Mode.',
    },
    [MARKDOWN_EDITOR_TYPEWRITER]: {
      type: 'boolean',
      default: false,
      description: 'Centers the caret line vertically as you write in the visual Markdown editor.',
    },
    [MARKDOWN_EDITOR_DEFAULT_MODE]: {
      type: 'string',
      enum: ['wysiwyg', 'source'],
      default: 'wysiwyg',
      description: 'Controls how Markdown files open by default. Editor associations take precedence.',
    },
    [MARKDOWN_EDITOR_FONT_SIZE]: {
      type: 'integer',
      enum: markdownFontSizes,
      default: defaultMarkdownFonts.size,
      description: 'Default body size in points in the visual Markdown editor. Headings scale with this size.',
    },
    [MARKDOWN_EDITOR_FONT_FAMILY]: {
      type: ['string', 'object'],
      default: defaultMarkdownFonts.family,
      pattern: `^(?:${markdownFontFamilies.map(({ value }) => value).join('|')})$`,
      additionalProperties: false,
      properties: {
        serif: { type: 'string', description: 'CSS font-family list for the legacy font-serif class.' },
        sans: { type: 'string', description: 'CSS font-family list for the legacy font-sans class.' },
      },
      description: 'Default body font in the visual Markdown editor. Choose '
        + markdownFontFamilies.map(({ value }) => value).join(', ')
        + '. A legacy object sets the font-serif and font-sans class stacks and uses Noto Sans KR for body text.',
    },
  },
});

class MarkdownEditorContribution extends Disposable {
  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @IFileService fileService: IFileService,
    @IEditorGroupsService groups: IEditorGroupsService,
    @IInstantiationService instantiationService: IInstantiationService,
    @IConfigurationService configuration: IConfigurationService,
  ) {
    super();
    const registrations = this._register(new DisposableStore());
    const register = () => {
      registrations.clear();
      const priority = configuration.getValue(MARKDOWN_EDITOR_DEFAULT_MODE) === 'source'
        ? RegisteredEditorPriority.option : RegisteredEditorPriority.default;
      for (const glob of ['*.md', '*.markdown']) {
        registrations.add(resolver.registerEditor(
          glob,
          { id: MarkdownEditorInput.ID, label: 'Manuscript Editor', priority },
          { canSupportResource: resource => isMarkdownResource(resource) && isTextFileResource(resource, fileService) },
          ({ resource, options }) => {
            const existing = groups.groups.flatMap(group => group.editors)
              .find(editor => editor instanceof MarkdownEditorInput && isEqual(editor.resource, resource));
            return { editor: existing ?? instantiationService.createInstance(MarkdownEditorInput, resource, {}), options };
          },
        ));
      }
    };
    register();
    this._register(configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration(MARKDOWN_EDITOR_DEFAULT_MODE)) {
        register();
      }
    }));
  }
}

registerWorkbenchContribution2('workbench.contrib.markdownEditor', MarkdownEditorContribution);

const toggleSource = 'markdownEditor.toggleSource';
registerAction2(class ToggleMarkdownSource extends Action2 {
  constructor() {
    super({
      id: toggleSource,
      title: 'Toggle Source Mode',
      category: 'Markdown',
      f1: true,
      precondition: ContextKeyExpr.has(MarkdownEditorModeContext.key),
      keybinding: {
        primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyM,
        weight: KeybindingWeight.WorkbenchContrib,
      },
    });
  }

  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const target = resolveCommandsContext(accessor, context);
    const editor = target?.editor;
    if (!target || !(editor instanceof FileEditorInput) || !getMarkdownEditorMode(editor) || target.group.activeEditor !== editor) {
      return;
    }
    const { group } = target;
    const groups = accessor.get(IEditorGroupsService);
    const resolver = accessor.get(IEditorResolverService);
    const resolved = await resolver.resolveEditor({
      resource: editor.resource,
      options: { override: editor instanceof MarkdownEditorInput ? DEFAULT_EDITOR_ID : MarkdownEditorInput.ID },
    }, group);
    if (group.activeEditor !== editor || editor.isDisposed()) {
      if (!groups.groups.some(other => other.contains(resolved.editor))) {
        resolved.editor.dispose();
      }
      return;
    }
    const pane = group.activeEditorPane;
    const selection = pane instanceof MarkdownEditorPane ? pane.getSourceSelection()
      : pane instanceof TextFileEditor ? pane.getControl()?.getSelection() ?? undefined : undefined;
    if (pane instanceof MarkdownEditorPane) {
      pane.resetSourceHistory();
    }
    await group.replaceEditors([{
      editor,
      replacement: resolved.editor,
      inheritViewState: false,
      options: { preserveFocus: false, selection },
    }]);
    if (group.activeEditor === resolved.editor && group.activeEditorPane instanceof MarkdownEditorPane) {
      group.activeEditorPane.resetHistory();
    }
  }
});

for (const [mode, title, icon] of [
  ['wysiwyg', 'Switch to Markdown Source', 'code'],
  ['source', 'Switch to WYSIWYG', 'edit'],
] as const) {
  MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
    command: { id: toggleSource, title, icon: { id: icon } },
    when: MarkdownEditorModeContext.isEqualTo(mode),
    group: 'navigation',
  });
}
