import { expect, test, vi } from 'vitest';
import { SyncDescriptor } from '../../common/descriptors.js';
import { getSingletonServiceDescriptors, registerSingleton } from '../../common/extensions.js';
import { createDecorator, IInstantiationService } from '../../common/instantiation.js';
import type { ServicesAccessor } from '../../common/instantiation.js';
import { InstantiationService } from '../../common/instantiationService.js';
import { ServiceCollection } from '../../common/serviceCollection.js';

interface IGreeter {
  readonly _serviceBrand: undefined;
  readonly greeting: string;
}

const IGreeter = createDecorator<IGreeter>('test.greeter');

test('creates a descriptor on first use and caches it', () => {
  const construct = vi.fn();
  class Greeter implements IGreeter {
    declare readonly _serviceBrand: undefined;
    constructor(readonly greeting: string) { construct(); }
  }
  const services = new ServiceCollection();
  services.set(IGreeter, new SyncDescriptor(Greeter, ['Hello']));
  const di = new InstantiationService(services);

  expect(construct).not.toHaveBeenCalled();
  const greeter = di.invokeFunction(accessor => accessor.get(IGreeter));
  expect(greeter.greeting).toBe('Hello');
  expect(di.invokeFunction(accessor => accessor.get(IGreeter))).toBe(greeter);
  expect(construct).toHaveBeenCalledTimes(1);
});

test('injects services after static arguments in the original parameter order', () => {
  class Consumer {
    constructor(
      readonly title: string,
      readonly count: number,
      @IGreeter readonly greeter: IGreeter,
      @IInstantiationService readonly di: IInstantiationService,
    ) {}
  }

  const greeter: IGreeter = { _serviceBrand: undefined, greeting: 'Hello' };
  const di = new InstantiationService(new ServiceCollection([IGreeter, greeter]));
  expect(createDecorator<IGreeter>('test.greeter')).toBe(IGreeter);
  expect(di.createInstance(Consumer, 'A', 2)).toMatchObject({ title: 'A', count: 2, greeter, di });
  expect(di.createInstance(new SyncDescriptor(Consumer, ['B']), 3))
    .toMatchObject({ title: 'B', count: 3, greeter, di });
  expect(() => di.createInstance(new SyncDescriptor(Consumer, ['C', 4]), 5))
    .toThrow('Consumer takes 2 static arguments but received 3.');
});

test('keeps service positions for omitted static arguments and rejects a service before a static one', () => {
  class Optional {
    constructor(readonly label: string | undefined, @IGreeter readonly greeter: IGreeter) {}
  }
  class Misplaced {
    constructor(
      @IGreeter readonly greeter: IGreeter,
      readonly title: string,
      @IInstantiationService readonly di: IInstantiationService,
    ) {}
  }

  const greeter: IGreeter = { _serviceBrand: undefined, greeting: 'Hello' };
  const di = new InstantiationService(new ServiceCollection([IGreeter, greeter]));
  expect(di.createInstance(new SyncDescriptor(Optional))).toMatchObject({ label: undefined, greeter });
  expect(() => di.createInstance(new SyncDescriptor(Misplaced)))
    .toThrow('Misplaced must take all static arguments before its injected services.');
});

test('a subclass without decorators of its own receives its base class services', () => {
  class Base {
    constructor(readonly name: string, @IGreeter readonly greeter: IGreeter) {}
  }
  class Derived extends Base {}

  const greeter: IGreeter = { _serviceBrand: undefined, greeting: 'Hello' };
  const di = new InstantiationService(new ServiceCollection([IGreeter, greeter]));
  expect(di.createInstance(Derived, 'derived')).toMatchObject({ name: 'derived', greeter });
});

test('only allows access during an invocation, even when it throws', () => {
  const di = new InstantiationService();
  let escaped: ServicesAccessor | undefined;
  expect(di.invokeFunction((accessor, label) => {
    escaped = accessor;
    expect(accessor.get(IInstantiationService)).toBe(di);
    return label;
  }, 'result')).toBe('result');
  expect(() => escaped!.get(IInstantiationService)).toThrow(/only during invokeFunction/);

  const failure = new Error('call failed');
  expect(() => di.invokeFunction(accessor => {
    escaped = accessor;
    throw failure;
  })).toThrow(failure);
  expect(() => escaped!.get(IInstantiationService)).toThrow(/only during invokeFunction/);
});

test('detects a cycle, names the services and clears the failed resolution', () => {
  interface IService { readonly _serviceBrand: undefined }
  const IA = createDecorator<IService>('test.cycleA');
  const IB = createDecorator<IService>('test.cycleB');

  class A implements IService {
    declare readonly _serviceBrand: undefined;
    constructor(@IB readonly b: IService) {}
  }
  class B implements IService {
    declare readonly _serviceBrand: undefined;
    constructor(@IA readonly a: IService) {}
  }
  const services = new ServiceCollection([IA, new SyncDescriptor(A)], [IB, new SyncDescriptor(B)]);
  const di = new InstantiationService(services);

  expect(() => di.invokeFunction(accessor => accessor.get(IA)))
    .toThrow('Cyclic service dependency: test.cycleA -> test.cycleB -> test.cycleA');

  services.set(IB, { _serviceBrand: undefined });
  expect(di.invokeFunction(accessor => accessor.get(IA))).toBeInstanceOf(A);
});

test('takes the latest singleton descriptor and respects explicit service instances', () => {
  const id = createDecorator<IGreeter>('test.singleton');
  const constructNull = vi.fn();
  class NullGreeter implements IGreeter {
    declare readonly _serviceBrand: undefined;
    readonly greeting = '';
    constructor() { constructNull(); }
  }
  class RealGreeter implements IGreeter {
    declare readonly _serviceBrand: undefined;
    readonly greeting = 'Hello';
  }
  registerSingleton(id, NullGreeter);
  registerSingleton(id, new SyncDescriptor(RealGreeter));

  expect(getSingletonServiceDescriptors().filter(([key]) => key === id))
    .toEqual([[id, expect.objectContaining({ ctor: RealGreeter })]]);
  expect(new InstantiationService().invokeFunction(accessor => accessor.get(id))).toBeInstanceOf(RealGreeter);
  expect(constructNull).not.toHaveBeenCalled();

  const explicit: IGreeter = { _serviceBrand: undefined, greeting: 'Explicit' };
  const di = new InstantiationService(new ServiceCollection([id, explicit]));
  expect(di.invokeFunction(accessor => accessor.get(id))).toBe(explicit);
});
