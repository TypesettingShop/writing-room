// @vitest-environment node
import { InMemoryManuscriptRepository } from '../../common/inMemoryManuscriptStore.js';
import { contractOther, contractOwner, contractTime, manuscriptStoreContract } from './manuscriptStoreContract.js';

manuscriptStoreContract('in-memory manuscript contract', async () => {
  const repository = new InMemoryManuscriptRepository(() => contractTime);
  return { owner: repository.forUser(contractOwner), other: repository.forUser(contractOther) };
});
