import { describe, expect, it, vi } from 'vitest';
import { DeferredPromise } from '../../../base/common/async.js';
import { installCodeActionStateOrder } from '../../browser/codeActionStateOrder.js';

interface Trigger { type: number }
interface State {
  type: number;
  cancel?(): void;
  actions?: Promise<string>;
}

const empty: State = { type: 0 };

function request(type: number) {
  const result = new DeferredPromise<string>();
  return { type: 1, trigger: { type }, actions: result.p, result, cancel: vi.fn() };
}

const manualRequest = () => request(1);
const automaticRequest = () => request(2);

class Model {
  state = empty;
  readonly notifications: State[] = [];
  readonly consumed: string[] = [];
  readonly refreshed = vi.fn((_trigger: Trigger, _consumed: string[]) => {});

  trigger(trigger: Trigger): void {
    this.refreshed(trigger, [...this.consumed]);
  }

  setState(state: State, skipNotify?: boolean): void {
    if (this.state === state) {
      return;
    }
    this.state.cancel?.();
    this.state = state;
    if (!skipNotify) {
      this.notifications.push(state);
      void state.actions?.then(result => this.consumed.push(result), () => {});
    }
  }
}

installCodeActionStateOrder(Model.prototype);

describe('code action state order', () => {
  it('lets the controller consume the manual result before refreshing the latest automatic request', async () => {
    const model = new Model();
    const manual = manualRequest();
    const first = automaticRequest();
    const latest = automaticRequest();

    model.setState(manual);
    model.setState(first);
    model.setState(manual); // A no-op must keep the pending manual request and its refresh.
    model.setState(latest);
    expect(model.notifications).toEqual([manual]);
    expect(manual.cancel).not.toHaveBeenCalled();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(latest.cancel).toHaveBeenCalledOnce();
    expect(model.refreshed).not.toHaveBeenCalled();

    await manual.result.complete('manual actions');
    await Promise.resolve();
    expect(model.refreshed.mock.calls).toEqual([[latest.trigger, ['manual actions']]]);
    expect(model.refreshed.mock.calls[0]?.[0]).toBe(latest.trigger);
  });

  it.each(['new manual request', 'empty state', 'dispose'])('invalidates the refresh on %s', async transition => {
    const model = new Model();
    const manual = manualRequest();
    const replacement = transition === 'new manual request' ? manualRequest() : empty;
    const dispose = transition === 'dispose';

    model.setState(manual);
    model.setState(automaticRequest());
    model.setState(replacement, dispose);
    expect(manual.cancel).toHaveBeenCalledOnce();
    expect(model.state).toBe(replacement);
    expect(model.notifications).toEqual(dispose ? [manual] : [manual, replacement]);

    if (dispose) {
      const late = automaticRequest();
      model.setState(late);
      expect(model.state).toBe(empty);
      expect(late.cancel).toHaveBeenCalledOnce();
    }
    await manual.result.complete('obsolete');
    await Promise.resolve();
    expect(model.refreshed).not.toHaveBeenCalled();
  });

  it('releases a result that a request arriving after disposal had already computed', async () => {
    const model = new Model();
    model.setState(manualRequest());
    model.setState(empty, true);
    const dispose = vi.fn();
    const late = { type: 1, trigger: { type: 2 }, actions: Promise.resolve({ dispose }), cancel: vi.fn() };

    model.setState(late as unknown as State);
    await Promise.resolve();
    expect(late.cancel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(model.state).toBe(empty);
  });

  it('passes automatic requests through after a manual result settled and over other automatic requests', async () => {
    const model = new Model();
    const manual = manualRequest();
    const first = automaticRequest();
    const second = automaticRequest();

    model.setState(manual);
    await manual.result.complete('manual actions');
    model.setState(first);
    model.setState(second);
    expect(model.notifications).toEqual([manual, first, second]);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
    expect(model.refreshed).not.toHaveBeenCalled();
  });

  it('refreshes after a manual rejection and observes rejections of discarded automatic results', async () => {
    const model = new Model();
    const manual = manualRequest();
    const automatic = automaticRequest();

    model.setState(manual);
    model.setState(automatic);
    await automatic.result.error(new Error('discarded automatic actions'));
    await manual.result.error(new Error('manual actions failed'));
    await Promise.resolve();
    expect(model.refreshed.mock.calls).toEqual([[automatic.trigger, []]]);
  });

  it('keeps pending work local to the editor where it started', () => {
    const first = new Model();
    const second = new Model();
    const manual = manualRequest();
    const automatic = automaticRequest();

    first.setState(manual);
    second.setState(automatic);
    expect(first.notifications).toEqual([manual]);
    expect(second.notifications).toEqual([automatic]);
    expect(automatic.cancel).not.toHaveBeenCalled();
  });

  it('skips unsupported prototypes and installs only once', () => {
    const setter = vi.fn();
    const prototype = { setState: setter };
    const frozen = Object.freeze({ setState: setter, trigger: vi.fn() });
    const wrapped = Model.prototype.setState;

    installCodeActionStateOrder(undefined);
    installCodeActionStateOrder(prototype);
    installCodeActionStateOrder(frozen);
    installCodeActionStateOrder(Model.prototype);
    expect(prototype.setState).toBe(setter);
    expect(frozen.setState).toBe(setter);
    expect(Model.prototype.setState).toBe(wrapped);
  });
});
