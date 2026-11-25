// @vitest-environment node

import { InMemoryManuscriptRepository } from '../../../manuscript/common/inMemoryManuscriptStore.js';
import { InMemoryWorldRepository } from '../../common/inMemoryWorldStore.js';
import { worldStoreContract } from './worldStoreContract.js';

worldStoreContract('in-memory world store', () => {
  let timestamp = 100;
  const now = () => timestamp;
  const manuscripts = new InMemoryManuscriptRepository(now);
  const worlds = new InMemoryWorldRepository(id => manuscripts.workAccess(id), now);
  return {
    owner: worlds.forUser('owner'),
    other: worlds.forUser('other'),
    ownerWorks: manuscripts.forUser('owner'),
    otherWorks: manuscripts.forUser('other'),
    advanceClock: () => { timestamp += 10; },
  };
});
