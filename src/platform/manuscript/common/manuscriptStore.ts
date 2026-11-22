import type {
  DocumentStat, ManuscriptDocument, ManuscriptMetadata, ManuscriptNode, ManuscriptNodeKind, ManuscriptTree, ManuscriptWork,
} from './manuscript.js';

export interface NodeDestination {
  parentId: string | null;
  beforeId?: string;
}

export interface CreateNode extends NodeDestination {
  kind: ManuscriptNodeKind;
  title: string;
}

export interface UpdateNode {
  title?: string;
  metadata?: ManuscriptMetadata;
}

export interface TreeChange {
  revision: number;
}

export interface NodeChange extends TreeChange {
  node: ManuscriptNode;
}

export interface NodeDeletion extends TreeChange {
  deletedDocumentIds: string[];
}

export interface ManuscriptStore {
  listWorks(): Promise<ManuscriptWork[]>;
  createWork(input: { title: string }): Promise<ManuscriptWork>;
  getWork(workId: string): Promise<ManuscriptWork>;
  getTree(workId: string): Promise<ManuscriptTree>;
  createNode(workId: string, input: CreateNode, expectedRevision: number): Promise<NodeChange>;
  updateNode(workId: string, nodeId: string, input: UpdateNode, expectedRevision: number): Promise<NodeChange>;
  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expectedRevision: number): Promise<TreeChange>;
  deleteNode(workId: string, nodeId: string, expectedRevision: number): Promise<NodeDeletion>;
  statDocument(workId: string, nodeId: string): Promise<DocumentStat>;
  readDocument(workId: string, nodeId: string): Promise<ManuscriptDocument>;
  writeDocument(workId: string, nodeId: string, content: string, expectedEtag?: string): Promise<DocumentStat>;
}

export interface ManuscriptRepository {
  forUser(userId: string): ManuscriptStore;
}
