// The extension API probe page. It starts the workbench, adds the extension found at `?location=<folder URL>`, starts
// the extension host on api-probe-worker.js instead of the product entry, fires the extension's activation events and
// then opens a first Markdown document. The recorder in the Worker reports which API members the extension read,
// called or missed in each phase; the page writes the collected result as JSON into #result and `window.apiProbe`.
// Not part of the product: it is loaded only by scripts/probe-extension.mjs and test/e2e/api-probe.spec.ts.
import '../../src/workbench/workbench.web.main.js';
import { ExtensionIdentifier } from '../../src/platform/extensions/common/extensions.js';
import type { IExtensionManifest } from '../../src/platform/extensions/common/extensions.js';
import { ICommandService } from '../../src/platform/commands/common/commands.js';
import { Workbench } from '../../src/workbench/browser/workbench.js';
import type { ExtensionService } from '../../src/workbench/services/extensions/browser/extensionService.js';
import { IExtensionService } from '../../src/workbench/services/extensions/common/extensions.js';
import type { ProbeMessage } from './api-probe-recorder.js';

type Phase = 'load' | 'activate' | 'document';
interface PhaseResult {
  accessed: string[];
  called: string[];
  constructed: string[];
  missing: string[];
  checkedMissing: string[];
  errors: { source: string; message: string; at?: string }[];
}
export interface ApiProbeResult {
  id?: string;
  version?: string;
  location: string;
  recorder: { installed: boolean; loads: string[] };
  entry?: { declared: string; declaredWithoutJs: boolean };
  contributes: string[];
  messages: unknown[];
  activationEvents: string[];
  activation?: unknown;
  document?: { opened: boolean; error?: string };
  phases: Record<Phase, PhaseResult>;
  timedOut: Phase[];
  probeError?: string;
}

const params = new URLSearchParams(window.location.search);
const extensionLocation = params.get('location') ?? '';
const quiet = Number(params.get('quiet') ?? 1000);
const phaseTimeout = Number(params.get('phaseTimeout') ?? 20_000);
const channelName = 'api-probe-' + crypto.randomUUID();
const channel = new BroadcastChannel(channelName);

const emptyPhase = (): PhaseResult => ({ accessed: [], called: [], constructed: [], missing: [], checkedMissing: [], errors: [] });
const result: ApiProbeResult = {
  location: extensionLocation, recorder: { installed: false, loads: [] }, contributes: [], messages: [], activationEvents: [],
  phases: { load: emptyPhase(), activate: emptyPhase(), document: emptyPhase() }, timedOut: [],
};
const lists = { access: 'accessed', call: 'called', construct: 'constructed', missing: 'missing', 'checked-missing': 'checkedMissing' } as const;
let lastMessage = performance.now();
channel.addEventListener('message', ({ data }: MessageEvent<ProbeMessage>) => {
  lastMessage = performance.now();
  if (data.type === 'installed') {
    result.recorder.installed = true;
  } else if (data.type === 'loaded') {
    result.recorder.loads.push(data.entry);
  } else if (data.type === 'record') {
    result.phases[data.phase][lists[data.kind]].push(data.path);
  } else if (data.type === 'error') {
    result.phases[data.phase].errors.push({ source: data.source, message: data.message, ...data.at ? { at: data.at } : {} });
  }
});

// The product starts its host as `new Worker(<product entry>, { name: 'writing-room-extension-host' })`.
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(options?.name === 'writing-room-extension-host'
      ? new URL('./api-probe-worker.js?channel=' + encodeURIComponent(channelName), import.meta.url) : url, options);
  }
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const status = document.querySelector('#status')!;

