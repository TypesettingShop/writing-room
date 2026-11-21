import { afterEach, expect, it, vi } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import type { ExtensionGalleryService, GalleryExtension, GalleryExtensionVersion, GallerySearchPage } from '../../../../../platform/extensionManagement/common/extensionGalleryService.js';
import type { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ExtensionManagementService, PackageInstallConfirmation } from '../../../../services/extensionManagement/common/extensionManagementService.js';
import { ExtensionsWorkbenchService } from '../../browser/extensionsWorkbenchService.js';

function result(name: string): GalleryExtension {
  return { namespace: 'test', id: 'test.' + name, name, displayName: name, description: '', version: '1.0.0', downloadCount: 0, verifiedPublisher: false };
}

function setup(
  gallery: Partial<ExtensionGalleryService>,
  management: Partial<ExtensionManagementService> = {},
  extensions: readonly IExtensionDescription[] = [],
  quickInput: Partial<IQuickInputService> = {},
) {
  return new ExtensionsWorkbenchService(
    { enabled: true, ...gallery } as ExtensionGalleryService, management as ExtensionManagementService,
    { _serviceBrand: undefined, scanUserExtensions: () => [], sessionOnly: false, locked: vi.fn() },
    { _serviceBrand: undefined, extensions, activateByEvent: vi.fn(), activationEventIsDone: vi.fn(), whenInstalledExtensionsRegistered: async () => true },
    quickInput as IQuickInputService,
  );
}

afterEach(() => vi.useRealTimers());

it('keeps the latest search when an earlier request succeeds after it was cancelled', async () => {
  vi.useFakeTimers();
  let resolveOld!: (page: GallerySearchPage) => void;
  const old = new Promise<GallerySearchPage>(resolve => { resolveOld = resolve; });
  const newest = result('new');
  const search = vi.fn<ExtensionGalleryService['search']>()
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce({ extensions: [newest] });
  const service = setup({ search });
  try {
    service.search('old');
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const oldSignal = search.mock.calls[0][2]!;
    service.search('new');
    expect(oldSignal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(service.searchResults).toEqual([newest]);
    resolveOld({ extensions: [result('old')] });
    await old;
    expect(service.searchResults).toEqual([newest]);
    expect(service.status).toBe('complete');
  } finally {
    service.dispose();
  }
});

it('deduplicates installs, permits two different downloads, and frees a slot on cancellation', async () => {
  const getExtension = vi.fn<ExtensionGalleryService['getExtension']>((_id, _version, signal) =>
    new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
  const service = setup({ getExtension });
  try {
    const first = result('first');
    const second = result('second');
    const third = result('third');
    service.install(first);
    service.install(first);
    service.install(second);
    service.install(third);
    expect(getExtension.mock.calls.map(([id]) => id.name)).toEqual(['first', 'second']);
    expect(service.canStartInstall).toBe(false);
    service.cancel(first.id);
    expect(getExtension.mock.calls[0][2]?.aborted).toBe(true);
    await vi.waitFor(() => expect(service.canStartInstall).toBe(true));
    expect(service.operation(first.id)).toBeUndefined();
    expect(service.failure(first.id)).toBeUndefined();
    service.install(third);
    expect(getExtension.mock.calls.map(([id]) => id.name)).toEqual(['first', 'second', 'third']);
  } finally {
    service.dispose();
  }
});


const confirmation: PackageInstallConfirmation = {
  identifier: 'test.root', manifest: { publisher: 'test', name: 'root', version: '1.0.0' },
  displayName: 'Root', source: { kind: 'vsix', label: 'root.vsix' }, size: 0, sha256: '',
  signature: 'unsigned', engine: '*', isWebExtension: true, persistent: true, warnings: [],
};

it('cancels a queued confirmation immediately and keeps later prompts behind the active prompt', async () => {
  const closeFirst = new DeferredPromise<void>();
  const createQuickPick = vi.fn();
  const service = setup({}, {}, [], { createQuickPick });
  const active = service.queuePrompt(() => closeFirst.p);
  const abort = new AbortController();
  const cancelled = vi.fn();
  const waiting = service.confirmInstall(confirmation, abort.signal);
  void waiting.then(cancelled);
  const next = vi.fn(async () => true);
  const nextPrompt = service.queuePrompt(next);
  try {
    abort.abort();
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith(false));
    expect(next).not.toHaveBeenCalled();
    expect(createQuickPick).not.toHaveBeenCalled();
  } finally {
    await closeFirst.complete();
    await Promise.allSettled([active, waiting, nextPrompt]);
    service.dispose();
  }
  expect(createQuickPick).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});

function dependencyGraph(graph: Record<string, string[]>, existing: string[] = []) {
  const describe = (name: string): IExtensionDescription => ({
    identifier: new ExtensionIdentifier('test.' + name), isBuiltin: false, location: 'https://registry.example/',
    manifest: { publisher: 'test', name, version: '1.0.0' },
  });
  const getExtension = vi.fn<ExtensionGalleryService['getExtension']>(async ({ name }): Promise<GalleryExtensionVersion> => ({
    ...result(name), isWebExtension: true, hasExtensionPack: false, download: '', sha256: '',
    dependencies: (graph[name] ?? []).map(name => ({ namespace: 'test', name })),
  }));
  const finished: string[] = [];
  const service = setup({
    getExtension,
    download: async () => ({ bytes: new Uint8Array(), sha256: '', host: 'registry.example', signature: { state: 'unsigned' } }),
  }, {
    installFromGallery: async (release, _download, confirm) => {
      if (await confirm(confirmation)) {
        finished.push(release.name);
        return describe(release.name);
      }
      return undefined;
    },
  }, existing.map(describe));
  vi.spyOn(service, 'confirmInstall').mockResolvedValue(true);
  return { service, getExtension, finished };
}

it('reports a dependency cycle with its path', async () => {
  const { service, getExtension, finished } = dependencyGraph({ root: ['a'], a: ['root'] });
  try {
    service.install(result('root'));
    await vi.waitFor(() => expect(service.failure('test.root')?.message).toMatch(/test.root → test.a → test.root/));
    expect(getExtension.mock.calls.map(([id]) => id.name)).toEqual(['root', 'a']);
    expect(finished).toEqual([]);
  } finally {
    service.dispose();
  }
});

it.each([false, true])('applies the depth limit only if the deepest dependency needs installation (%s)', async installed => {
  const { service, getExtension, finished } = dependencyGraph({
    root: ['a'], a: ['b'], b: ['c'], c: ['d'],
  }, installed ? ['d'] : []);
  try {
    service.install(result('root'));
    await vi.waitFor(() => expect(service.operation('test.root')).toBeUndefined());
    expect(getExtension.mock.calls.map(([id]) => id.name)).toEqual(['root', 'a', 'b', 'c']);
    if (installed) {
      expect(service.failure('test.root')).toBeUndefined();
      expect(finished).toEqual(['c', 'b', 'a', 'root']);
    } else {
      expect(service.failure('test.root')?.message).toMatch(/more than three levels deep/);
      expect(finished).toEqual([]);
    }
  } finally {
    service.dispose();
  }
});
