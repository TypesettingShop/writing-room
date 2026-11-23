// @vitest-environment node

import { expect, it } from 'vitest';
import { InMemoryManuscriptRepository } from '../../../manuscript/common/inMemoryManuscriptStore.js';
import { InMemoryCharactersRepository } from '../../common/inMemoryCharactersStore.js';
import { charactersStoreContract } from './charactersStoreContract.js';

charactersStoreContract('in-memory characters', () => {
  const manuscript = new InMemoryManuscriptRepository();
  const characters = new InMemoryCharactersRepository(user => manuscript.workAccess(user));
  return {
    owner: characters.forUser('owner'),
    other: characters.forUser('other'),
    ownerWorks: manuscript.forUser('owner'),
    otherWorks: manuscript.forUser('other'),
  };
});

it('updates recent works only when a character tree or template revision changes', async () => {
  let timestamp = 10;
  const now = () => timestamp;
  const manuscript = new InMemoryManuscriptRepository(now);
  const characters = new InMemoryCharactersRepository(user => manuscript.workAccess(user), now).forUser('owner');
  const works = manuscript.forUser('owner');
  const first = await works.createWork({ title: 'First' });
  timestamp++;
  const second = await works.createWork({ title: 'Second' });
  expect((await works.listWorks()).map(work => work.id)).toEqual([second.id, first.id]);

  timestamp++;
  const { node } = await characters.createNode(first.id, { kind: 'character', parentId: null, title: 'New' }, 0);
  const lastChange = timestamp;
  expect((await works.listWorks()).map(work => work.id)).toEqual([first.id, second.id]);
  timestamp++;
  await characters.updateNode(first.id, node.id, {}, 1);
  await characters.moveNodes(first.id, [node.id], { parentId: null }, 1);
  await expect(characters.updateNode(first.id, node.id, { title: 'Stale' }, 0)).rejects.toMatchObject({ code: 'conflict' });
  await expect(characters.updateNode(first.id, node.id, { title: '\0' }, 1)).rejects.toMatchObject({ code: 'invalid' });
  expect((await works.getWork(first.id)).updatedAt).toBe(lastChange);
  expect(await works.getTree(first.id)).toEqual({ revision: 0, nodes: [] });

  timestamp++;
  await characters.putTemplate(second.id, [], 0);
  const templateChange = timestamp;
  expect((await works.listWorks()).map(work => work.id)).toEqual([second.id, first.id]);
  timestamp++;
  await expect(characters.putTemplate(second.id, [], 0)).rejects.toMatchObject({ code: 'conflict' });
  await expect(characters.putTemplate(second.id, [{ id: 'x', kind: 'choice', label: 'X' }], 1)).rejects.toMatchObject({ code: 'invalid' });
  expect((await works.getWork(second.id)).updatedAt).toBe(templateChange);
  expect((await characters.getTree(second.id)).revision).toBe(0);
});
