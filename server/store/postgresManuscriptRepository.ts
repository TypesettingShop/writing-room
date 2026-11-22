import { randomUUID } from 'node:crypto';
import pg, { type PoolClient, type PoolConfig } from 'pg';
import {
  checkDocumentEtag, checkRevision, documentSize, isManuscriptId, ManuscriptStoreError, normalizeManuscriptTitle,
  type DocumentStat, type ManuscriptDocument, type ManuscriptNode, type ManuscriptTree, type ManuscriptWork,
} from '../../src/platform/manuscript/common/manuscript.js';
import type {
  CreateNode, ManuscriptRepository, ManuscriptStore, NodeChange, NodeDeletion, NodeDestination, TreeChange, UpdateNode,
} from '../../src/platform/manuscript/common/manuscriptStore.js';
import { ManuscriptTreeEditor } from '../../src/platform/manuscript/common/manuscriptTree.js';
import { inTransaction } from './transaction.js';

export function createPostgresPool(databaseUrl: string, max: number, options?: PoolConfig['options']): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max, options, statement_timeout: 10_000, connectionTimeoutMillis: 10_000 });
}

export class PostgresManuscriptRepository implements ManuscriptRepository {
  private readonly pool: pg.Pool;
  private readonly now: () => number;

  constructor(pool: pg.Pool, now: () => number = Date.now) {
    this.pool = pool;
    this.now = now;
  }

  async ensureDevUser(userId: string): Promise<void> {
    await this.pool.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [userId]);
  }

  forUser(userId: string): ManuscriptStore {
    return new PostgresManuscriptStore(this.pool, userId, this.now);
  }
}

interface WorkRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: ManuscriptNode['kind'];
  title: string;
  position: number;
  metadata: ManuscriptNode['metadata'];
  created_at: Date;
  updated_at: Date;
}

interface DocumentRow {
  mtime_ms: string;
  size_bytes: number;
}

interface TreeEdit<T> {
  result: T;
  inserted?: ManuscriptNode;
  deleteRootId?: string;
}

function workFromRow(row: WorkRow): ManuscriptWork {
  return { id: row.id, title: row.title, createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime() };
}

function nodeFromRow(row: NodeRow): ManuscriptNode {
  return {
    id: row.id, parentId: row.parent_id, kind: row.kind, title: row.title, position: row.position, metadata: row.metadata,
    createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(),
  };
}

function requireRow<T>(rows: readonly T[]): T {
  if (!rows.length) {
    throw new ManuscriptStoreError('not_found');
  }
  return rows[0];
}

function assertId(id: string): void {
  if (!isManuscriptId(id)) {
    throw new ManuscriptStoreError('not_found');
  }
}

function documentStat(row: DocumentRow): DocumentStat {
  return { mtime: Number(row.mtime_ms), size: row.size_bytes };
}

const documentScope = `
  FROM documents AS d
  JOIN nodes AS n ON n.id = d.node_id
  JOIN works AS w ON w.id = n.work_id
  WHERE w.id = $1 AND w.owner_id = $2 AND n.id = $3
`;

class PostgresManuscriptStore implements ManuscriptStore {
  private readonly pool: pg.Pool;
  private readonly ownerId: string;
  private readonly now: () => number;

  constructor(pool: pg.Pool, ownerId: string, now: () => number) {
    this.pool = pool;
    this.ownerId = ownerId;
    this.now = now;
  }

  async listWorks(): Promise<ManuscriptWork[]> {
    const { rows } = await this.pool.query<WorkRow>(`
      SELECT id, title, created_at, updated_at FROM works WHERE owner_id = $1 ORDER BY updated_at DESC, id
    `, [this.ownerId]);
    return rows.map(workFromRow);
  }

  async createWork({ title }: { title: string }): Promise<ManuscriptWork> {
    const { rows } = await this.pool.query<WorkRow>(`
      INSERT INTO works (owner_id, title, created_at, updated_at)
      SELECT id, $2, $3, $3 FROM users WHERE id = $1
      RETURNING id, title, created_at, updated_at
    `, [this.ownerId, normalizeManuscriptTitle(title, false), new Date(this.now())]);
    if (!rows.length) {
      throw new ManuscriptStoreError('unauthorized');
    }
    return workFromRow(rows[0]);
  }

