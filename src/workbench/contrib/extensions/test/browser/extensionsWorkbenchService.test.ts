import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionGalleryService, GalleryExtension, GallerySearchPage } from '../../../../../platform/extensionManagement/common/extensionGalleryService.js';
import type { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import type { ExtensionManagementService } from '../../../../services/extensionManagement/common/extensionManagementService.js';
import { ExtensionsWorkbenchService } from '../../browser/extensionsWorkbenchService.js';

function result(name: string): GalleryExtension {
  return { namespace: 'test', id: 'test.' + name, name, displayName: name, description: '', version: '1.0.0', downloadCount: 0, verifiedPublisher: false };
}

function setup(gallery: Partial<ExtensionGalleryService>) {
  return new ExtensionsWorkbenchService(
    { enabled: true, ...gallery } as ExtensionGalleryService, {} as ExtensionManagementService,
    { _serviceBrand: undefined, scanUserExtensions: () => [], locked: vi.fn() },
    { _serviceBrand: undefined, activateByEvent: vi.fn(), activationEventIsDone: vi.fn(), whenInstalledExtensionsRegistered: async () => true },
    {} as IQuickInputService,
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
