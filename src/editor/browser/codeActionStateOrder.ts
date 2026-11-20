interface CodeActionTrigger {
  readonly type: number;
}

interface CodeActionState {
  readonly type: number;
}

interface TriggeredState extends CodeActionState {
  readonly trigger: CodeActionTrigger;
  readonly actions: Promise<unknown>;
  cancel(): void;
}

interface CodeActionModel {
  setState(state: CodeActionState, skipNotify?: boolean): void;
  trigger(trigger: CodeActionTrigger): void;
}

interface PendingManual {
  refresh?: CodeActionTrigger;
}

interface TrackedState {
  readonly state: CodeActionState;
  readonly disposed: boolean;
  pendingManual?: PendingManual;
}

// Monaco erases CodeActionsState.Type and CodeActionTriggerType in the published JavaScript.
const triggered = 1;
const invoke = 1;
const auto = 2;

const installed = new WeakSet<object>();

function isTriggered(state: CodeActionState): state is TriggeredState {
  const candidate = state as Partial<TriggeredState>;
  return candidate?.type === triggered && typeof candidate.trigger?.type === 'number'
    && typeof candidate.actions?.then === 'function' && typeof candidate.cancel === 'function';
}

/** Cancels a state Monaco's controller never sees; with `release`, also lets go of a result it already has. */
function discard(state: TriggeredState, release = false): void {
  // The controller will not observe a rejected result either.
  void state.actions.then(result => {
    if (release) {
      (result as { dispose?(): void } | null | undefined)?.dispose?.();
    }
  }, () => {});
  state.cancel();
}

/** Lets a pending manual request finish before refreshing automatic code actions. */
export function installCodeActionStateOrder(prototype: unknown): void {
  if (!prototype || typeof prototype !== 'object' || installed.has(prototype)) {
    return;
  }
  const model = prototype as CodeActionModel;
  const setter = Object.getOwnPropertyDescriptor(model, 'setState');
  const trigger = Object.getOwnPropertyDescriptor(model, 'trigger');
  if (!setter?.writable || typeof setter.value !== 'function' || typeof trigger?.value !== 'function') {
    return;
  }
  const setState = setter.value as CodeActionModel['setState'];
  const states = new WeakMap<CodeActionModel, TrackedState>();

  model.setState = function (state, skipNotify) {
    const previous = states.get(this);
    const request = isTriggered(state) ? state : undefined;
    if (previous?.disposed) {
      // Monaco's delayed callbacks can still arrive after disposal. The disposed model keeps no result, so
      // one computed before this cancel would never be released (nor its list in the extension host).
      if (request) {
        discard(request, true);
      }
      return;
    }
    if (previous?.state === state && !skipNotify) {
      return;
    }
    if (!skipNotify && request?.trigger.type === auto && previous?.pendingManual) {
      previous.pendingManual.refresh = request.trigger;
      discard(request);
      return;
    }

    // Monaco uses skipNotify for the empty state it sets on disposal.
    const current: TrackedState = { state, disposed: skipNotify === true };
    states.set(this, current);
    if (!skipNotify && request?.trigger.type === invoke) {
      const pending: PendingManual = {};
      current.pendingManual = pending;
      const finish = () => {
        current.pendingManual = undefined;
        const refresh = pending.refresh;
        if (refresh) {
          // Give Monaco's controller the first chance to consume the manual result. The automatic
          // result computed earlier may already have been disposed when the manual one replaced it.
          queueMicrotask(() => {
            if (states.get(this) === current) {
              this.trigger(refresh);
            }
          });
        }
      };
      void request.actions.then(finish, finish);
    }
    setState.call(this, state, skipNotify);
  };
  installed.add(model);
}