  async getWork(workId: string): Promise<ManuscriptWork> {
    assertId(workId);
    const { rows } = await this.pool.query<WorkRow>(`
      SELECT id, title, created_at, updated_at FROM works WHERE id = $1 AND owner_id = $2
    `, [workId, this.ownerId]);
    return workFromRow(requireRow(rows));
  }

  async getTree(workId: string): Promise<ManuscriptTree> {
    assertId(workId);
    // One statement reads the revision and nodes from the same snapshot, even for an empty tree.
    const { rows } = await this.pool.query<NodeRow & { tree_revision: string }>(`
      SELECT w.tree_revision, n.id, n.parent_id, n.kind, n.title, n.position, n.metadata, n.created_at, n.updated_at
      FROM works AS w LEFT JOIN nodes AS n ON n.work_id = w.id
      WHERE w.id = $1 AND w.owner_id = $2
    `, [workId, this.ownerId]);
    const revision = Number(requireRow(rows).tree_revision);
    const nodes = new Map(rows.filter(row => row.id !== null).map(row => [row.id, nodeFromRow(row)]));
    return { revision, nodes: new ManuscriptTreeEditor(nodes).orderedNodes() };
  }

  createNode(workId: string, input: CreateNode, expected: number): Promise<NodeChange> {
    return this.mutate(workId, expected, (tree, _client, now) => {
      const node = tree.create(input, randomUUID(), now);
      return { result: { node }, inserted: node };
    });
  }

