import type { Event } from '../../../../base/common/event.js';
import { createDecorator, type BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ManuscriptStore } from '../../../../platform/manuscript/common/manuscriptStore.js';

export const IManuscriptService = createDecorator<IManuscriptService>('manuscriptService');

export type ManuscriptAvailability = 'ready' | 'signedOut' | 'unavailable';

export interface ManuscriptAuth {
  hasGoogle(): Promise<boolean>;
  signIn(email: string, password: string, createAccount: boolean): Promise<void>;
  signOut(): Promise<void>;
}

export interface ManuscriptAuthChange {
  readonly signedIn: boolean;
  readonly reason: 'request' | 'account';
}

export interface DeletedManuscriptDocuments {
  readonly workId: string;
  readonly nodeIds: readonly string[];
}

export interface IManuscriptService extends BrandedService {
  readonly store: ManuscriptStore;
  readonly availability: ManuscriptAvailability;
  readonly usesMemory: boolean;
  readonly onDidChangeAvailability: Event<ManuscriptAvailability>;
  readonly auth: ManuscriptAuth | undefined;
  readonly signedIn: boolean | undefined;
  readonly onDidChangeAuth: Event<ManuscriptAuthChange>;
  readonly onDidChangeTree: Event<string>;
  readonly onDidDeleteDocuments: Event<DeletedManuscriptDocuments>;
}