async function run(): Promise<void> {
  if (!/^https?:\/\/[^/]+\/.*\/$/.test(extensionLocation)) {
    throw new Error('?location= must be an http(s) folder URL ending in /');
  }
  const workbench = new Workbench(document.body.appendChild(document.createElement('main')));
  workbench.startup();
  const [extensions, commands] = workbench.instantiationService.invokeFunction(accessor =>
    [accessor.get(IExtensionService) as ExtensionService, accessor.get(ICommandService)] as const);

  const manifest = await (await fetch(new URL('package.json', extensionLocation), { cache: 'no-store' })).json() as IExtensionManifest & {
    contributes?: Record<string, unknown>;
  };
  result.contributes = Object.keys(manifest.contributes ?? {});
  if (manifest.browser) {
    // Upstream ends an entry path without `.js` in `.js` (ensureSuffix); the product's loader does too since wr-efqx.
    // The probe leaves the manifest as it is so a regression shows as a failed activation.
    const declared = new URL(manifest.browser, extensionLocation);
    result.entry = { declared: declared.href, declaredWithoutJs: !declared.pathname.endsWith('.js') };
  }
  const identifier = ExtensionIdentifier.fromManifest(manifest);
  result.id = identifier.value;
  result.version = manifest.version;
  const added = extensions.addExtension({ manifest, identifier, isBuiltin: false, location: extensionLocation });
  const extensionStatus = () => extensions.getExtensionsStatus()[identifier.value];
  if (!added) {
    // A refused extension (engines.vscode, duplicate id) would otherwise look like a clean, inactive run.
    result.messages = [...extensionStatus()?.messages ?? []];
    throw new Error('The extension service did not add the extension; see messages.');
  }
  result.activationEvents = [...extensionStatus()?.activationEvents ?? []];

  async function settle(phase: Phase): Promise<void> {
    const deadline = performance.now() + phaseTimeout;
    while (performance.now() < deadline) {
      await sleep(100);
      if (extensionStatus()?.activation.state !== 'activating' && performance.now() - lastMessage >= quiet) {
        return;
      }
    }
    result.timedOut.push(phase);
  }

  status.textContent = 'activating';
  // One budget for all events: a hanging activation must not cost phaseTimeout once per event, or the page
  // outlives the wait in scripts/probe-extension.mjs.
  const activationDeadline = performance.now() + phaseTimeout;
  for (const event of result.activationEvents) {
    const activation = extensions.activateByEvent(event).catch(error => {
      result.phases.activate.errors.push({ source: 'activateByEvent ' + event, message: String(error) });
    });
    await Promise.race([activation, sleep(Math.max(0, activationDeadline - performance.now()))]);
  }
  await settle('activate');

  status.textContent = 'document';
  channel.postMessage({ type: 'phase', phase: 'document' });
  await sleep(50);
  const opened = commands.executeCommand('workbench.action.files.newUntitledFile', { languageId: 'markdown' })
    .then(() => ({ opened: true }), error => ({ opened: false, error: String(error) }));
  result.document = await Promise.race([opened,
    sleep(phaseTimeout).then(() => ({ opened: false, error: `no document after ${phaseTimeout} ms` }))]);
  await Promise.race([extensions.activateByEvent('onLanguage:markdown').catch(() => {}), sleep(phaseTimeout)]);
  await settle('document');

  const final = extensionStatus();
  result.activation = final?.activation;
  result.messages = [...final?.messages ?? []];
  const attempted = Boolean(manifest.browser) && result.activationEvents.length > 0;
  if (attempted && !result.recorder.installed) {
    result.probeError = 'The extension host did not start on the probe Worker; check how the product names its Worker.';
  } else if (attempted && result.recorder.loads.length === 0 && final?.activation.state === 'active') {
    result.probeError = 'The extension activated without passing through the recorder; check the host loader.';
  }
}

run().catch(error => {
  result.probeError = String(error);
}).finally(() => {
  for (const phase of Object.values(result.phases)) {
    for (const list of [phase.accessed, phase.called, phase.constructed, phase.missing, phase.checkedMissing]) {
      list.sort();
    }
  }
  (window as unknown as { apiProbe: ApiProbeResult }).apiProbe = result;
  document.querySelector('#result')!.textContent = JSON.stringify(result, undefined, 2);
  status.textContent = 'done';
});
