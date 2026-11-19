import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../editor/browser/services/codeEditorService.js';
import { commandTitle, isIMenuItem, MenuId, MenuRegistry } from '../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../../platform/contextkey/common/contextkey.js';

interface EditorMenuAction {
  readonly command: string;
  readonly label: string;
  readonly group: string;
  readonly order?: number;
  readonly conditions: readonly ContextKeyExpression[];
}

function flatten(
  menu: MenuId, visited: Set<MenuId>, dependencies: Set<MenuId>, prefix = '', inherited: readonly ContextKeyExpression[] = [], group?: string,
): EditorMenuAction[] {
  if (visited.has(menu)) {
    return [];
  }
  const lineage = new Set(visited).add(menu);
  dependencies.add(menu);
  const result: EditorMenuAction[] = [];
  for (const item of MenuRegistry.getMenuItems(menu)) {
    const conditions = item.when ? [...inherited, item.when] : inherited;
    const menuGroup = group ?? item.group ?? 'extension';
    if (isIMenuItem(item)) {
      result.push({
        command: item.command.id,
        label: prefix + commandTitle(item.command.title),
        group: menuGroup,
        order: item.order,
        conditions: item.command.precondition ? [...conditions, item.command.precondition] : conditions,
      });
    } else {
      result.push(...flatten(item.submenu, lineage, dependencies, prefix + commandTitle(item.title) + ': ', conditions, menuGroup));
    }
  }
  return result;
}

let nextMenuAction = 0;

export class MainThreadEditorContextMenu extends Disposable {
  private readonly editors = new Map<ICodeEditor, DisposableStore>();

  constructor(
    @ICodeEditorService controls: ICodeEditorService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @ICommandService private readonly commands: ICommandService,
  ) {
    super();
    this._register(controls.onCodeEditorAdd(editor => this.attach(editor)));
    this._register(controls.onCodeEditorRemove(editor => {
      this.editors.get(editor)?.dispose();
      this.editors.delete(editor);
    }));
    for (const editor of controls.listCodeEditors()) {
      this.attach(editor);
    }
  }

  private attach(editor: ICodeEditor): void {
    const lifetime = new DisposableStore();
    const registrations = lifetime.add(new DisposableStore());
    const context = this.contextKeys.getScopedContextKeyService(editor.getContainerDomNode());
    const dependencies = new Set<MenuId>();
    const read = () => {
      registrations.clear();
      dependencies.clear();
      for (const action of flatten(MenuId.EditorContext, new Set(), dependencies)) {
        const id = 'wrEditorMenuAction' + ++nextMenuAction;
        const visible = editor.createContextKey<boolean | undefined>(id, undefined);
        const keys = new Set(action.conditions.flatMap(condition => condition.keys()));
        // Monaco and the workbench use different context services. Mirror the result for this
        // editor so a workbench key with a Monaco counterpart cannot overwrite Monaco's own value.
        const refresh = () => visible.set(action.conditions.every(condition => context.contextMatchesRules(condition)));
        refresh();
        registrations.add(context.onDidChangeContext(event => {
          if (event.affectsSome(keys)) {
            refresh();
          }
        }));
        registrations.add(editor.onDidChangeModel(refresh));
        registrations.add(editor.addAction({
          id,
          label: action.label,
          contextMenuGroupId: action.group,
          contextMenuOrder: action.order,
          precondition: id,
          run: control => {
            const model = control.getModel();
            if (model && action.conditions.every(condition => context.contextMatchesRules(condition))) {
              return this.commands.executeCommand(action.command, URI.parse(model.uri.toString(), true));
            }
          },
        }));
        registrations.add({ dispose: () => visible.reset() });
      }
    };
    lifetime.add(MenuRegistry.onDidChangeMenu(event => {
      if ([...dependencies].some(menu => event.has(menu))) {
        read();
      }
    }));
    this.editors.set(editor, lifetime);
    read();
  }

  override dispose(): void {
    for (const lifetime of this.editors.values()) {
      lifetime.dispose();
    }
    this.editors.clear();
    super.dispose();
  }
}
