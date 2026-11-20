import { describe, expect, it } from 'vitest';
import { CancellationError, isCancellationError } from '../../common/errors.js';

describe('isCancellationError', () => {
  it('recognizes local and foreign cancellation errors', () => {
    expect(isCancellationError(new CancellationError())).toBe(true);
    expect(isCancellationError(Object.assign(new Error('Canceled'), { name: 'Canceled' }))).toBe(true);
  });

  it('requires an Error with both the cancellation name and message', () => {
    for (const reason of [
      Object.assign(new Error('different'), { name: 'Canceled' }),
      new Error('Canceled'),
      { name: 'Canceled', message: 'Canceled' },
      'Canceled',
      undefined,
    ]) {
      expect(isCancellationError(reason)).toBe(false);
    }
  });
});
