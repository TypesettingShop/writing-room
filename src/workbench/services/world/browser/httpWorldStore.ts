import { isManuscriptId, ManuscriptStoreError } from '../../../../platform/manuscript/common/manuscript.js';
import type { NodeDestination, TreeChange } from '../../../../platform/manuscript/common/manuscriptStore.js';
import type { Calendar } from '../../../../platform/world/common/calendar.js';
import { WorldStoreError, type WorldTree } from '../../../../platform/world/common/world.js';
import type {
  CreateWorldNode, UpdateWorldNode, WorldCalendarSnapshot, WorldNodeChange, WorldNodeDeletion, WorldStore,
} from '../../../../platform/world/common/worldStore.js';
import { WorkApiClient, type ManuscriptFetch } from '../../manuscript/browser/httpManuscriptStore.js';
import type { ManuscriptStatus } from '../../manuscript/browser/windowManuscriptService.js';

function idSegment(id: string): string {
  if (!isManuscriptId(id)) {
    throw new WorldStoreError('not_found');
  }
  return '/' + id;
}

function workPath(workId: string): string {
  return '/api/works' + idSegment(workId) + '/world';
}

export class HttpWorldStore implements WorldStore {
  private readonly client: WorkApiClient;

  constructor(status: ManuscriptStatus, fetcher?: ManuscriptFetch) {
    this.client = new WorkApiClient(status, fetcher, (code, currentRevision) => code === 'precondition_failed'
      ? new ManuscriptStoreError(code, currentRevision) : new WorldStoreError(code, currentRevision));
  }

  async getTree(workId: string): Promise<WorldTree> {
    return this.client.json(workPath(workId) + '/tree');
  }

  async applyPreset(workId: string, presetId: string, expectedRevision: number): Promise<WorldTree> {
    return this.client.json(workPath(workId) + '/preset', 'POST', { presetId, expectedRevision });
  }

  async createNode(workId: string, input: CreateWorldNode, expectedRevision: number): Promise<WorldNodeChange> {
    return this.client.json(workPath(workId) + '/nodes', 'POST', { ...input, expectedRevision });
  }

  async updateNode(workId: string, nodeId: string, input: UpdateWorldNode, expectedRevision: number): Promise<WorldNodeChange> {
    return this.client.json(workPath(workId) + '/nodes' + idSegment(nodeId), 'PATCH', { ...input, expectedRevision });
  }

  async moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange> {
    return this.client.json(workPath(workId) + '/nodes/move', 'POST', { ...destination, nodeIds, expectedRevision });
  }

  async deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<WorldNodeDeletion> {
    const path = workPath(workId) + '/nodes' + idSegment(nodeId);
    const query = new URLSearchParams({ expectedRevision: String(expectedRevision) });
    return this.client.json(path + '?' + query, 'DELETE');
  }

  async getCalendar(workId: string): Promise<WorldCalendarSnapshot> {
    return this.client.json(workPath(workId) + '/calendar');
  }

  async putCalendar(workId: string, calendar: Calendar, expectedRevision: number): Promise<WorldCalendarSnapshot> {
    return this.client.json(workPath(workId) + '/calendar', 'PUT', { calendar, expectedRevision });
  }
}
