import { expect, test, vi } from 'vitest';
import { DeferredPromise, raceCancellation, RunOnceScheduler, Sequencer, Throttler } from '../../common/async.js';
import { CancellationTokenSource } from '../../common/cancellation.js';

test('propagates parent cancellation and does not let an already-cancelled race win later', async () => {
  const parent = new CancellationTokenSource();
  const child = new CancellationTokenSource(parent.token);
  const pending = new DeferredPromise<string>();
  const result = raceCancellation(pending.p, child.token, 'cancelled');
  parent.cancel();
  await expect(result).resolves.toBe('cancelled');
  expect(child.token.isCancellationRequested).toBe(true);
  await pending.error(new Error('late result'));
  await expect(raceCancellation(Promise.resolve('done'), child.token, 'early cancellation')).resolves.toBe('early cancellation');
  child.dispose();
  parent.dispose();
});

test('runs tasks in sequence after rejection and coalesces throttled calls', async () => {
  const sequencer = new Sequencer();
  const rejected = sequencer.queue(() => { throw new Error('failed'); });
  const next = sequencer.queue(() => 'ready');
  await expect(rejected).rejects.toThrow('failed');
  await expect(next).resolves.toBe('ready');

  const throttler = new Throttler();
  const pending = new DeferredPromise<number>();
  const initial = throttler.queue(() => pending.p);
  const skipped = vi.fn(() => 2);
  const queued = throttler.queue(skipped);
  const latest = throttler.queue(() => 3);
  expect(skipped).not.toHaveBeenCalled();
  await pending.complete(1);
  await expect(Promise.all([initial, queued, latest])).resolves.toEqual([1, 3, 3]);
  expect(skipped).not.toHaveBeenCalled();
  throttler.dispose();
});

test('a rescheduled callback runs once and disposal cancels it', () => {
  vi.useFakeTimers();
  try {
    const run = vi.fn();
    const scheduler = new RunOnceScheduler(run, 5);
    scheduler.schedule();
    scheduler.schedule(10);
    vi.advanceTimersByTime(9);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    scheduler.dispose();
    vi.runAllTimers();
    expect(run).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
