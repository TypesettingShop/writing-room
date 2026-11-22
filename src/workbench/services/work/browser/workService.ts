import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IEditorIdentifier } from '../../../common/editor.js';
import { ConfirmResult } from '../../../common/editor/editorInput.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroupsService } from '../../editor/common/editorGroupsService.js';
import { IManuscriptService } from '../../manuscript/common/manuscriptService.js';
import { IWorkService, readWindowWork } from '../common/work.js';

// Drop only the work pairs. Re-serializing searchParams would re-encode the other pairs.
function otherQueryPairs(url: URL): string[] {
  return url.search ? url.search.slice(1).split('&').filter(pair => !new URLSearchParams('?' + pair).has('work')) : [];
}

function sharesChanges(editor: EditorInput, other: EditorInput): boolean {
  return editor.matches(other) || editor.closeHandler?.sharesDirtyState?.(other) === true
    || other.closeHandler?.sharesDirtyState?.(editor) === true;
}

/** Confirm the whole window before closing any of its tabs, including tabs in inactive groups. */
async function closeEditors(groups: IEditorGroupsService): Promise<boolean> {
  const dirty = new Set<EditorInput>();
  const asking: IEditorIdentifier[] = [];
  for (const group of groups.groups) {
    for (const editor of group.editors) {
      if (editor.isDirty() || editor.closeHandler?.showConfirm()) {
        if (!editor.closeHandler) {
          // Nothing can ask about these changes, and closing the tab would drop them. Say why nothing happens.
          throw new Error(`Save or revert '${editor.getName()}' before you switch Works.`);
        }
        dirty.add(editor);
        if (!asking.some(({ editor: other }) => sharesChanges(editor, other))) {
          asking.push({ groupId: group.id, editor });
        }
      }
    }
  }
  const save: IEditorIdentifier[] = [];
  const discard: IEditorIdentifier[] = [];
  for (const entry of asking) {
    // A tab can close while an earlier question is open. Do not ask about changes that already left.
    if (entry.editor.isDisposed()) {
      continue;
    }
    switch (await entry.editor.closeHandler!.confirm([entry])) {
      case ConfirmResult.SAVE: save.push(entry); break;
      case ConfirmResult.DONT_SAVE: discard.push(entry); break;
      default: return false;
    }
  }
  for (const { groupId, editor } of save) {
    if (!editor.isDisposed() && !await editor.save(groupId, { reason: 'explicit' })) {
      return false;
    }
  }
  for (const { groupId, editor } of discard) {
    if (!editor.isDisposed()) {
      await editor.revert(groupId, { soft: true });
    }
  }
  // An editor can open while a save is pending. Only reuse confirmation for inputs we asked about.
  if (groups.groups.some(group => group.editors.some(editor => !dirty.has(editor)
    && (editor.isDirty() || editor.closeHandler?.showConfirm())))) {
    return false;
  }
  for (const group of [...groups.groups]) {
    if (groups.getGroup(group.id) === group) {
      await group.closeAllEditors(dirty);
      if (!group.isEmpty) {
        return false;
      }
    }
  }
  return groups.groups.every(group => group.isEmpty);
}

export class WorkService implements IWorkService {
  declare readonly _serviceBrand: undefined;
  readonly current = readWindowWork(window.location);
  private navigating = false;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  async open(id: string): Promise<void> {
    if (isManuscriptId(id) && id !== this.current?.id) {
      await this.navigate(id);
    }
  }

  async close(): Promise<void> {
    if (this.current) {
      await this.navigate(undefined);
    }
  }

  private async navigate(id: string | undefined): Promise<void> {
    if (this.navigating) {
      return;
    }
    this.navigating = true;
    try {
      const groups = this.instantiation.invokeFunction(accessor => accessor.get(IEditorGroupsService));
      if (await closeEditors(groups)) {
        const url = new URL(window.location.href);
        const pairs = otherQueryPairs(url);
        if (id) {
          pairs.push('work=' + id);
          if (url.hash === '#works') {
            url.hash = '';
          }
        } else {
          url.hash = '#works';
        }
        url.search = pairs.length ? '?' + pairs.join('&') : '';
        window.location.assign(url);
      }
    } catch (error) {
      this.instantiation.invokeFunction(accessor => accessor.get(INotificationService))
        .error(error instanceof Error ? error.message : String(error));
    } finally {
      this.navigating = false;
    }
  }
}

/** Report invalid Work links and resolve the active Work title after the workbench mounts. */
export class WorkLinkContribution {
  constructor(
    @IWorkService work: IWorkService,
    @INotificationService notifications: INotificationService,
    @IManuscriptService manuscript: IManuscriptService,
  ) {
    const url = new URL(window.location.href);
    if (work.current) {
      const id = work.current.id;
      // A valid URL may name a Work that does not exist or belongs to another user.
      void manuscript.store.listWorks().then(works => {
        const current = works.find(entry => entry.id === id);
        if (current) {
          window.document.title = current.title;
        }
      }).catch(() => { /* Keep the default window title when Works cannot be loaded. */ });
    } else if (url.searchParams.has('work')) {
      notifications.warn('The Work link is not valid.');
      const pairs = otherQueryPairs(url);
      url.search = pairs.length ? '?' + pairs.join('&') : '';
      window.history.replaceState(window.history.state, '', url);
    }
  }
}