  updateNode(workId: string, nodeId: string, input: UpdateNode, expected: number): Promise<NodeChange> {
    return this.mutate(workId, expected, (tree, _client, now) => ({ result: { node: tree.update(nodeId, input, now) } }));
  }

  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expected: number): Promise<TreeChange> {
    return this.mutate(workId, expected, async (tree, client, now) => {
      if (isManuscriptId(destination.parentId) && Array.isArray(nodeIds) && nodeIds.every(isManuscriptId)) {
        const { rows } = await client.query<{ cycle: boolean }>(`
          WITH RECURSIVE ancestors (id, parent_id) AS (
            SELECT n.id, n.parent_id FROM nodes AS n JOIN works AS w ON w.id = n.work_id
            WHERE w.id = $1 AND w.owner_id = $2 AND n.id = $3
            UNION
            SELECT n.id, n.parent_id FROM nodes AS n JOIN ancestors AS a ON n.id = a.parent_id
            JOIN works AS w ON w.id = n.work_id WHERE w.id = $1 AND w.owner_id = $2
          )
          SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ANY($4::uuid[])) AS cycle
        `, [workId, this.ownerId, destination.parentId, nodeIds]);
        if (rows[0].cycle) {
          throw new ManuscriptStoreError('invalid');
        }
      }
      tree.move(nodeIds, destination, now);
      return { result: {} };
    });
  }

  deleteNode(workId: string, nodeId: string, expected: number): Promise<NodeDeletion> {
    return this.mutate(workId, expected, (tree, _client, now) => ({
      result: { deletedDocumentIds: tree.delete(nodeId, now) }, deleteRootId: nodeId,
    }));
  }

  private async mutate<T>(
    workId: string, expected: number, edit: (tree: ManuscriptTreeEditor, client: PoolClient, now: number) => TreeEdit<T> | Promise<TreeEdit<T>>,
  ): Promise<T & TreeChange> {
    assertId(workId);
    return inTransaction(this.pool, async client => {
      const scope = [workId, this.ownerId];
      const locked = await client.query<{ tree_revision: string }>(`
        SELECT tree_revision FROM works WHERE id = $1 AND owner_id = $2 FOR UPDATE
      `, scope);
      const revision = Number(requireRow(locked.rows).tree_revision);
      checkRevision(revision, expected);

      const { rows } = await client.query<NodeRow>(`
        SELECT n.id, n.parent_id, n.kind, n.title, n.position, n.metadata, n.created_at, n.updated_at
        FROM nodes AS n JOIN works AS w ON w.id = n.work_id WHERE w.id = $1 AND w.owner_id = $2
      `, scope);
      const tree = new ManuscriptTreeEditor(new Map(rows.map(row => [row.id, nodeFromRow(row)])));
      const now = this.now();
      const { result, inserted, deleteRootId } = await edit(tree, client, now);
      if (!tree.changed.size && !tree.deleted.size) {
        return { ...result, revision };
      }

      if (deleteRootId !== undefined) {
        await client.query(`
          DELETE FROM nodes AS n USING works AS w
          WHERE n.work_id = w.id AND w.id = $1 AND w.owner_id = $2 AND n.id = $3
        `, [...scope, deleteRootId]);
      }
      if (inserted) {
        await this.insertNode(client, scope, inserted);
        tree.changed.delete(inserted.id);
      }
      if (tree.changed.size) {
        const changes = [...tree.changed.values()].map(node => ({
          id: node.id, parent_id: node.parentId, title: node.title, position: node.position, metadata: node.metadata,
          updated_at: new Date(node.updatedAt),
        }));
        await client.query(`
          UPDATE nodes AS n SET parent_id = ch.parent_id, title = ch.title, position = ch.position,
            metadata = ch.metadata, updated_at = ch.updated_at
          FROM works AS w, jsonb_to_recordset($3::jsonb)
            AS ch(id uuid, parent_id uuid, title text, position integer, metadata jsonb, updated_at timestamptz)
          WHERE w.id = $1 AND w.owner_id = $2 AND n.work_id = w.id AND n.id = ch.id
        `, [...scope, JSON.stringify(changes)]);
      }
      await client.query(`
        UPDATE works SET tree_revision = tree_revision + 1, updated_at = $3 WHERE id = $1 AND owner_id = $2
      `, [...scope, new Date(now)]);
      return { ...result, revision: revision + 1 };
    });
  }

  private async insertNode(client: PoolClient, scope: string[], node: ManuscriptNode): Promise<void> {
    await client.query(`
      INSERT INTO nodes (id, work_id, parent_id, kind, title, position, created_at, updated_at)
      SELECT $3, w.id, $4, $5, $6, $7, $8, $8 FROM works AS w WHERE w.id = $1 AND w.owner_id = $2
    `, [...scope, node.id, node.parentId, node.kind, node.title, node.position, new Date(node.createdAt)]);
    if (node.kind === 'document') {
      await client.query(`
        INSERT INTO documents (node_id, mtime_ms, size_bytes)
        SELECT n.id, $4, 0 FROM nodes AS n JOIN works AS w ON w.id = n.work_id
        WHERE w.id = $1 AND w.owner_id = $2 AND n.id = $3
      `, [...scope, node.id, node.createdAt]);
    }
  }

  async statDocument(workId: string, nodeId: string): Promise<DocumentStat> {
    assertId(workId);
    assertId(nodeId);
    const { rows } = await this.pool.query<DocumentRow>('SELECT d.mtime_ms, d.size_bytes ' + documentScope, [workId, this.ownerId, nodeId]);
    return documentStat(requireRow(rows));
  }

  async readDocument(workId: string, nodeId: string): Promise<ManuscriptDocument> {
    assertId(workId);
    assertId(nodeId);
    const { rows } = await this.pool.query<DocumentRow & { content: string }>(
      'SELECT d.mtime_ms, d.size_bytes, d.content ' + documentScope, [workId, this.ownerId, nodeId],
    );
    const row = requireRow(rows);
    return { ...documentStat(row), content: row.content };
  }

  async writeDocument(workId: string, nodeId: string, content: string, expectedEtag?: string): Promise<DocumentStat> {
    assertId(workId);
    assertId(nodeId);
    return inTransaction(this.pool, async client => {
      const scope = [workId, this.ownerId, nodeId];
      const current = await client.query<DocumentRow>('SELECT d.mtime_ms, d.size_bytes ' + documentScope + ' FOR UPDATE OF d', scope);
      checkDocumentEtag(documentStat(requireRow(current.rows)), expectedEtag);
      const size = documentSize(content);
      const { rows } = await client.query<DocumentRow>(`
        UPDATE documents AS d SET content = $4, size_bytes = $5, mtime_ms = greatest($6, d.mtime_ms + 1)
        FROM nodes AS n JOIN works AS w ON w.id = n.work_id
        WHERE w.id = $1 AND w.owner_id = $2 AND n.id = $3 AND d.node_id = n.id
        RETURNING d.mtime_ms, d.size_bytes
      `, [...scope, content, size, this.now()]);
      return documentStat(requireRow(rows));
    });
  }
}
