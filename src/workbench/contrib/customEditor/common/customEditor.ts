import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { globMatchesResource } from '../../../services/editor/common/editorResolverService.js';

/** The `viewType` of the custom editor in front, while one is; `undefined` otherwise (VS Code's key). */
export const CONTEXT_ACTIVE_CUSTOM_EDITOR_ID = new RawContextKey<string | undefined>('activeCustomEditorId', undefined,
  'The viewType of the active custom editor.');

/** `option` editors open only when asked for; `builtin` contributions are taken as `default`. */
export type CustomEditorPriority = 'default' | 'option';

/** One entry of an extension's `contributes.customEditors`, checked. */
export interface CustomEditorInfo {
  /** The editor id: what `vscode.openWith` and `workbench.editorAssociations` name. */
  readonly id: string;
  readonly displayName: string;
  /** The contributing extension's identifier, as the extension service knows it. */
  readonly extensionId: string;
  /** The extension's display name, which "Reopen Editor With..." shows beside the editor. */
  readonly providerDisplayName: string;
  /** File name patterns; one with a `/` is matched against the whole path. */
  readonly filenamePatterns: readonly string[];
  readonly priority: CustomEditorPriority;
}

export function customEditorMatches(info: CustomEditorInfo, resource: URI): boolean {
  return info.filenamePatterns.some(pattern => globMatchesResource(pattern, resource));
}

/**
 * The custom editors the installed extensions contribute. The extension point replaces the whole
 * list each time contributions are applied, so a reader never sees the list half rebuilt.
 */
export class CustomEditorContributions {
  private readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;
  private current: readonly CustomEditorInfo[] = [];

  get editors(): readonly CustomEditorInfo[] {
    return this.current;
  }

  get(viewType: string): CustomEditorInfo | undefined {
    return this.current.find(info => info.id === viewType);
  }

  /** Puts `editors` in place until the result is disposed, unless another `set` came after. */
  set(editors: readonly CustomEditorInfo[]): IDisposable {
    this.current = editors;
    this.changed.fire();
    return toDisposable(() => {
      if (this.current === editors) {
        this.current = [];
        this.changed.fire();
      }
    });
  }
}

export const customEditorContributions = new CustomEditorContributions();
