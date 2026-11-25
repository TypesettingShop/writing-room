import type { CharacterTemplate, CharacterValues } from '../../characters/common/characterFields.js';
import type { NodeDestination, TreeChange } from '../../manuscript/common/manuscriptStore.js';
import type { Calendar } from './calendar.js';
import type { WorldNode, WorldNodeKind, WorldTree } from './world.js';

export interface CreateWorldNode extends NodeDestination {
  kind: WorldNodeKind;
  title: string;
}

export interface UpdateWorldNode {
  title?: string;
  fields?: CharacterTemplate;
  values?: CharacterValues;
}

export interface WorldNodeChange extends TreeChange {
  node: WorldNode;
}

export interface WorldNodeDeletion extends TreeChange {
  deletedNodeIds: string[];
}

export interface WorldCalendarSnapshot {
  revision: number;
  calendar: Calendar;
}

export interface WorldStore {
  getTree(workId: string): Promise<WorldTree>;
  createNode(workId: string, input: CreateWorldNode, expectedRevision: number): Promise<WorldNodeChange>;
  updateNode(workId: string, nodeId: string, input: UpdateWorldNode, expectedRevision: number): Promise<WorldNodeChange>;
  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange>;
  deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<WorldNodeDeletion>;
  getCalendar(workId: string): Promise<WorldCalendarSnapshot>;
  putCalendar(workId: string, calendar: Calendar, expectedRevision: number): Promise<WorldCalendarSnapshot>;
}

export interface WorldRepository {
  forUser(userId: string): WorldStore;
}
