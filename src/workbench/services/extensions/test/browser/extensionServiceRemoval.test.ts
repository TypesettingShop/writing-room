import { afterEach, expect, test, vi } from 'vitest';
import { MenuRegistry } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import type { IExtensionDescription } from '../../../../../platform/extensions/common/extensions.js';
import { validateExtensionManifest } from '../../../../../platform/extensions/common/extensionValidator.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import '../../../../api/common/configurationExtensionPoint.js';
import type { MainThreadExtensionAccess } from '../../../../api/browser/mainThreadExtensionService.js';
import { IWorkbenchLayoutService } from '../../../layout/browser/layoutService.js';
import { ExtensionService } from '../../browser/extensionService.js';
import type { HostExtensionDescription } from '../../common/extensionHostProtocol.js';
import { resolveExtensionPath } from '../../common/extensionResources.js';
import { ExtensionsRegistry } from '../../common/extensionsRegistry.js';

/**
 * The removal order of wr-eycu.4bd on the main thread: the host is told first, the contributions go once the host
 * reports the extension inactive or ends. A fake worker stands for the extension host and records what reaches it.
 */
const fakes = vi.hoisted(() => ({
  hosts: [] as FakeHost[],
  log: [] as string[],
}));

interface FakeHost {
  readonly initial: readonly HostExtensionDescription[];
  readonly deltas: { added: HostExtensionDescription[]; removed: string[] }[];
  readonly activations: string[];
  readonly removed: string[];
  access?: MainThreadExtensionAccess;
  exit(error: Error): void;
  readonly graceful: { resolve?: () => void };
}

vi.mock('../../browser/webWorkerExtensionHost.js', async () => {
  const { Emitter } = await import('../../../../../base/common/event.js');
  return {
    WebWorkerExtensionHost: class {
      private readonly exited = new Emitter<Error>();
      readonly onDidExit = this.exited.event;
      readonly ready = Promise.resolve();
      readonly fake: FakeHost;
      readonly rpc: { getProxy(): unknown; fake?: FakeHost };
      constructor(initial: readonly HostExtensionDescription[]) {
        const fake: FakeHost = {
          initial, deltas: [], activations: [], removed: [], graceful: {},
          exit: error => this.exited.fire(error),
        };
        this.fake = fake;
        fakes.hosts.push(fake);
        this.rpc = {
          fake,
          getProxy: () => ({
            async $deltaExtensions(added: HostExtensionDescription[], removed: string[]) {
              fake.deltas.push({ added, removed });
              if (removed.length) {
                fakes.log.push('host:removed ' + removed.join(','));
              }
            },
            async $activateByEvent(event: string) {
              fake.activations.push(event);
            },
          }),
        };
      }
      shutdown() {}
      dispose() { this.exited.fire(new Error('disposed')); }
      shutdownGracefully() {
        return new Promise<void>(resolve => {
          this.fake.graceful.resolve = () => {
            this.exited.fire(new Error('stopped'));
            resolve();
          };
        });
      }
    },
  };
});

vi.mock('../../../../api/browser/mainThreadExtensionService.js', () => ({
  MainThreadExtensionService: class {
    private readonly fake: FakeHost;
    constructor(rpc: { fake: FakeHost }, access: MainThreadExtensionAccess) {
      this.fake = rpc.fake;
      this.fake.access = access;
    }
    remove(key: string) { this.fake.removed.push(key); }
    dispose() {}
  },
}));

const origin = 'https://example.com/extensions/removal/';
function description(name: string, title = name, setting = 'removalTest.' + name): IExtensionDescription {
  const { manifest } = validateExtensionManifest({
    name, publisher: 'test', version: '1.0.0', browser: './extension.js',
    activationEvents: ['onCommand:removalTest.' + name],
    contributes: {
      commands: [{ command: 'removalTest.' + name, title }],
      configuration: { properties: { [setting]: { type: 'string', default: 'on' } } },
    },
  }, path => resolveExtensionPath(origin, path));
  return { manifest: manifest!, identifier: ExtensionIdentifier.fromManifest(manifest!), isBuiltin: false, location: origin };
}

const registered = (setting: string) => configurationRegistry.getConfigurationProperties().has(setting);
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

let service: ExtensionService | undefined;
const disposables: { dispose(): void }[] = [];
afterEach(() => {
  service?.dispose();
  service = undefined;
  disposables.splice(0).forEach(disposable => disposable.dispose());
  fakes.hosts.length = 0;
  fakes.log.length = 0;
  vi.restoreAllMocks();
});

