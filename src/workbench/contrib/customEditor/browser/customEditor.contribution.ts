import '../common/extensionPoint.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { normalizeFileResource } from '../../../../platform/files/common/fileResource.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { forbiddenResourcePath, reservedSchemes } from '../../../api/browser/mainThreadDocuments.js';
import { extensionEditorGroup } from '../../../api/browser/mainThreadEditors.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommands.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { ConfirmResult } from '../../../common/editor/editorInput.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import {
  DEFAULT_EDITOR_ID, EDITOR_ASSOCIATIONS_SETTING, IEditorResolverService,
} from '../../../services/editor/common/editorResolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { WebviewEditor } from '../../webviewPanel/browser/webviewEditor.js';
import { CustomEditorInput } from './customEditorInput.js';
import { CustomEditorInputSerializer } from './customEditorInputSerializer.js';
import { ICustomEditorService } from './customEditorService.js';
import './customEditors.js';

export const REOPEN_WITH_COMMAND_ID = 'workbench.action.reopenWithEditor';
export const OPEN_WITH_COMMAND_ID = 'vscode.openWith';

// Custom editors show in the Webview pane, the same pane (and pane instance) as Webview panels.
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)?.registerEditorPane(
  EditorPaneDescriptor.create(WebviewEditor, WebviewEditor.id, 'Webview'), [CustomEditorInput.ID],
);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)?.registerEditorSerializer(
  CustomEditorInput.ID, CustomEditorInputSerializer,
);

configurationRegistry.registerConfiguration({
  id: 'workbench',
  title: 'Workbench',
  properties: {
    [EDITOR_ASSOCIATIONS_SETTING]: {
      type: 'object',
      additionalProperties: { type: 'string' },
      default: {},
      markdownDescription: 'Configure [glob patterns](https://aka.ms/vscode-glob-patterns) to editors (for example `"*.md": "vscode.markdown.preview.editor"`). A pattern with a `/` is matched against the whole path. Use `default` for the text editor.',
    },
  },
});

/** Makes the custom editor service at startup, so the contributed editors are in the resolver before anything opens. */
class CustomEditorStartup {
  constructor(@ICustomEditorService _customEditors: ICustomEditorService) {}
}

registerWorkbenchContribution2('workbench.contrib.customEditors', CustomEditorStartup);

/** The id the resolver knows `editor` by: a custom editor's `viewType`, or the text editor's. */
function registeredId(editor: EditorInput, candidates: readonly string[]): string {
  if (editor instanceof CustomEditorInput) {
    return editor.viewType;
  }
  return candidates.includes(editor.typeId) ? editor.typeId : DEFAULT_EDITOR_ID;
}

interface EditorPick extends IQuickPickItem {
  readonly id: string;
}

/**
 * A custom document goes with its last editor, and its unsaved changes with it. Before another editor
 * takes its place, ask as closing it would; `false` keeps the editor.
 */
async function confirmReplace(groups: IEditorGroupsService, group: IEditorGroup, editor: EditorInput): Promise<boolean> {
  if (!(editor instanceof CustomEditorInput) || editor.kind !== 'custom' || !editor.closeHandler.showConfirm()
    || groups.groups.some(other => other !== group && other.contains(editor))) {
    return true;
  }
  switch (await editor.closeHandler.confirm([{ groupId: group.id, editor }])) {
    case ConfirmResult.SAVE:
      return await editor.save(group.id, { reason: 'explicit' }) !== undefined;
    case ConfirmResult.DONT_SAVE:
      await editor.revert(group.id, { soft: true });
      return true;
    default:
      return false;
  }
}

/**
 * Disposes a custom editor made for a replacement that did not happen (it holds a Webview), unless a
 * group shows it. Text inputs are left alone: an untitled one takes its text along when disposed.
 */
function disposeUnplaced(groups: IEditorGroupsService, editor: EditorInput): void {
  if (editor instanceof CustomEditorInput && !editor.isDisposed() && !groups.groups.some(group => group.contains(editor))) {
    editor.dispose();
  }
}

registerAction2(class ReopenWithEditorAction extends Action2 {
  constructor() {
    super({ id: REOPEN_WITH_COMMAND_ID, title: 'Reopen Editor With...', category: 'View', f1: true });
  }

  /**
   * Lists the editors that can open the active (or the clicked) editor's resource, the current one
   * marked, and puts the chosen one in its place: same group, same position, same model.
   */
  override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
    const resolver = accessor.get(IEditorResolverService);
    const quickInput = accessor.get(IQuickInputService);
    const groups = accessor.get(IEditorGroupsService);
    const target = resolveCommandsContext(accessor, context);
    const editor = target?.editor;
    const resource = editor?.resource;
    if (!target || !editor || !resource) {
      return;
    }
    const editors = resolver.getEditors(resource);
    const current = registeredId(editor, editors.map(info => info.id));
    const picked = await quickInput.pick<EditorPick>(editors.map(info => ({
      id: info.id, label: info.label, detail: info.detail,
      description: info.id === current ? 'Active' : undefined,
    })), { placeHolder: `Select editor for '${editor.getName()}'` });
    if (!picked || picked.id === current || editor.isDisposed() || !target.group.contains(editor)) {
      return;
    }
    const { group } = target;
    if (!await confirmReplace(groups, group, editor) || editor.isDisposed() || !group.contains(editor)) {
      return;
    }
    const resolved = await resolver.resolveEditor({ resource, options: { override: picked.id } }, group);
    if (!editor.isDisposed() && group.contains(editor)) {
      await group.replaceEditors([{ editor, replacement: resolved.editor, options: { preserveFocus: false } }]);
    } else {
      disposeUnplaced(groups, resolved.editor);
    }
  }
});

/** The resource as `vscode.open` takes it: a workspace file, untitled text, or a scheme an extension serves. */
function openableResource(accessor: ServicesAccessor, value: unknown): URI {
  if (!URI.isUri(value) || value.hasEncodedPathSeparator || forbiddenResourcePath.test(value.path)) {
    throw new TypeError('Expected a permitted editor Uri.');
  }
  if (value.scheme === Schemas.vscodeVfs && accessor.get(IWorkspaceContextService).getWorkspaceFolder(value)) {
    return normalizeFileResource(value);
  }
  if (value.scheme === Schemas.untitled || (!reservedSchemes.has(value.scheme) && accessor.get(IFileService).hasProvider(value))) {
    return value;
  }
  throw new Error(`Resource '${value}' cannot be opened with ${OPEN_WITH_COMMAND_ID}.`);
}

/**
 * `vscode.openWith(resource, viewType, columnOrOptions?)`: opens `resource` in the editor `viewType`
 * names, `default` being the text editor. The third argument is a view column or
 * `{ viewColumn?, preserveFocus? }`.
 */
CommandsRegistry.registerCommand(OPEN_WITH_COMMAND_ID, async (accessor, ...args: unknown[]) => {
  const [uri, viewType, columnOrOptions] = args;
  const resource = openableResource(accessor, uri);
  if (typeof viewType !== 'string' || !viewType) {
    throw new TypeError('Expected a viewType string.');
  }
  const settings = columnOrOptions && typeof columnOrOptions === 'object' ? columnOrOptions as Record<string, unknown> : {};
  const column = typeof columnOrOptions === 'number' ? columnOrOptions
    : typeof settings.viewColumn === 'number' ? settings.viewColumn : undefined;
  await accessor.get(IEditorService).openEditor({
    resource,
    options: { override: viewType, preserveFocus: settings.preserveFocus === true },
  }, extensionEditorGroup(accessor.get(IEditorGroupsService), column));
});
