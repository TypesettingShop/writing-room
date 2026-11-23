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
function setWorkQuery(url: URL, id?: string): void {
  const pairs = url.search ? url.search.slice(1).split('&').filter(pair => !new URLSearchParams('?' + pair).has('work')) : [];
  if (id) {
    pairs.push('work=' + id);
  }
  url.search = pairs.length ? '?' + pairs.join('&') : '';
}

function workUrl(id?: string): URL {
  const url = new URL(window.location.href);
  setWorkQuery(url, id);
  if (!id) {
    url.hash = '#works';
  } else if (url.hash === '#works') {
    url.hash = '';
  }
  return url;
}

function sharesChanges(editor: EditorInput, other: EditorInput): boolean {
  return editor === other || editor.closeHandler?.sharesDirtyState?.(other) === true
    || other.closeHandler?.sharesDirtyState?.(editor) === true;
}

function needsConfirmation(editor: EditorInput): boolean {
  return editor.isDirty() || editor.closeHandler?.showConfirm() === true;
}

function liveEditor(editors: readonly IEditorIdentifier[]): IEditorIdentifier | undefined {
  return editors.find(({ editor }) => !editor.isDisposed());
}

/** Collect answers for every dirty model before acting on any of them. */
async function prepareClose(groups: IEditorGroupsService): Promise<{
  dirty: ReadonlySet<EditorInput>;
  discard: readonly IEditorIdentifier[][];
} | undefined> {
  const dirty = new Set<EditorInput>();
  const asking: IEditorIdentifier[][] = [];
  for (const group of groups.groups) {
    for (const editor of group.editors.filter(needsConfirmation)) {
      if (!editor.closeHandler) {
        throw new Error(`Save or revert '${editor.getName()}' before you switch Works.`);
      }
      dirty.add(editor);
      const related = asking.find(([first]) => sharesChanges(editor, first.editor));
      const entry = { groupId: group.id, editor };
      if (related) {
        related.push(entry);
      } else {
        asking.push([entry]);
      }
    }
  }
  const save: IEditorIdentifier[][] = [];
  const discard: IEditorIdentifier[][] = [];
  for (const editors of asking) {
    // If a tab disappeared during an earlier question, any remaining tab can speak for the model.
    const entry = liveEditor(editors);
    if (entry) {
      switch (await entry.editor.closeHandler!.confirm([entry])) {
        case ConfirmResult.SAVE: save.push(editors); break;
        case ConfirmResult.DONT_SAVE: discard.push(editors); break;
        default: return undefined;
      }
    }
  }
  for (const editors of save) {
    const entry = liveEditor(editors);
    if (entry) {
      const { editor, groupId } = entry;
      const saved = await editor.save(groupId, { reason: 'explicit' });
      if (!saved || (saved === editor && editor.isDirty())) {
        return undefined;
      }
      if (saved === editor) {
        // A new edit while the Work is being created must be confirmed again.
        for (const { editor } of editors) {
          dirty.delete(editor);
        }
      }
    }
  }
  return { dirty, discard };
}

function hasUnconfirmedChanges(groups: IEditorGroupsService, dirty: ReadonlySet<EditorInput>): boolean {
  return groups.groups.some(group => group.editors.some(editor => !dirty.has(editor) && needsConfirmation(editor)));
}

export class WorkService implements IWorkService {
  declare readonly _serviceBrand: undefined;
  readonly current = readWindowWork(window.location);
  private navigating = false;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  async open(id: string): Promise<void> {
    if (isManuscriptId(id) && id !== this.current?.id) {
      await this.navigate(() => workUrl(id));
    }
  }

  async createAndOpen(create: () => Promise<string | undefined>): Promise<void> {
    await this.navigate(async () => {
      const id = await create();
      return isManuscriptId(id) ? workUrl(id) : undefined;
    });
  }

  async close(): Promise<void> {
    if (this.current) {
      await this.navigate(() => workUrl());
    }
  }

  private async navigate(destination: () => URL | undefined | Promise<URL | undefined>): Promise<void> {
    if (this.navigating) {
      return;
    }
    this.navigating = true;
    try {
      const groups = this.instantiation.invokeFunction(accessor => accessor.get(IEditorGroupsService));
      const plan = await prepareClose(groups);
      if (!plan || hasUnconfirmedChanges(groups, plan.dirty)) {
        return;
      }
      const url = await destination();
      if (!url) {
        return;
      }
      if (hasUnconfirmedChanges(groups, plan.dirty)) {
        throw new Error('Save or revert new changes before you switch Works.');
      }
      // Work creation can fail. Keep the drafts until the destination exists.
      for (const editors of plan.discard) {
        const entry = liveEditor(editors);
        if (entry) {
          await entry.editor.revert(entry.groupId, { soft: true });
        }
      }
      if (hasUnconfirmedChanges(groups, plan.dirty)) {
        return;
      }
      for (const group of [...groups.groups]) {
        if (groups.getGroup(group.id) === group) {
          await group.closeAllEditors(plan.dirty);
          if (!group.isEmpty) {
            return;
          }
        }
      }
      if (groups.groups.every(group => group.isEmpty)) {
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
      setWorkQuery(url);
      window.history.replaceState(window.history.state, '', url);
    }
  }
}
