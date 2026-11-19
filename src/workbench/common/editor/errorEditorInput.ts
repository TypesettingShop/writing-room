import { isEqual } from '../../../base/common/resources.js';
import { basename } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import { EditorInput } from './editorInput.js';

/**
 * Stands for a resource that could not be opened, so the user sees why in its tab instead of an
 * empty pane. It is not restored after a reload: nothing serializes it.
 */
export class ErrorEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.errorEditorInput';

  constructor(private readonly target: URI, readonly message: string) {
    super();
  }

  override get typeId(): string {
    return ErrorEditorInput.ID;
  }

  override get resource(): URI {
    return this.target;
  }

  override getName(): string {
    return basename(this.target) || this.target.toString();
  }

  override getDescription(): string {
    return this.target.toString();
  }

  override isReadonly(): boolean {
    return true;
  }

  override matches(other: EditorInput): boolean {
    return other === this || (other instanceof ErrorEditorInput && isEqual(other.resource, this.resource));
  }
}
