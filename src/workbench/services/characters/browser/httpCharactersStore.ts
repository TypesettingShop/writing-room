import type { CharacterTemplate } from '../../../../platform/characters/common/characterFields.js';
import { CharacterStoreError, isCharacterStoreErrorCode, type CharacterTree } from '../../../../platform/characters/common/characters.js';
import type {
  CharacterNodeChange, CharacterNodeDeletion, CharacterTemplateSnapshot, CharactersStore, CreateCharacterNode, UpdateCharacterNode,
} from '../../../../platform/characters/common/charactersStore.js';
import { isManuscriptId, ManuscriptStoreError } from '../../../../platform/manuscript/common/manuscript.js';
import type { NodeDestination, TreeChange } from '../../../../platform/manuscript/common/manuscriptStore.js';
import { WorkApiClient, type ManuscriptFetch } from '../../manuscript/browser/httpManuscriptStore.js';
import type { ManuscriptStatus } from '../../manuscript/browser/windowManuscriptService.js';

function idSegment(id: string): string {
  if (!isManuscriptId(id)) {
    throw new CharacterStoreError('not_found');
  }
  return '/' + id;
}

function workPath(workId: string): string {
  return '/api/works' + idSegment(workId) + '/characters';
}

export class HttpCharactersStore implements CharactersStore {
  private readonly client: WorkApiClient;

  constructor(status: ManuscriptStatus, fetcher?: ManuscriptFetch) {
    this.client = new WorkApiClient(status, fetcher, (code, currentRevision) =>
      isCharacterStoreErrorCode(code) ? new CharacterStoreError(code, currentRevision) : new ManuscriptStoreError(code, currentRevision));
  }

  async getTemplate(workId: string): Promise<CharacterTemplateSnapshot> {
    return this.client.json(workPath(workId) + '/template');
  }

  async putTemplate(workId: string, fields: CharacterTemplate, expectedRevision: number): Promise<CharacterTemplateSnapshot> {
    return this.client.json(workPath(workId) + '/template', 'PUT', { fields, expectedRevision });
  }

  async getTree(workId: string): Promise<CharacterTree> {
    return this.client.json(workPath(workId) + '/tree');
  }

  async createNode(workId: string, input: CreateCharacterNode, expectedRevision: number): Promise<CharacterNodeChange> {
    return this.client.json(workPath(workId) + '/nodes', 'POST', { ...input, expectedRevision });
  }

  async updateNode(workId: string, nodeId: string, input: UpdateCharacterNode, expectedRevision: number): Promise<CharacterNodeChange> {
    return this.client.json(workPath(workId) + '/nodes' + idSegment(nodeId), 'PATCH', { ...input, expectedRevision });
  }

  async moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange> {
    return this.client.json(workPath(workId) + '/nodes/move', 'POST', { ...destination, nodeIds, expectedRevision });
  }

  async deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<CharacterNodeDeletion> {
    const path = workPath(workId) + '/nodes' + idSegment(nodeId);
    return this.client.json(path + '?' + new URLSearchParams({ expectedRevision: String(expectedRevision) }), 'DELETE');
  }
}