function start(...extensions: IExtensionDescription[]) {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  const instantiation = new InstantiationService(new ServiceCollection(
    [IWorkbenchLayoutService, { mainContainer: document.createElement('div') } as unknown as IWorkbenchLayoutService],
    [IConfigurationService, { getValue: () => 'en' } as unknown as IConfigurationService],
    [IWorkspaceContextService, { getWorkspace: () => ({ id: 'test', folders: [] }) } as unknown as IWorkspaceContextService],
  ));
  service = new ExtensionService(() => ({ extensions, messages: [] }), instantiation);
  service.initialize();
  const changes = vi.fn();
  disposables.push(service.onDidChangeExtensions(changes));
  disposables.push(configurationRegistry.onDidUpdateConfiguration(() => fakes.log.push('main:settings changed')));
  return { service, changes };
}

/** Starts the host by running the extension's command, and reports it active. */
async function activate(target: ExtensionService, name: string): Promise<{ host: FakeHost; key: string }> {
  await target.activateByEvent('onCommand:removalTest.' + name);
  const host = fakes.hosts.at(-1)!;
  const key = keyOf(host, name);
  host.access!.setStatus(key, { state: 'active' });
  return { host, key };
}

/** The key under which the host last received the extension. */
function keyOf(host: FakeHost, name: string): string {
  const key = [...host.initial, ...host.deltas.flatMap(delta => delta.added)]
    .filter(extension => extension.id === 'test.' + name).at(-1)?.key;
  if (!key) {
    throw new Error('The host does not know test.' + name);
  }
  return key;
}

function whenRemoved(target: ExtensionService, id: string) {
  const state = { done: false };
  void target.whenExtensionRemoved(id).then(() => {
    state.done = true;
    fakes.log.push('main:removed ' + id);
  });
  return state;
}

test('tells the host first and removes the contributions after the host reports the extension inactive', async () => {
  const { service, changes } = start(description('alpha'));
  const { host, key } = await activate(service, 'alpha');
  changes.mockClear();
  fakes.log.length = 0;

  expect(service.removeExtension('test.alpha')).toBe(true);
  const removal = whenRemoved(service, 'test.alpha');
  expect(service.extensions.map(extension => extension.identifier.value)).toEqual([]);
  await settled();
  expect(fakes.log).toEqual(['host:removed ' + key]);
  expect(registered('removalTest.alpha')).toBe(true);
  expect(MenuRegistry.getCommand('removalTest.alpha')?.title).toBe('alpha');
  expect(removal.done).toBe(false);
  expect(changes).not.toHaveBeenCalled();
  expect(service.getExtensionsStatus()['test.alpha']).toBeUndefined();

  host.access!.setStatus(key, { state: 'inactive' });
  expect(registered('removalTest.alpha')).toBe(false);
  expect(MenuRegistry.getCommand('removalTest.alpha')).toBeUndefined();
  expect(changes).toHaveBeenCalledOnce();
  expect(host.removed).toEqual([key]);
  await settled();
  expect(fakes.log).toEqual(['host:removed ' + key, 'main:settings changed', 'main:removed test.alpha']);
  expect(changes).toHaveBeenCalledOnce();
});

test('keeps a removed extension contributing, and not activating, while other changes refresh the contributions', async () => {
  const { service, changes } = start(description('alpha'), description('beta'));
  const { host, key: alpha } = await activate(service, 'alpha');
  const beta = keyOf(host, 'beta');
  changes.mockClear();

  service.removeExtension('test.alpha');
  const alphaRemoval = whenRemoved(service, 'test.alpha');
  await settled();
  // Another install, an extension point and a theme refresh the contributions while the host deactivates alpha.
  expect(service.addExtension(description('gamma'))).toBe(true);
  disposables.push(ExtensionsRegistry.registerExtensionPoint({ name: 'removalTestPoint', validate: (_value): _value is unknown => true,
    accept: () => {} }));
  service.removeExtension('test.beta');
  const betaRemoval = whenRemoved(service, 'test.beta');
  await settled();
  expect(registered('removalTest.alpha')).toBe(true);
  expect(registered('removalTest.beta')).toBe(true);
  expect(registered('removalTest.gamma')).toBe(true);
  expect(host.deltas.flatMap(delta => delta.removed)).toEqual([alpha, beta]);
  expect(host.deltas.at(-1)!.added.map(extension => extension.id)).toEqual(['test.gamma']);

  // The command of a leaving extension does not activate it again.
  host.activations.length = 0;
  await service.activateByEvent('onCommand:removalTest.alpha');
  expect(host.activations).toEqual([]);

  // Beta's end leaves alpha's contributions; each removal changes the extensions once.
  changes.mockClear();
  host.access!.setStatus(beta, { state: 'inactive' });
  expect(registered('removalTest.beta')).toBe(false);
  expect(registered('removalTest.alpha')).toBe(true);
  await settled();
  expect([alphaRemoval.done, betaRemoval.done]).toEqual([false, true]);
  host.access!.setStatus(alpha, { state: 'inactive' });
  expect(registered('removalTest.alpha')).toBe(false);
  expect(registered('removalTest.gamma')).toBe(true);
  await settled();
  expect(alphaRemoval.done).toBe(true);
  expect(changes).toHaveBeenCalledTimes(2);
  expect(host.deltas.flatMap(delta => delta.removed)).toEqual([alpha, beta]);
});

