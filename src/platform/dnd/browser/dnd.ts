/** Carries a typed payload within the window for the lifetime of a drag. */
export class LocalSelectionTransfer<T> {
  private static readonly instance = new LocalSelectionTransfer<unknown>();
  private data: T[] | undefined;
  private type: object | undefined;

  private constructor() {}

  static getInstance<T>(): LocalSelectionTransfer<T> {
    return LocalSelectionTransfer.instance as LocalSelectionTransfer<T>;
  }

  hasData(type: object): boolean {
    return this.type === type;
  }

  getData(type: object): T[] | undefined {
    return this.hasData(type) ? this.data : undefined;
  }

  setData(data: T[], type: object): void {
    this.data = data;
    this.type = type;
  }

  clearData(type: object): void {
    if (this.hasData(type)) {
      this.data = undefined;
      this.type = undefined;
    }
  }
}
