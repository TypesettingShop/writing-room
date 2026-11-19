// Runs in the extension host Worker before the host's own modules (see api-probe-worker.js). It replaces the global
// `Function` while those modules evaluate, so the host's CommonJS loader captures a wrapper that compiles the bundle
// with the real `Function` and only swaps the `require('vscode')` result for a recording proxy. The bundle is still
// fetched, limited and evaluated by the host's own loader. api-probe-worker.js restores `Function` afterwards.
//
// Recorded per phase (load, activate, document): API members read, called or constructed, members that are missing
// (the proxy returns `undefined` so the extension fails exactly as it would without the probe), and errors.
// Returned values are not wrapped: identity and structured cloning stay as they are, so members of returned
// instances are not recorded. Their absence shows up as an error instead, with an excerpt of the source around it.
//
// TypeScript's `__importStar` and esbuild's `__toESM` copy the namespace's own keys into a new object, and a member
// missing from that copy would never reach the proxy. The `vscode` proxy therefore also lists, as own keys without a
// descriptor, every name the bundle writes after a dot. The copy then gets a getter that reads through the proxy for
// each of them. `Object.keys` is unchanged; `Object.getOwnPropertyNames` and `in` on such a copy see the extra names.

type Phase = 'load' | 'activate' | 'document';
type Kind = 'access' | 'call' | 'construct' | 'missing' | 'checked-missing';
export type ProbeMessage =
  | { readonly type: 'installed' }
  | { readonly type: 'loaded'; readonly entry: string }
  | { readonly type: 'record'; readonly phase: Phase; readonly kind: Kind; readonly path: string }
  | { readonly type: 'error'; readonly phase: Phase; readonly source: string; readonly message: string; readonly at?: string };

const scope = globalThis as unknown as { location: { href: string }; addEventListener: typeof addEventListener };
const channelName = new URL(scope.location.href).searchParams.get('channel');
const channel = new BroadcastChannel(channelName ?? 'api-probe');
const post = (message: ProbeMessage) => channel.postMessage(message);
let phase: Phase = 'load';
channel.addEventListener('message', ({ data }) => {
  if (data?.type === 'phase' && (data.phase === 'load' || data.phase === 'activate' || data.phase === 'document')) {
    phase = data.phase;
  }
});

const seen = new Set<string>();
function record(kind: Kind, path: string): void {
  const key = phase + '\0' + kind + '\0' + path;
  if (!seen.has(key)) {
    seen.add(key);
    post({ type: 'record', phase, kind, path });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name + ': ' + error.message;
  }
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

const sources = new Map<string, string[]>();

// The first stack frame in a loaded bundle, with the code around that column. Minified bundles are one long line.
function locate(error: unknown): string | undefined {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  for (const [entry, lines] of sources) {
    const match = new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+):(\\d+)').exec(stack);
    // `Function` puts two header lines ("function anonymous(module,exports,require" and ") {") before the body.
    const number = match ? Number(match[1]) - 2 : 0;
    const line = match ? lines[number - 1] : undefined;
    if (match && line !== undefined) {
      const column = Number(match[2]) - 1;
      return `${entry.slice(entry.lastIndexOf('/') + 1)}:${number}:${match[2]} ${line.slice(Math.max(0, column - 80), column + 80).trim()}`;
    }
  }
  return undefined;
}

function reportError(source: string, error: unknown): void {
  const at = locate(error);
  post({ type: 'error', phase, source, message: describe(error), ...at ? { at } : {} });
}

// Keys that bundlers' CommonJS interop and promise checks read without meaning an API member.
const interop = new Set<PropertyKey>(['__esModule', 'default', 'then', 'toJSON']);
const proxies = new WeakMap<object, object>();
const targets = new WeakMap<object, object>();

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const unwrap = (value: unknown) => (value !== null && (typeof value === 'object' || typeof value === 'function')
  ? targets.get(value) ?? value : value);

function wrapMember(value: unknown, path: string): unknown {
  if (typeof value === 'function') {
    return wrap(value, path);
  }
  // Namespaces and enums are plain objects. Instances, arrays and package.json data are passed through untouched.
  if (value !== null && typeof value === 'object' && isPlainObject(value) && !path.endsWith('packageJSON')) {
    return wrap(value, path);
  }
  return value;
}