test('removes the contributions at once when no host runs', async () => {
  const { service, changes } = start(description('alpha'));
  changes.mockClear();
  expect(service.removeExtension('test.alpha')).toBe(true);
  expect(registered('removalTest.alpha')).toBe(false);
  expect(changes).toHaveBeenCalledOnce();
  await service.whenExtensionRemoved('test.alpha');
  expect(fakes.hosts).toEqual([]);
});

test.each([
  ['stops responding or crashes', (host: FakeHost) => host.exit(new Error('The extension host is not running.'))],
  ['is disposed with the workbench', () => service!.dispose()],
])('removes the contributions of a leaving extension when the host %s', async (_case, end) => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { service, changes } = start(description('alpha'));
  const { host } = await activate(service, 'alpha');
  service.removeExtension('test.alpha');
  const removal = whenRemoved(service, 'test.alpha');
  await settled();
  changes.mockClear();
  end(host);
  await settled();
  expect(registered('removalTest.alpha')).toBe(false);
  expect(removal.done).toBe(true);
});

test('removes the contributions when the host restarts and leaves the extension out of the new host', async () => {
  const { service } = start(description('alpha'), description('beta'));
  const { host } = await activate(service, 'alpha');
  service.removeExtension('test.alpha');
  const removal = whenRemoved(service, 'test.alpha');
  await settled();
  const restart = service.restartExtensionHost();
  await settled();
  expect(registered('removalTest.alpha')).toBe(true);
  host.graceful.resolve!();
  await restart;
  expect(registered('removalTest.alpha')).toBe(false);
  expect(removal.done).toBe(true);
  await service.activateByEvent('onCommand:removalTest.beta');
  expect(fakes.hosts).toHaveLength(2);
  expect(fakes.hosts[1].initial.map(extension => extension.id)).toEqual(['test.beta']);
});

test('never registers two generations of one extension together', async () => {
  const { service } = start(description('alpha', 'Old', 'removalTest.old'));
  const { host, key } = await activate(service, 'alpha');
  const both: string[] = [];
  disposables.push(configurationRegistry.onDidUpdateConfiguration(() => {
    const generations = ['old', 'new', 'newer'].filter(generation => registered('removalTest.' + generation));
    if (generations.length > 1) {
      both.push(generations.join('+'));
    }
  }));

  // A replacement waits for the removal, as the extension management service does.
  service.removeExtension('test.alpha');
  const replaced = service.whenExtensionRemoved('test.alpha')
    .then(() => service.addExtension(description('alpha', 'New', 'removalTest.new')));
  await settled();
  expect(registered('removalTest.old')).toBe(true);
  host.access!.setStatus(key, { state: 'inactive' });
  expect(await replaced).toBe(true);
  expect(MenuRegistry.getCommand('removalTest.alpha')?.title).toBe('New');
  expect([registered('removalTest.old'), registered('removalTest.new')]).toEqual([false, true]);

  // An install that does not wait drops the leaving generation first; that generation's late end leaves the new one.
  await settled();
  const next = keyOf(host, 'alpha');
  host.access!.setStatus(next, { state: 'active' });
  service.removeExtension('test.alpha');
  await settled();
  expect(service.addExtension(description('alpha', 'Newer', 'removalTest.newer'))).toBe(true);
  expect([registered('removalTest.new'), registered('removalTest.newer')]).toEqual([false, true]);
  await settled();
  const newest = keyOf(host, 'alpha');
  expect(newest).not.toBe(next);
  host.access!.setStatus(next, { state: 'inactive' });
  await service.whenExtensionRemoved('test.alpha');
  expect(MenuRegistry.getCommand('removalTest.alpha')?.title).toBe('Newer');
  expect(registered('removalTest.newer')).toBe(true);

  // Removing the newest generation while the previous one is still leaving waits for the newest one's own end.
  service.removeExtension('test.alpha');
  await settled();
  expect(registered('removalTest.newer')).toBe(true);
  host.access!.setStatus(newest, { state: 'inactive' });
  expect(registered('removalTest.newer')).toBe(false);
  expect(both).toEqual([]);
});

test('ends the removal when removing the contributions fails', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { service } = start(description('alpha'));
  const { host, key } = await activate(service, 'alpha');
  service.removeExtension('test.alpha');
  const removal = whenRemoved(service, 'test.alpha');
  await settled();
  let fail = false;
  disposables.push(ExtensionsRegistry.registerExtensionPoint({ name: 'removalTestFailingPoint',
    validate: (_value): _value is unknown => true, accept: () => {
      if (fail) {
        fail = false;
        throw new Error('expected failure');
      }
    } }));
  fail = true;
  expect(() => host.access!.setStatus(key, { state: 'inactive' })).not.toThrow();
  await settled();
  expect(removal.done).toBe(true);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining('[test.alpha] Could not remove the contributions'),
    expect.any(Error));
});
