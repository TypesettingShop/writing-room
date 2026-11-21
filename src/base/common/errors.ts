export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

export function isCancellationError(error: unknown): boolean {
  return error instanceof CancellationError
    || (error instanceof Error && error.name === 'Canceled' && error.message === 'Canceled');
}
