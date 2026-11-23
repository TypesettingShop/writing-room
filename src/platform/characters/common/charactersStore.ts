import type { NodeDestination, TreeChange } from '../../manuscript/common/manuscriptStore.js';
import type { CharacterTemplate, CharacterValues } from './characterFields.js';
import type { CharacterNode, CharacterNodeKind, CharacterTree, CharacterType } from './characters.js';

export interface CreateCharacterNode extends NodeDestination {
  kind: CharacterNodeKind;
  title: string;
  type?: CharacterType;
}

export interface UpdateCharacterNode {
  title?: string;
  type?: CharacterType;
  values?: CharacterValues;
}

export interface CharacterNodeChange extends TreeChange {
  node: CharacterNode;
}

export interface CharacterNodeDeletion extends TreeChange {
  deletedCharacterIds: string[];
}

export interface CharacterTemplateSnapshot {
  revision: number;
  fields: CharacterTemplate;
}

export interface CharactersStore {
  getTemplate(workId: string): Promise<CharacterTemplateSnapshot>;
  putTemplate(workId: string, fields: CharacterTemplate, expectedRevision: number): Promise<CharacterTemplateSnapshot>;
  getTree(workId: string): Promise<CharacterTree>;
  createNode(workId: string, input: CreateCharacterNode, expectedRevision: number): Promise<CharacterNodeChange>;
  updateNode(workId: string, nodeId: string, input: UpdateCharacterNode, expectedRevision: number): Promise<CharacterNodeChange>;
  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange>;
  deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<CharacterNodeDeletion>;
}

export interface CharactersRepository {
  forUser(userId: string): CharactersStore;
}
