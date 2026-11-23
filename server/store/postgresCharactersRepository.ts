import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CharacterValues } from '../../src/platform/characters/common/characterFields.js';
import {
  CharacterTreeEditor, characterValueSize, checkCharacterWorkValuesSize, updateCharacterNode,
} from '../../src/platform/characters/common/characterTree.js';
import {
  CharacterStoreError, checkCharacterRevision, type CharacterNode, type CharacterTree, type CharacterType,
} from '../../src/platform/characters/common/characters.js';
import type {
  CharacterNodeChange, CharacterNodeDeletion, CharactersRepository, CharactersStore, CreateCharacterNode, UpdateCharacterNode,
} from '../../src/platform/characters/common/charactersStore.js';
import { isManuscriptId } from '../../src/platform/manuscript/common/manuscript.js';
import type { NodeDestination, TreeChange } from '../../src/platform/manuscript/common/manuscriptStore.js';
import { inTransaction } from './transaction.js';

export class PostgresCharactersRepository implements CharactersRepository {
  constructor(private readonly pool: Pool, private readonly now: () => number = Date.now) {}

  forUser(userId: string): CharactersStore {
    return new PostgresCharactersStore(this.pool, userId, this.now);
  }
}

interface CharacterRow {
  id: string;
  parent_id: string | null;
  kind: CharacterNode['kind'];
  title: string;
  position: number;
  type: CharacterType | null;
  field_values?: CharacterValues | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkRevisionRow {
  characters_revision: string;
}

interface TreeEdit<T> {
  result: T;
  inserted?: CharacterNode;
  deleteRootId?: string;
}

const characterColumns = 'c.id, c.parent_id, c.kind, c.title, c.position, c.type, c.created_at, c.updated_at';

function nodeFromRow(row: CharacterRow): CharacterNode {
  const base = {
    id: row.id, parentId: row.parent_id, title: row.title, position: row.position,
    createdAt: row.created_at.getTime(), updatedAt: row.updated_at.getTime(),
  };
  // Folder rows have no character data. Structural writes only select the columns needed to reorder nodes.
  return row.kind === 'folder'
    ? { ...base, kind: 'folder' }
    : { ...base, kind: 'character', type: row.type!, values: row.field_values ?? {} };
}

function requireRow<T>(rows: readonly T[]): T {
  if (!rows.length) {
    throw new CharacterStoreError('not_found');
  }
  return rows[0];
}

function assertId(id: string): void {
  if (!isManuscriptId(id)) {
    throw new CharacterStoreError('not_found');
  }
}

class PostgresCharactersStore implements CharactersStore {
  constructor(private readonly pool: Pool, private readonly ownerId: string, private readonly now: () => number) {}

  async getTree(workId: string): Promise<CharacterTree> {
    assertId(workId);
    // The left join returns the work revision even for an empty tree, in the same snapshot as its nodes.
    const { rows } = await this.pool.query<CharacterRow & WorkRevisionRow>(`
      SELECT w.characters_revision, ${characterColumns}, c.field_values
      FROM works AS w LEFT JOIN characters AS c ON c.work_id = w.id
      WHERE w.id = $1 AND w.owner_id = $2
    `, [workId, this.ownerId]);
    const revision = Number(requireRow(rows).characters_revision);
    const nodes = new Map(rows.filter(row => row.id !== null).map(row => [row.id, nodeFromRow(row)]));
    return { revision, nodes: new CharacterTreeEditor(nodes).orderedNodes() };
  }

  createNode(workId: string, input: CreateCharacterNode, expected: number): Promise<CharacterNodeChange> {
    return this.mutateStructure(workId, expected, (tree, now) => {
      const node = tree.create(input, randomUUID(), now);
      return { result: { node }, inserted: node };
    });
  }

