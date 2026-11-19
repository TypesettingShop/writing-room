import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import { loadMonaco } from '../../../editor/browser/monaco.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../editor/browser/services/codeEditorService.js';
import type { IPosition, IRange } from '../../../editor/common/model.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { IFileService } from '../../../platform/files/common/files.js';
import { normalizeFileResource } from '../../../platform/files/common/fileResource.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { forbiddenResourcePath, reservedSchemes } from './mainThreadDocuments.js';
import { extensionEditorGroup, paneControl } from './mainThreadEditors.js';

interface MonacoCommands {
  readonly _actions?: ReadonlyMap<string, unknown>;
  readonly _commandService?: { executeCommand(id: string, ...args: unknown[]): Promise<unknown> };
}

function position(value: unknown): IPosition {
  if (value && typeof value === 'object' && 'line' in value && 'character' in value
    && typeof value.line === 'number' && typeof value.character === 'number'
    && Number.isSafeInteger(value.line) && value.line >= 0 && Number.isSafeInteger(value.character) && value.character >= 0) {
    return { lineNumber: value.line + 1, column: value.character + 1 };
  }
  throw new TypeError('Expected a Position.');
}

function range(value: unknown): IRange {
  if (!value || typeof value !== 'object' || !('start' in value) || !('end' in value)) {
    throw new TypeError('Expected a Range.');
  }
  const start = position(value.start);
  const end = position(value.end);
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
}

const actionPrefix = 'editor.action.';
const rename = 'editor.action.rename';
const references = 'editor.action.showReferences';

export class DocumentApiCommands extends Disposable {
  private readonly registrations = this._register(new DisposableStore());
  private readonly actions = new Set<string>();

  constructor(
    @ICodeEditorService private readonly controls: ICodeEditorService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @IEditorService private readonly editors: IEditorService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
    @IFileService private readonly files: IFileService,
  ) {
    super();
    this.register('vscode.open', (uri, options) => this.open(uri, options));
    this.register('revealLine', args => this.revealLine(args));
    this.register(rename, args => this.rename(args));
    this.register(references, (uri, source, locations) => this.references(uri, source, locations));
    this._register(controls.onCodeEditorAdd(control => this.registerActions(control)));
    for (const control of controls.listCodeEditors()) {
      this.registerActions(control);
    }
  }

  private register(id: string, command: (...args: unknown[]) => unknown): void {
    if (!CommandsRegistry.getCommand(id)) {
      this.registrations.add(CommandsRegistry.registerCommand(id, (_accessor, ...args: unknown[]) => command(...args)));
    }
  }

  private registerActions(control: ICodeEditor): void {
    // The public action list filters by the current preconditions, so it omits actions before a
    // model is attached. Monaco's instantiated action map contains the disabled actions too.
    const actions = (control as ICodeEditor & MonacoCommands)._actions?.keys() ?? control.getSupportedActions().map(action => action.id);
    for (const id of actions) {
      if (id.startsWith(actionPrefix) && id !== rename && id !== references && !this.actions.has(id)) {
        this.actions.add(id);
        this.register(id, (...args) => {
          const action = this.editor(id).getAction(id);
          if (!action) {
            throw new Error(`command '${id}' not found`);
          }
          return action.run(args[0]);
        });
      }
    }
  }

  private resource(value: unknown): URI {
    if (!URI.isUri(value) || value.hasEncodedPathSeparator || forbiddenResourcePath.test(value.path)) {
      throw new TypeError('Expected a permitted editor Uri.');
    }
    if (value.scheme === Schemas.vscodeVfs && this.workspace.getWorkspaceFolder(value)) {
      return normalizeFileResource(value);
    }
    if (value.scheme === Schemas.untitled || (!reservedSchemes.has(value.scheme) && this.files.hasProvider(value))) {
      return value;
    }
    throw new Error(`Resource '${value}' cannot be opened with vscode.open.`);
  }

  private async open(value: unknown, options: unknown): Promise<void> {
    const resource = this.resource(value);
    const settings = options && typeof options === 'object' ? options as Record<string, unknown> : {};
    const column = typeof options === 'number' ? options
      : typeof settings.viewColumn === 'number' ? settings.viewColumn : undefined;
    await this.editors.openEditor({
      resource,
      options: {
        preserveFocus: settings.preserveFocus === true,
        selection: settings.selection === undefined ? undefined : range(settings.selection),
      },
    }, extensionEditorGroup(this.groups, column));
  }

  private current(): ICodeEditor | undefined {
    const focused = this.controls.getFocusedCodeEditor();
    const active = focused?.getModel() ? focused : paneControl(this.editors.activeEditorPane);
    return active?.getModel() ? active : undefined;
  }

  private editor(id: string): ICodeEditor {
    const active = this.current();
    if (!active) {
      throw new Error(`command '${id}' not found`);
    }
    return active;
  }

  private revealLine(args: unknown): void {
    if (!args || typeof args !== 'object' || !('lineNumber' in args)
      || typeof args.lineNumber !== 'number' || !Number.isSafeInteger(args.lineNumber)) {
      throw new TypeError('revealLine requires an integer lineNumber.');
    }
    const editor = this.editor('revealLine');
    const line = Math.min(editor.getModel()!.getLineCount(), Math.max(1, args.lineNumber + 1));
    switch ('at' in args ? args.at : undefined) {
      case 'top': editor.revealLineNearTop(line, 1); break;
      case 'center': editor.revealLineInCenter(line, 1); break;
      case 'bottom':
        // The top of the next line clamps to the last line's top, which would leave the last line hidden.
        editor.setScrollTop(editor.getBottomForLineNumber(line) - editor.getLayoutInfo().height, 1);
        break;
      default: editor.revealLine(line, 1);
    }
  }

  private async atResource(id: string, uri: URI): Promise<ICodeEditor> {
    // With no text editor in front, the resource still opens in one.
    const active = this.current();
    const model = active?.getModel();
    if (active && model && URI.parse(model.uri.toString(), true).toString() === uri.toString()) {
      return active;
    }
    const control = paneControl(await this.editors.openEditor({ resource: uri }));
    if (!control?.getModel()) {
      throw new Error(`command '${id}' requires a text editor`);
    }
    return control;
  }

  private async rename(args: unknown): Promise<void> {
    if (!Array.isArray(args)) {
      await this.editor(rename).getAction(rename)?.run(args);
      return;
    }
    const [resource, at] = args;
    const editor = await this.atResource(rename, this.resource(resource));
    editor.setPosition(editor.getModel()!.validatePosition(position(at)));
    await editor.getAction(rename)?.run();
  }

  private async references(resource: unknown, source: unknown, locations: unknown): Promise<void> {
    const uri = this.resource(resource);
    if (!Array.isArray(locations)) {
      throw new TypeError('showReferences requires locations.');
    }
    const monaco = await loadMonaco();
    const referencesList = locations.map(location => ({
      uri: monaco.Uri.parse(this.resource(location.uri).toString()),
      range: range(location.range),
    }));
    const editor = await this.atResource(references, uri);
    const model = editor.getModel()!;
    const command = (editor as ICodeEditor & MonacoCommands)._commandService;
    if (!command) {
      throw new Error(`command '${references}' not found`);
    }
    editor.focus();
    await command.executeCommand(references, model.uri, model.validatePosition(position(source)), referencesList);
  }
}
