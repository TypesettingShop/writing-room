import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeCharacterTemplate, normalizeCharacterValues } from '../../src/platform/characters/common/characterFields.js';
import { isManuscriptId } from '../../src/platform/manuscript/common/manuscript.js';
import type { NodeDestination, TreeChange } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { getGregorianCalendar, normalizeCalendar, type Calendar } from '../../src/platform/world/common/calendar.js';
import { checkWorldRevision, WorldStoreError, type WorldNode, type WorldTree } from '../../src/platform/world/common/world.js';
import type {
  CreateWorldNode, UpdateWorldNode, WorldCalendarSnapshot, WorldNodeChange, WorldNodeDeletion, WorldRepository, WorldStore,
} from '../../src/platform/world/common/worldStore.js';
import {
  checkWorldWorkDataSize, updateWorldNode, worldDataSize, WorldTreeEditor,
} from '../../src/platform/world/common/worldTree.js';
import { inTransaction } from './transaction.js';

export class PostgresWorldRepository implements WorldRepository {
  constructor(private readonly pool: Pool, private readonly now: () => number = Date.now) {}

  forUser(userId: string): WorldStore {
    return new PostgresWorldStore(this.pool, userId, this.now);
  }
}

interface WorldNodeRow {
  id: string;
  parent_id: string | null;
  kind: WorldNode['kind'];
  title: string;
  position: number;
  fields?: unknown;
  field_values?: unknown;
  created_at: Date;
  updated_at: Date;
}

interface WorldRevisionRow {
  world_revision: string;
}

const structureColumns = 'n.id, n.parent_id, n.kind, n.title, n.position, n.created_at, n.updated_at';
const payloadColumns = 'n.fields, n.field_values';

function nodeFromRow(row: WorldNodeRow): WorldNode {
  const base = {
    id: row.id, parentId: row.parent_id, title: row.title, position: row.position,
    createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(),
  };
  // Structural edits select no payload columns and persist only changed positions and parents.
  switch (row.kind) {
    case 'category':
      return { ...base, kind: row.kind, fields: row.fields === undefined ? [] : normalizeCharacterTemplate(row.fields) };
    case 'item':
      return { ...base, kind: row.kind, values: row.field_values === undefined ? {} : normalizeCharacterValues(row.field_values) };
    case 'calendar':
      return { ...base, kind: row.kind };
  }
}

function requireRow<T>(rows: readonly T[]): T {
  if (!rows.length) {
    throw new WorldStoreError('not_found');
  }
  return rows[0];
}

function assertId(id: string): void {
  if (!isManuscriptId(id)) {
    throw new WorldStoreError('not_found');
  }
}

async function checkDataBudget(client: PoolClient, workId: string, additionalBytes: number): Promise<void> {
  if (additionalBytes <= 0) {
    return;
  }
  const { rows: [total] } = await client.query<{ bytes: string }>(`
    SELECT COALESCE(SUM(data_bytes), 0) AS bytes FROM world_nodes WHERE work_id = $1
  `, [workId]);
  checkWorldWorkDataSize(Number(total.bytes) + additionalBytes);
}

async function insertNodes(client: PoolClient, workId: string, nodes: readonly WorldNode[]): Promise<void> {
  const records = nodes.map(node => ({
    id: node.id,
    kind: node.kind,
    parent_id: node.parentId,
    position: node.position,
    title: node.title,
    fields: node.fields ?? null,
    field_values: node.values ?? null,
    data_bytes: worldDataSize(node),
    created_at: new Date(node.createdAt),
    updated_at: new Date(node.updatedAt),
  }));
  await checkDataBudget(client, workId, records.reduce((sum, row) => sum + row.data_bytes, 0));
  await client.query(`
    INSERT INTO world_nodes (work_id, id, parent_id, kind, title, position, fields, field_values, data_bytes, created_at, updated_at)
    SELECT $1, entry.id, entry.parent_id, entry.kind, entry.title, entry.position,
      entry.fields, entry.field_values, entry.data_bytes, entry.created_at, entry.updated_at
    FROM jsonb_to_recordset($2::jsonb) AS entry(
      id uuid, parent_id uuid, kind text, title text, position integer,
      fields jsonb, field_values jsonb, data_bytes integer, created_at timestamptz, updated_at timestamptz
    )
  `, [workId, JSON.stringify(records)]);
}