  updateNode(workId: string, nodeId: string, input: UpdateCharacterNode, expected: number): Promise<CharacterNodeChange> {
    return this.mutate(workId, expected, async (client, now) => {
      assertId(nodeId);
      const { rows } = await client.query<CharacterRow & { values_bytes: number }>(`
        SELECT ${characterColumns}, c.field_values, c.values_bytes
        FROM characters AS c WHERE c.work_id = $1 AND c.id = $2
      `, [workId, nodeId]);
      const row = requireRow(rows);
      const node = nodeFromRow(row);
      const updated = updateCharacterNode(node, input, now);
      if (updated === node) {
        return { result: { node }, changed: false };
      }

      const bytes = updated.values === node.values ? row.values_bytes : characterValueSize(updated.values);
      if (bytes > row.values_bytes) {
        // Count compact UTF-8 sizes from the validated writes without loading the other values.
        const { rows: [total] } = await client.query<{ bytes: string }>(`
          SELECT COALESCE(SUM(values_bytes), 0) AS bytes FROM characters WHERE work_id = $1
        `, [workId]);
        checkCharacterWorkValuesSize(Number(total.bytes) - row.values_bytes + bytes);
      }
      await client.query(`
        UPDATE characters SET title = $3, type = $4, field_values = $5, values_bytes = $6, updated_at = $7
        WHERE work_id = $1 AND id = $2
      `, [workId, nodeId, updated.title, updated.type ?? null, updated.values ?? null, bytes, new Date(updated.updatedAt)]);
      return { result: { node: updated }, changed: true };
    });
  }

  moveNodes(workId: string, nodeIds: readonly string[], destination: NodeDestination, expected: number): Promise<TreeChange> {
    return this.mutateStructure(workId, expected, (tree, now) => {
      tree.move(nodeIds, destination, now);
      return { result: {} };
    });
  }

  deleteNode(workId: string, nodeId: string, expected: number): Promise<CharacterNodeDeletion> {
    return this.mutateStructure(workId, expected, (tree, now) => ({
      result: { deletedCharacterIds: tree.delete(nodeId, now) },
      deleteRootId: nodeId,
    }));
  }

  private mutateStructure<T>(
    workId: string, expected: number, edit: (tree: CharacterTreeEditor, now: number) => TreeEdit<T>,
  ): Promise<T & TreeChange> {
    return this.mutate(workId, expected, async (client, now) => {
      const { rows } = await client.query<CharacterRow>(`
        SELECT ${characterColumns} FROM characters AS c WHERE c.work_id = $1
      `, [workId]);
      const tree = new CharacterTreeEditor(new Map(rows.map(row => [row.id, nodeFromRow(row)])));
      const { result, inserted, deleteRootId } = edit(tree, now);
      const changed = tree.changed.size > 0 || tree.deleted.size > 0;
      if (deleteRootId !== undefined) {
        await client.query('DELETE FROM characters WHERE work_id = $1 AND id = $2', [workId, deleteRootId]);
      }
      if (inserted) {
        await client.query(`
          INSERT INTO characters (work_id, id, parent_id, kind, title, position, type, field_values, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        `, [
          workId, inserted.id, inserted.parentId, inserted.kind, inserted.title, inserted.position,
          inserted.type ?? null, inserted.values ?? null, new Date(inserted.createdAt),
        ]);
        tree.changed.delete(inserted.id);
      }
      if (tree.changed.size) {
        const changes = [...tree.changed.values()].map(node => ({
          id: node.id, parent_id: node.parentId, position: node.position, updated_at: new Date(node.updatedAt),
        }));
        await client.query(`
          UPDATE characters AS c SET parent_id = ch.parent_id, position = ch.position, updated_at = ch.updated_at
          FROM jsonb_to_recordset($2::jsonb) AS ch(id uuid, parent_id uuid, position integer, updated_at timestamptz)
          WHERE c.work_id = $1 AND c.id = ch.id
        `, [workId, JSON.stringify(changes)]);
      }
      return { result, changed };
    });
  }

  private mutate<T>(
    workId: string, expected: number, write: (client: PoolClient, now: number) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T & TreeChange> {
    assertId(workId);
    return inTransaction(this.pool, async client => {
      // Holding this owned work row keeps checks, writes and revision changes in one transaction.
      const locked = await client.query<WorkRevisionRow>(`
        SELECT characters_revision FROM works WHERE id = $1 AND owner_id = $2 FOR UPDATE
      `, [workId, this.ownerId]);
      const revision = Number(requireRow(locked.rows).characters_revision);
      checkCharacterRevision(revision, expected);
      const now = this.now();
      const { result, changed } = await write(client, now);
      if (changed) {
        await client.query(`
          UPDATE works SET characters_revision = characters_revision + 1, updated_at = $2 WHERE id = $1
        `, [workId, new Date(now)]);
      }
      return { ...result, revision: changed ? revision + 1 : revision };
    });
  }
}
