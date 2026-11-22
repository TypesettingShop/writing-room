import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorGroupsService, type IEditorGroup, type IEditorOpenOptions } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { manuscriptDocumentUri } from '../../../services/manuscript/browser/manuscriptFileSystemProvider.js';
import { documentsUnder, hasDocumentsUnder } from '../common/manuscriptTree.js';
import { IManuscriptViewState, type ManuscriptViewState } from './manuscriptViewState.js';

export const IManuscriptOpener = createDecorator<ManuscriptOpener>('manuscriptOpener');
const maxDocuments = 50;

interface OpenDocumentsOptions {
  readonly group?: IEditorGroup;
  readonly preserveFocus?: boolean;
}

export class ManuscriptOpener {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IManuscriptViewState private readonly state: ManuscriptViewState,
    @IEditorService private readonly editors: IEditorService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @INotificationService private readonly notifications: INotificationService,
  ) {}

  isForWork(workId: string): boolean {
    return workId === this.state.workId;
  }

  hasDocuments(nodeIds: readonly string[]): boolean {
    const index = this.state.index;
    return index !== undefined && nodeIds.some(id => hasDocumentsUnder(id, index));
  }

  async openDocuments(nodeIds: readonly string[], options: OpenDocumentsOptions = {}): Promise<void> {
    const { workId, index } = this.state;
    if (!workId || !index) {
      return;
    }
    const ids = new Set<string>();
    for (const id of nodeIds) {
      for (const document of documentsUnder(id, index)) {
        ids.add(document);
      }
    }
    const ordered = nodeIds.length > 1 ? documentsUnder(null, index).filter(id => ids.has(id)) : [...ids];
    const documents = ordered.slice(0, maxDocuments);
    let opened = 0;
    const defaultGroup = options.group ?? this.groups.activeGroup;
    try {
      for (const [position, id] of documents.entries()) {
        const resource = manuscriptDocumentUri(workId, id);
        const existing = this.editors.findEditors(resource, options.group)[0];
        const group = existing ? this.groups.getGroup(existing.groupId) ?? defaultGroup : defaultGroup;
        const openOptions: IEditorOpenOptions = {
          preserveFocus: options.preserveFocus || position > 0,
          inactive: position > 0,
          index: existing ? undefined : group.count,
        };
        await this.editors.openEditor({ resource, options: openOptions }, group);
        opened++;
      }
    } catch (error) {
      this.notifications.error(error instanceof Error ? error.message : 'Could not open the manuscript document.');
    }
    if (ids.size > maxDocuments) {
      this.notifications.info(`Opened ${opened} of ${ids.size} documents.`);
    }
  }
}

registerSingleton(IManuscriptOpener, ManuscriptOpener);