class PostgresWorldStore implements WorldStore {
  constructor(private readonly pool: Pool, private readonly ownerId: string, private readonly now: () => number) {}

  async getTree(workId: string): Promise<WorldTree> {
    assertId(workId);
    // One statement gives the revision and nodes from the same snapshot, including when the tree is empty.
    const { rows } = await this.pool.query<WorldNodeRow & WorldRevisionRow>(`
      SELECT w.world_revision, ${structureColumns}, ${payloadColumns}
      FROM works AS w LEFT JOIN world_nodes AS n ON n.work_id = w.id
      WHERE w.id = $1 AND w.owner_id = $2
    `, [workId, this.ownerId]);
    const revision = Number(requireRow(rows).world_revision);
    const nodes = new Map(rows.filter(row => row.id !== null).map(row => [row.id, nodeFromRow(row)]));
    return { revision, nodes: new WorldTreeEditor(nodes).orderedNodes() };
  }

  async getCalendar(workId: string): Promise<WorldCalendarSnapshot> {
    assertId(workId);
    const { rows } = await this.pool.query<{ revision: string | null; definition: unknown }>(`
      SELECT c.revision, c.definition
      FROM works AS w LEFT JOIN world_calendars AS c ON c.work_id = w.id
      WHERE w.id = $1 AND w.owner_id = $2
    `, [workId, this.ownerId]);
    const row = requireRow(rows);
    return row.revision === null
      ? { revision: 0, calendar: getGregorianCalendar() }
      : { revision: Number(row.revision), calendar: normalizeCalendar(row.definition) };
  }

  putCalendar(workId: string, input: Calendar, expected: number): Promise<WorldCalendarSnapshot> {
    return this.withLockedWork(workId, async client => {
      const { rows: [current] } = await client.query<{ revision: string }>(
        'SELECT revision FROM world_calendars WHERE work_id = $1', [workId],
      );
      const revision = current ? Number(current.revision) : 0;
      checkWorldRevision(revision, expected);
      const calendar = normalizeCalendar(input);
      const now = new Date(this.now());
      await client.query(`
        INSERT INTO world_calendars (work_id, revision, definition, updated_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (work_id) DO UPDATE
          SET revision = EXCLUDED.revision, definition = EXCLUDED.definition, updated_at = EXCLUDED.updated_at
      `, [workId, revision + 1, JSON.stringify(calendar), now]);
      await client.query('UPDATE works SET updated_at = $2 WHERE id = $1', [workId, now]);
      return { revision: revision + 1, calendar };
    });
  }

  applyPreset(workId: string, presetId: string, expected: number): Promise<WorldTree> {
    return this.mutateStructure(workId, expected, (tree, now) => ({
      nodes: tree.applyPreset(presetId, randomUUID, now),
    }));
  }

  createNode(workId: string, input: CreateWorldNode, expected: number): Promise<WorldNodeChange> {
    return this.mutateStructure(workId, expected, (tree, now) => ({
      node: tree.create(input, randomUUID(), now),
    }));
  }

