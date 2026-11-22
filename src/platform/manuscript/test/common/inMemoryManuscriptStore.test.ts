// @vitest-environment node
import { expect, it } from 'vitest';
import { InMemoryManuscriptRepository } from '../../common/inMemoryManuscriptStore.js';
import { manuscriptLimits, type ManuscriptNode } from '../../common/manuscript.js';
import { ManuscriptTreeEditor } from '../../common/manuscriptTree.js';
import { contractOther, contractOwner, contractTime, manuscriptStoreContract } from './manuscriptStoreContract.js';

manuscriptStoreContract('in-memory manuscript contract', async () => {
  const repository = new InMemoryManuscriptRepository(() => contractTime);
  return { owner: repository.forUser(contractOwner), other: repository.forUser(contractOther) };
});

it('rejects the 10,001st node before the shared tree editor changes state', () => {
  const nodes = new Map<string, ManuscriptNode>();
  expect(manuscriptLimits.nodes).toBe(10_000);
  for (let position = 0; position < manuscriptLimits.nodes; position++) {
    const id = String(position);
    nodes.set(id, { id, position, parentId: null, kind: 'document', title: '', metadata: {}, createdAt: 0, updatedAt: 0 });
  }
  const tree = new ManuscriptTreeEditor(nodes);
  expect(() => tree.create({ parentId: null, kind: 'document', title: '' }, 'extra', 0)).toThrow(
    expect.objectContaining({ code: 'limit' }),
  );
  expect(tree.changed.size).toBe(0);
});