// The proxy stands on a blank shadow target, so frozen API objects can hand out wrapped members without breaking
// proxy invariants. The shadow of a function is a constructible function, so `new`, `extends` and `instanceof` work.
function wrap(real: object, path: string, candidates: readonly string[] = []): object {
  const cached = proxies.get(real);
  if (cached) {
    return cached;
  }
  const name = (key: PropertyKey) => (path ? path + '.' : '') + String(key);
  const shadow = typeof real === 'function' ? function () { /* shadow */ } : {};
  const proxy: object = new Proxy(shadow, {
    get(_shadow, key) {
      if (typeof key === 'symbol') {
        return Reflect.get(real, key);
      }
      if (typeof real === 'function' && key === 'prototype') {
        return Reflect.get(real, key);
      }
      if (!(key in real)) {
        if (!interop.has(key)) {
          record('missing', name(key));
        }
        return undefined;
      }
      record('access', name(key));
      return wrapMember(Reflect.get(real, key), name(key));
    },
    has(_shadow, key) {
      const present = Reflect.has(real, key);
      if (!present && typeof key === 'string' && !interop.has(key)) {
        record('checked-missing', name(key));
      }
      return present;
    },
    ownKeys(shadowTarget) {
      if (typeof real === 'function') {
        return Reflect.ownKeys(shadowTarget);
      }
      const keys = Reflect.ownKeys(real);
      return [...keys, ...candidates.filter(key => !keys.includes(key))];
    },
    getOwnPropertyDescriptor(shadowTarget, key) {
      if (typeof real === 'function') {
        return Reflect.getOwnPropertyDescriptor(shadowTarget, key);
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(real, key);
      if (!descriptor) {
        return undefined;
      }
      if ('value' in descriptor && typeof key === 'string') {
        record('access', name(key));
        descriptor.value = wrapMember(descriptor.value, name(key));
      }
      return { ...descriptor, configurable: true };
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(real);
    },
    set(_shadow, key, value) {
      return Reflect.set(real, key, value);
    },
    defineProperty(_shadow, key, descriptor) {
      return Reflect.defineProperty(real, key, descriptor);
    },
    deleteProperty(_shadow, key) {
      return Reflect.deleteProperty(real, key);
    },
    apply(_shadow, thisArgument, args) {
      record('call', path);
      return Reflect.apply(real as (...args: unknown[]) => unknown, unwrap(thisArgument), args.map(unwrap));
    },
    construct(_shadow, args, newTarget) {
      record('construct', path);
      return Reflect.construct(real as new (...args: unknown[]) => object, args.map(unwrap), newTarget === proxy ? real as Function : newTarget);
    },
  });
  proxies.set(real, proxy);
  targets.set(proxy, real);
  return proxy;
}

interface ExtensionModule {
  activate?(context: unknown): unknown;
  deactivate?(): unknown;
}

function wrapModule(module: { exports: ExtensionModule | undefined }): void {
  const exports = module.exports;
  if (!exports || typeof exports.activate !== 'function') {
    return;
  }
  const activate = exports.activate.bind(exports);
  const deactivate = typeof exports.deactivate === 'function' ? exports.deactivate.bind(exports) : undefined;
  // A fresh object: bundlers often export through getters or frozen objects that a proxy could not override.
  module.exports = {
    activate(context: unknown) {
      phase = 'activate';
      post({ type: 'record', phase, kind: 'call', path: '(activate)' });
      try {
        const result = activate(context !== null && typeof context === 'object' ? wrap(context, 'context') : context);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          return (result as Promise<unknown>).then(undefined, error => {
            reportError('activate', error);
            throw error;
          });
        }
        return result;
      } catch (error) {
        reportError('activate', error);
        throw error;
      }
    },
    ...deactivate ? { deactivate } : {},
  };
}

const RealFunction = Function;
// Only the host loader's call shape is wrapped: Function('module', 'exports', 'require', source).
const probeFunction = function (...args: string[]) {
  const compiled = RealFunction(...args) as (...args: unknown[]) => unknown;
  if (args.length !== 4 || args[0] !== 'module' || args[1] !== 'exports' || args[2] !== 'require') {
    return compiled;
  }
  const source = args[3];
  const entry = /\/\/# sourceURL=(\S+)\s*$/.exec(source)?.[1] ?? '';
  sources.set(entry, source.split('\n'));
  const candidates = [...new Set(Array.from(source.matchAll(/\.([A-Za-z_$][\w$]*)/g), match => match[1]))];
  return function (this: unknown, module: { exports: ExtensionModule | undefined }, exports: unknown, require: (name: string) => unknown) {
    phase = 'load';
    post({ type: 'loaded', entry });
    const recordingRequire = (id: string) => {
      const value = require(id);
      return id === 'vscode' && value !== null && typeof value === 'object' ? wrap(value, '', candidates) : value;
    };
    try {
      compiled.call(this, module, exports, recordingRequire);
    } catch (error) {
      reportError('load', error);
      throw error;
    }
    wrapModule(module);
  };
} as unknown as FunctionConstructor;
Object.defineProperty(probeFunction, 'prototype', { value: RealFunction.prototype });

// Installed while this module evaluates, before the host modules that api-probe-worker.js imports next.
{
  (globalThis as { Function: FunctionConstructor }).Function = probeFunction;
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      post({ type: 'error', phase, source: 'console.' + level, message: args.map(describe).join(' ') });
      original(...args);
    };
  }
  scope.addEventListener('error', event => reportError('uncaught', (event as ErrorEvent).error ?? (event as ErrorEvent).message));
  scope.addEventListener('unhandledrejection', event => reportError('unhandledrejection', (event as PromiseRejectionEvent).reason));
  post({ type: 'installed' });
}

export function restoreFunction(): void {
  (globalThis as { Function: FunctionConstructor }).Function = RealFunction;
}