  updateNode(workId: string, nodeId: string, input: UpdateWorldNode, expected: number): Promise<WorldNodeChange> {
    return this.mutate(workId, expected, async (client, now) => {
      assertId(nodeId);
      const { rows } = await client.query<WorldNodeRow & { data_bytes: number }>(`
        SELECT ${structureColumns}, ${payloadColumns}, n.data_bytes
        FROM world_nodes AS n WHERE n.work_id = $1 AND n.id = $2
      `, [workId, nodeId]);
      const row = requireRow(rows);
      const node = nodeFromRow(row);
      const updated = updateWorldNode(node, input, now);
      if (updated === node) {
        return { result: { node }, changed: false };
      }

      // jsonb renders whitespace when cast to text. Count compact UTF-8 bytes in JS, including empty [] and {}.
      const bytes = worldDataSize(updated);
      await checkDataBudget(client, workId, bytes - row.data_bytes);
      await client.query(`
        UPDATE world_nodes SET title = $3, fields = $4, field_values = $5, data_bytes = $6, updated_at = $7
        WHERE work_id = $1 AND id = $2
      `, [
        workId, nodeId, updated.title, updated.fields === undefined ? null : JSON.stringify(updated.fields),
        updated.values === undefined ? null : JSON.stringify(updated.values), bytes, new Date(now),
      ]);
      return { result: { node: updated }, changed: true };
    });
  }

  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expected: number): Promise<TreeChange> {
    return this.mutateStructure(workId, expected, (tree, now) => {
      tree.move(nodeIds, destination, now);
      return {};
    });
  }

  deleteNode(workId: string, nodeId: string, expected: number): Promise<WorldNodeDeletion> {
    return this.mutateStructure(workId, expected, (tree, now) => ({
      deletedNodeIds: tree.delete(nodeId, now),
    }));
  }

  private mutateStructure<T>(
    workId: string, expected: number, edit: (tree: WorldTreeEditor, now: number) => T,
  ): Promise<T & TreeChange> {
    return this.mutate(workId, expected, async (client, now) => {
      const { rows } = await client.query<WorldNodeRow>(`
        SELECT ${structureColumns} FROM world_nodes AS n WHERE n.work_id = $1
      `, [workId]);
      const nodes = new Map(rows.map(row => [row.id, nodeFromRow(row)]));
      const tree = new WorldTreeEditor(nodes);
      const result = edit(tree, now);
      const inserted: WorldNode[] = [];
      const moved: Array<{ id: string; parent_id: string | null; position: number; updated_at: Date }> = [];
      for (const node of tree.changed.values()) {
        if (nodes.has(node.id)) {
          moved.push({ id: node.id, parent_id: node.parentId, position: node.position, updated_at: new Date(node.updatedAt) });
        } else {
          inserted.push(node);
        }
      }
      if (tree.deleted.size) {
        // Delete the subtree as a set, including arbitrarily deep category chains.
        await client.query('DELETE FROM world_nodes WHERE work_id = $1 AND id = ANY($2::uuid[])', [workId, [...tree.deleted]]);
      }
      if (inserted.length) {
        await insertNodes(client, workId, inserted);
      }
      if (moved.length) {
        await client.query(`
          UPDATE world_nodes AS n SET parent_id = ch.parent_id, position = ch.position, updated_at = ch.updated_at
          FROM jsonb_to_recordset($2::jsonb) AS ch(id uuid, parent_id uuid, position integer, updated_at timestamptz)
          WHERE n.work_id = $1 AND n.id = ch.id
        `, [workId, JSON.stringify(moved)]);
      }
      return { result, changed: tree.changed.size > 0 || tree.deleted.size > 0 };
    });
  }

  private mutate<T>(
    workId: string, expected: number, write: (client: PoolClient, now: number) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T & TreeChange> {
    return this.withLockedWork(workId, async (client, revision) => {
      checkWorldRevision(revision, expected);
      const now = this.now();
      const { result, changed } = await write(client, now);
      if (changed) {
        await client.query(`
          UPDATE works SET world_revision = world_revision + 1, updated_at = $2 WHERE id = $1
        `, [workId, new Date(now)]);
      }
      return { ...result, revision: changed ? revision + 1 : revision };
    });
  }

  private async withLockedWork<T>(workId: string, write: (client: PoolClient, treeRevision: number) => Promise<T>): Promise<T> {
    assertId(workId);
    return inTransaction(this.pool, async client => {
      // The owned work row is present before the first calendar write and serializes both revision streams.
      const locked = await client.query<WorldRevisionRow>(`
        SELECT world_revision FROM works WHERE id = $1 AND owner_id = $2 FOR UPDATE
      `, [workId, this.ownerId]);
      return write(client, Number(requireRow(locked.rows).world_revision));
    });
  }
}
