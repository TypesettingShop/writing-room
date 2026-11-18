export class SyncDescriptor<T> {
  constructor(
    readonly ctor: new (...args: any[]) => T,
    readonly staticArguments: readonly unknown[] = [],
  ) {}
}
