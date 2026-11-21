import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isEqual } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../../common/editor.js';
import type { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { isTextFileResource, isTextFileScheme } from '../../../../services/textfile/common/textfiles.js';
import {
  DEFAULT_EDITOR_ID, IEditorResolverService, RegisteredEditorPriority,
} from '../../../../services/editor/common/editorResolverService.js';
import { FileEditorInput } from './fileEditorInput.js';

interface ISerializedFileEditorInput {
  /** The file. */
  readonly resource: string;
  /** Whether the file had unsaved text, kept as a draft backup, when the state was written. */
  readonly backup?: true;
}

/**
 * Writes a file editor as its resource and whether it was dirty; the text itself is the file's or
 * its draft backup's, read when the editor shows.
 */
export class FileEditorInputSerializer implements IEditorSerializer {
  protected readonly inputType: typeof FileEditorInput = FileEditorInput;

  private handles(editor: EditorInput): editor is FileEditorInput {
    return editor instanceof FileEditorInput && editor.typeId === this.inputType.ID;
  }

  canSerialize(editor: EditorInput): boolean {
    return this.handles(editor);
  }

  serialize(editor: EditorInput): string | undefined {
    if (!this.handles(editor)) {
      return undefined;
    }
    const value: ISerializedFileEditorInput = editor.isDirty()
      ? { resource: editor.resource.toString(), backup: true }
      : { resource: editor.resource.toString() };
    return JSON.stringify(value);
  }

  deserialize(instantiationService: IInstantiationService, serialized: string): EditorInput | undefined {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const { resource, backup } = value as Partial<Record<keyof ISerializedFileEditorInput, unknown>>;
    if (typeof resource !== 'string' || (backup !== undefined && backup !== true)) {
      return undefined;
    }
    let uri: URI;
    try {
      uri = URI.parse(resource, true);
    } catch {
      return undefined;
    }
    // A saved state may name anything; only what opens as a text file comes back.
    if (!isTextFileScheme(uri.scheme)) {
      return undefined;
    }
    return instantiationService.createInstance(this.inputType, uri, { restoredDirty: backup === true });
  }
}

/**
 * Opens files by resource: the text editor is the default editor of every resource a file system
 * provider serves. An editor of the file that is open already is reused, as its input holds the
 * model reference.
 */
export class FileEditorResolverContribution extends Disposable {
  static readonly ID = 'workbench.contrib.fileEditorResolver';

  constructor(
    @IEditorResolverService resolver: IEditorResolverService,
    @IFileService fileService: IFileService,
    @IEditorGroupsService groups: IEditorGroupsService,
    @IInstantiationService instantiationService: IInstantiationService,
  ) {
    super();
    this._register(resolver.registerEditor(
      '*',
      { id: DEFAULT_EDITOR_ID, label: 'Text Editor', priority: RegisteredEditorPriority.builtin },
      { canSupportResource: resource => isTextFileResource(resource, fileService) },
      ({ resource, options }) => {
        const open = groups.groups.flatMap(group => group.editors)
          .find((editor): editor is FileEditorInput => editor instanceof FileEditorInput && editor.typeId === FileEditorInput.ID && isEqual(editor.resource, resource));
        return { editor: open ?? instantiationService.createInstance(FileEditorInput, resource, {}), options };
      },
    ));
  }
}
