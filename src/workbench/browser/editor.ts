import { toDisposable } from '../../base/common/lifecycle.js';
import type { IDisposable } from '../../base/common/lifecycle.js';
import type { BrandedService, IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../platform/registry/common/platform.js';
import type { EditorInput } from '../common/editor/editorInput.js';
import type { EditorPane } from './parts/editor/editorPane.js';

type EditorPaneConstructor = new (...services: BrandedService[]) => EditorPane;

/** How to create one kind of editor pane. `typeId` is the pane's id. */
export class EditorPaneDescriptor {
  static create<Services extends BrandedService[]>(
    ctor: new (...services: Services) => EditorPane,
    typeId: string,
    name: string,
  ): EditorPaneDescriptor {
    return new EditorPaneDescriptor(ctor as EditorPaneConstructor, typeId, name);
  }

  private constructor(
    private readonly ctor: EditorPaneConstructor,
    readonly typeId: string,
    readonly name: string,
  ) {}

  instantiate(instantiationService: IInstantiationService): EditorPane {
    return instantiationService.createInstance(this.ctor);
  }

  describes(editorPane: EditorPane): boolean {
    return editorPane.id === this.typeId;
  }
}

export interface IEditorPaneRegistry {
  /**
   * Shows inputs whose `typeId` is in `editorTypeIds` with the pane `descriptor` creates. VS Code
   * matches inputs by their constructor instead.
   */
  registerEditorPane(descriptor: EditorPaneDescriptor, editorTypeIds: readonly string[]): IDisposable;
  getEditorPane(editor: EditorInput): EditorPaneDescriptor | undefined;
  getEditorPaneByType(typeId: string): EditorPaneDescriptor | undefined;
}

export const EditorExtensions = {
  EditorPane: 'workbench.contributions.editors',
} as const;

class EditorPaneRegistry implements IEditorPaneRegistry {
  private readonly panes = new Map<string, EditorPaneDescriptor>();

  registerEditorPane(descriptor: EditorPaneDescriptor, editorTypeIds: readonly string[]): IDisposable {
    const taken = editorTypeIds.filter(typeId => this.panes.has(typeId));
    if (taken.length) {
      throw new Error(`Editor inputs ${taken.join(', ')} already have an editor pane.`);
    }
    for (const typeId of editorTypeIds) {
      this.panes.set(typeId, descriptor);
    }
    return toDisposable(() => {
      for (const typeId of editorTypeIds) {
        if (this.panes.get(typeId) === descriptor) {
          this.panes.delete(typeId);
        }
      }
    });
  }

  getEditorPane(editor: EditorInput): EditorPaneDescriptor | undefined {
    return this.panes.get(editor.typeId);
  }

  getEditorPaneByType(typeId: string): EditorPaneDescriptor | undefined {
    return [...this.panes.values()].find(descriptor => descriptor.typeId === typeId);
  }
}

Registry.add(EditorExtensions.EditorPane, new EditorPaneRegistry());
